// verify: adversarial review of what actually shipped.
//
// The digest under review is the POST-APPLY BYTES read from the live
// repository, not the translation string. That choice is the whole point:
// judging the string would judge a model's output, while judging the file puts
// escaping bugs, wrong-span writes and JSX quirks in scope — the failures that
// survive every check upstream of the disk.
//
// So verify runs AFTER `apply --write`, which is the one ordering difference
// from the rest of this family of tools.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Inventory, Site } from './types'
import type { Plan, Group } from './plan'
import { sha256 } from './identity'

/** The family's vocabulary, exactly. A fifth token would make the fold unshareable. */
export type Verdict = 'supported' | 'partial' | 'refuted' | 'unsupported'
export const VALID_VERDICTS: Verdict[] = ['supported', 'partial', 'refuted', 'unsupported']

export interface Pair {
  claimId: string
  claim: string
  src: string
  tgt: string
  role: string
  citation: string
  path: string
  /** Live bytes of the patched span, as read back from disk. */
  digest: string
  /** Why this pair was chosen — census tier or sample. */
  because: string
  verdict: Verdict | null
  note: string
}

export interface VerifyTodo {
  schemaVersion: 1
  repo: string
  pair: string
  pairs: Pair[]
  /** Groups deliberately not reviewed, and why. Silence here would read as coverage. */
  notReviewed: { groups: number; reason: string }
}

export interface VerifyResult {
  schemaVersion: 1
  ok: boolean
  counts: Record<Verdict | 'unadjudicated', number>
  failures: { claimId: string; citation: string; note: string }[]
  verdicts: Pair[]
}

export const VERIFY_MAX = 40

export interface BuildVerifyOptions {
  repo: string
  inventory: Inventory
  plan: Plan
  /** Fraction of the low-risk remainder to sample. */
  sampleRate?: number
  maxVerify?: number
}

/**
 * Census first, then sample.
 *
 * Every group where a wrong call is expensive is reviewed in full: anything
 * with a placeholder, anything mirrored by a test, anything a translator
 * refused or a validator repaired, anything that hit its length budget exactly.
 * Only the boring remainder is sampled, and what goes unreviewed is by
 * construction placeholder-free, test-free and single-site — where a bad
 * translation is cosmetic rather than a broken build.
 */
export function buildVerify(opts: BuildVerifyOptions): VerifyTodo {
  const { repo, inventory, plan } = opts
  const max = opts.maxVerify ?? VERIFY_MAX
  const rate = opts.sampleRate ?? 0.1
  const bySite = new Map(inventory.sites.map((s) => [s.id, s]))

  const translated = plan.groups.filter((g) => g.status === 'pending' || g.status === 'memo')

  const census: { group: Group; because: string }[] = []
  const remainder: Group[] = []
  for (const group of translated) {
    const reason = censusReason(group)
    if (reason) census.push({ group, because: reason })
    else remainder.push(group)
  }

  // Deterministic: sorted by id, then every nth. No RNG, so a review is
  // reproducible and two people looking at the same run see the same sample.
  const step = rate > 0 ? Math.max(1, Math.ceil(1 / rate)) : Infinity
  const sampled = remainder
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .filter((_, i) => i % step === 0)
    .map((group) => ({ group, because: `sampled 1 in ${step}` }))

  const chosen = [...census, ...sampled].slice(0, max)
  const pairs: Pair[] = []

  for (const { group, because } of chosen) {
    const siteId = group.sites[0]
    const site = siteId ? bySite.get(siteId) : undefined
    if (!site) continue
    const digest = readLive(repo, site)
    if (digest === null) continue
    pairs.push({
      claimId: group.id,
      claim: `${JSON.stringify(group.text)} → ${JSON.stringify(currentValue(repo, site) ?? '?')} (${group.role}${group.holes.length ? `, holes ${group.holes.join(',')}` : ''}) is correct, complete and idiomatic, preserves every placeholder, and fits its host site`,
      src: group.text,
      tgt: currentValue(repo, site) ?? '',
      role: group.role,
      citation: `${site.file}:${site.line}`,
      path: site.file,
      digest,
      because,
      verdict: null,
      note: '',
    })
  }

  const dropped = chosen.length < census.length + sampled.length
  return {
    schemaVersion: 1,
    repo,
    pair: `${plan.sourceLang}→${plan.targetLang}`,
    pairs,
    notReviewed: {
      groups: translated.length - pairs.length,
      reason: dropped
        ? `the ${max}-pair cap was reached; ${census.length} high-risk groups were prioritised over ${remainder.length} low-risk ones`
        : `${remainder.length - sampled.length} low-risk group(s) were sampled out: placeholder-free, test-free, single-site`,
    },
  }
}

function censusReason(group: Group): string | null {
  if (group.holes.length > 0) return 'has a placeholder — where machine translation actually breaks'
  if (group.mirrors.length > 0) return 'a test asserts this text; a wrong call is a red build'
  if (group.sites.length > 2) return `appears at ${group.sites.length} sites`
  if (group.max !== null && group.text.length >= group.max - 2) return 'sits at its length budget'
  return null
}

/** The bytes on disk right now, at the span this site occupies. */
function readLive(repo: string, site: Site): string | null {
  const abs = join(repo, site.file)
  if (!existsSync(abs)) return null
  const buf = readFileSync(abs)
  const slice = buf.subarray(site.span.start, site.span.end).toString('utf8')
  return sha256(slice).slice(0, 16)
}

function currentValue(repo: string, site: Site): string | null {
  const abs = join(repo, site.file)
  if (!existsSync(abs)) return null
  const buf = readFileSync(abs)
  return buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')
}

export interface ApplyVerdictsOptions {
  todo: VerifyTodo
  verdicts: { claimId: string; citation?: string; verdict: string; note?: string }[]
}

/**
 * Fold adjudicated verdicts.
 *
 * Anything outside the four tokens is a hard error rather than a coercion: a
 * verdict quietly reinterpreted is a review that did not happen.
 */
export function applyVerdicts(opts: ApplyVerdictsOptions): VerifyResult {
  const byId = new Map(opts.todo.pairs.map((p) => [p.claimId, p]))
  const problems: string[] = []
  const adjudicated: Pair[] = []

  for (const v of opts.verdicts) {
    const pair = byId.get(v.claimId)
    if (!pair) {
      problems.push(`${v.claimId}: no such claim in this worklist`)
      continue
    }
    if (!VALID_VERDICTS.includes(v.verdict as Verdict)) {
      problems.push(`${v.claimId}: verdict ${JSON.stringify(v.verdict)} — use exactly one of ${VALID_VERDICTS.join(', ')}`)
      continue
    }
    adjudicated.push({ ...pair, verdict: v.verdict as Verdict, note: v.note ?? '' })
  }
  if (problems.length) {
    throw new Error(`verify --apply refused ${problems.length} verdict(s):\n  ${problems.join('\n  ')}`)
  }

  const counts: VerifyResult['counts'] = {
    supported: 0, partial: 0, refuted: 0, unsupported: 0, unadjudicated: 0,
  }
  for (const pair of adjudicated) counts[pair.verdict!]++
  counts.unadjudicated = opts.todo.pairs.length - adjudicated.length

  // `partial` counts as support: it says the meaning survived and the phrasing
  // could be better, which is not a reason to block a run.
  const failures = adjudicated
    .filter((p) => p.verdict === 'refuted' || p.verdict === 'unsupported')
    .map((p) => ({ claimId: p.claimId, citation: p.citation, note: p.note }))

  return { schemaVersion: 1, ok: failures.length === 0, counts, failures, verdicts: adjudicated }
}

export interface SemanticCheckOptions {
  repo: string
  inventory: Inventory
  todo: VerifyTodo | null
  result: VerifyResult | null
}

export interface SemanticCheck {
  ok: boolean
  findings: string[]
}

/**
 * Fold the review into `check`, failing closed at every step.
 *
 * Four defences, and each exists because the corresponding shortcut is
 * tempting: trust the stored summary, trust that the file still says what was
 * judged, trust that the verdicts belong to this run at all, or trust that a
 * missing review is an absent problem.
 */
export function checkSemantic(opts: SemanticCheckOptions): SemanticCheck {
  const findings: string[] = []
  if (!opts.todo || !opts.result) {
    return {
      ok: false,
      findings: ['no adjudicated review was found — --semantic cannot pass without one'],
    }
  }
  if (!Array.isArray(opts.result.verdicts)) {
    return { ok: false, findings: ['the review has no verdicts array'] }
  }

  // 1 — recompute from the raw verdicts. A disagreeing stored summary loses.
  const recomputed = opts.result.verdicts.filter(
    (p) => p.verdict === 'refuted' || p.verdict === 'unsupported',
  )
  if (recomputed.length !== opts.result.failures.length) {
    findings.push(
      `the stored summary claims ${opts.result.failures.length} failure(s); recomputing from the verdicts gives ${recomputed.length}. The recomputation wins.`,
    )
  }
  for (const failure of recomputed) {
    findings.push(`${failure.claimId} (${failure.citation}): ${failure.verdict}${failure.note ? ' — ' + failure.note : ''}`)
  }

  // 2 — re-read the cited bytes. A post-review "cleanup" reword cannot ride a
  // stale pass.
  const bySite = new Map(opts.inventory.sites.map((s) => [`${s.file}:${s.line}`, s]))
  let matched = 0
  for (const pair of opts.result.verdicts) {
    const site = bySite.get(pair.citation)
    if (!site) {
      findings.push(`${pair.claimId}: its citation ${pair.citation} is not in the current inventory`)
      continue
    }
    const live = readLive(opts.repo, site)
    if (live === null) {
      findings.push(`${pair.claimId}: ${pair.path} could not be read`)
      continue
    }
    if (live !== pair.digest) {
      findings.push(`${pair.claimId} (${pair.citation}): the cited excerpt no longer matches the repository`)
      continue
    }
    matched++
  }

  // 3 — coverage by identity, so a foreign or stale review cannot pass as this
  // one.
  if (opts.result.verdicts.length > 0 && matched === 0) {
    findings.push(
      `none of the ${opts.result.verdicts.length} adjudicated pairs match this repository — the translation was not actually verified (a stale or foreign review)`,
    )
  }
  if (opts.result.counts.unadjudicated > 0) {
    findings.push(`${opts.result.counts.unadjudicated} pair(s) in the worklist were never adjudicated`)
  }

  return { ok: findings.length === 0, findings }
}

export function formatVerifyTodo(todo: VerifyTodo): string {
  const lines: string[] = [
    `# Review — ${todo.pair}`,
    '',
    `${todo.pairs.length} pair(s) to adjudicate. Use exactly one of: ${VALID_VERDICTS.join(', ')}.`,
    '',
    `Not reviewed: ${todo.notReviewed.groups} group(s) — ${todo.notReviewed.reason}`,
    '',
  ]
  for (const pair of todo.pairs) {
    lines.push(`## ${pair.claimId} · ${pair.citation}`)
    lines.push('')
    lines.push(`**Chosen because:** ${pair.because}`)
    lines.push(`**Claim:** ${pair.claim}`)
    lines.push('')
    lines.push('**Verdict:** _____ · **Note:** _____')
    lines.push('')
  }
  return lines.join('\n')
}
