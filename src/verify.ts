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
import { join, resolve } from 'node:path'
import type { Inventory, Site } from './types'
import type { Plan, Group } from './plan'
import { sha256 } from './identity'
import { requirePlannedSites } from './live'

/** The family's vocabulary, exactly. A fifth token would make the fold unshareable. */
export type Verdict = 'supported' | 'partial' | 'refuted' | 'unsupported'
export const VALID_VERDICTS: Verdict[] = ['supported', 'partial', 'refuted', 'unsupported']

export interface Pair {
  claimId: string
  /** Structural identity; absent only on legacy worklists. */
  siteId?: string
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
  /** Recorded so check can re-derive the selected work from the source plan. */
  selection?: { sampleRate: number; maxVerify: number }
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
  /** Freshly scanned view, required after edits; never replaces source provenance. */
  live?: Inventory
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
  if (!Number.isFinite(rate) || rate < 0 || rate > 1 || !Number.isSafeInteger(max) || max < 1) {
    throw new Error('verify requires sample-rate between 0 and 1 and a positive integer max-verify')
  }
  const live = opts.live ?? inventory
  requirePlannedSites(live, plan, inventory)
  const bySite = new Map(live.sites.map((s) => [s.id, s]))

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
    .filter((_, i) => rate > 0 && i % step === 0)
    .map((group) => ({ group, because: `sampled 1 in ${step}` }))

  const chosen = [...census, ...sampled].slice(0, max)
  const pairs: Pair[] = []

  for (const { group, because } of chosen) {
    const siteId = group.sites[0]
    const site = siteId ? bySite.get(siteId) : undefined
    if (!site) throw new Error(`${group.id}: selected site is no longer in the repository`)
    const digest = readLive(repo, site)
    if (digest === null) throw new Error(`${site.id}: selected site could not be read from the repository`)
    pairs.push({
      claimId: group.id,
      siteId: site.id,
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
    selection: { sampleRate: rate, maxVerify: max },
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
  if (slice !== site.raw) return null
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
  verdicts: { claimId: string; siteId?: string; citation?: string; verdict: string; note?: string }[]
}

/**
 * Fold adjudicated verdicts.
 *
 * Anything outside the four tokens is a hard error rather than a coercion: a
 * verdict quietly reinterpreted is a review that did not happen.
 */
export function applyVerdicts(opts: ApplyVerdictsOptions): VerifyResult {
  const invalid = worklistProblems(opts.todo)
  if (invalid.length) throw new Error(`verify --apply refused worklist: ${invalid.join('; ')}`)
  if (!Array.isArray(opts.verdicts)) throw new Error('verify --apply requires a verdicts array')
  const byId = new Map(opts.todo.pairs.map((p) => [p.claimId, p]))
  const problems: string[] = []
  const adjudicated: Pair[] = []
  const seen = new Set<string>()

  for (const v of opts.verdicts) {
    if (!isRecord(v) || typeof v.claimId !== 'string') {
      problems.push('malformed verdict row: expected an object with a claimId')
      continue
    }
    const pair = byId.get(v.claimId)
    if (!pair) {
      problems.push(`${v.claimId}: no such claim in this worklist`)
      continue
    }
    if (seen.has(v.claimId)) {
      problems.push(`${v.claimId}: duplicate verdict`)
      continue
    }
    seen.add(v.claimId)
    if ((v.citation !== undefined && v.citation !== pair.citation) ||
        (v.siteId !== undefined && v.siteId !== pair.siteId) ||
        (v.note !== undefined && typeof v.note !== 'string')) {
      problems.push(`${v.claimId}: malformed or foreign worklist identity`)
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

  return { schemaVersion: 1, ok: failures.length === 0 && counts.unadjudicated === 0, counts, failures, verdicts: adjudicated }
}

export interface SemanticCheckOptions {
  repo: string
  inventory: Inventory
  live?: Inventory
  /** Bind the worklist to this run's original plan when available (CLI). */
  plan?: Plan
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
  const problems = worklistProblems(opts.todo)
  if (problems.length) return { ok: false, findings: problems }
  if (opts.result.schemaVersion !== 1) findings.push('malformed verification result schema')
  if (resolve(opts.todo.repo) !== resolve(opts.repo) ||
      opts.todo.pair !== `${opts.inventory.sourceLanguage ?? 'unknown'}→${opts.inventory.targetLanguage}`) {
    findings.push('the worklist belongs to a different repository or language pair')
  }
  if (opts.plan) {
    try {
      const required = buildVerify({
        repo: opts.repo, inventory: opts.inventory, live: opts.live,
        plan: opts.plan, ...opts.todo.selection,
      })
      const handedOut = new Map(opts.todo.pairs.map((pair) => [pair.claimId, pair]))
      if (required.pairs.length !== handedOut.size || required.pairs.some((pair) => {
        const old = handedOut.get(pair.claimId)
        // Lines may move after review; the site and reviewed bytes must not.
        return !old || pair.siteId !== old.siteId || pair.src !== old.src || pair.digest !== old.digest
      })) {
        findings.push('the worklist no longer matches the source plan and current repository; regenerate verify')
      }
    } catch (error) {
      findings.push(`the worklist cannot be refreshed: ${(error as Error).message}`)
    }
  }
  const expected = new Map(opts.todo.pairs.map((pair) => [pair.claimId, pair]))
  const sites = opts.live ?? opts.inventory
  const bySite = new Map(sites.sites.map((site) => [site.id, site]))
  const seen = new Set<string>()
  const covered = new Set<string>()
  let failures = 0
  for (const row of opts.result.verdicts) {
    if (!isPair(row) || !VALID_VERDICTS.includes(row.verdict as Verdict)) {
      findings.push('malformed verdict row: expected a worklist pair with a valid verdict')
      continue
    }
    if (seen.has(row.claimId)) {
      findings.push(`${row.claimId}: duplicate verdict (adjudicated twice)`)
      continue
    }
    seen.add(row.claimId)
    const pair = expected.get(row.claimId)
    if (!pair || !samePair(pair, row)) {
      findings.push(`${row.claimId}: no such pair in this worklist (foreign or stale review)`)
      continue
    }
    covered.add(row.claimId)
    if (row.verdict === 'refuted' || row.verdict === 'unsupported') {
      failures++
      findings.push(`${row.claimId} (${row.citation}): ${row.verdict}${row.note ? ' — ' + row.note : ''}`)
    }
    // Legacy citations can migrate only when the source inventory identifies
    // exactly one site. Never collapse multiple same-line strings in a Map.
    const legacy = pair.siteId ? [] : opts.inventory.sites.filter((site) => `${site.file}:${site.line}` === pair.citation)
    const id = pair.siteId ?? (legacy.length === 1 ? legacy[0]!.id : undefined)
    const site = id ? bySite.get(id) : undefined
    if (!site || site.file !== pair.path) {
      findings.push(`${pair.claimId}: its site is not in the current inventory or its legacy citation is ambiguous; regenerate verify`)
      continue
    }
    if (readLive(opts.repo, site) !== pair.digest) {
      findings.push(`${pair.claimId} (${pair.citation}): the cited excerpt no longer matches the repository`)
    }
  }
  // Summary fields are not evidence. Coverage comes only from unique, bound rows.
  if (!Array.isArray(opts.result.failures) || failures !== opts.result.failures.length) {
    findings.push(`the stored summary disagrees; recomputing from the verdicts gives ${failures} failure(s)`)
  }
  const missing = expected.size - covered.size
  if (missing) findings.push(`${missing} pair(s) in the worklist were never adjudicated`)
  return { ok: findings.length === 0, findings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPair(value: unknown): value is Pair {
  if (!isRecord(value)) return false
  return ['claimId', 'claim', 'src', 'tgt', 'role', 'citation', 'path', 'digest', 'because', 'note']
    .every((key) => typeof value[key] === 'string') &&
    Boolean(value.claimId && value.citation && value.path && value.digest) &&
    (value.siteId === undefined || (typeof value.siteId === 'string' && value.siteId.length > 0))
}

function samePair(a: Pair, b: Pair): boolean {
  return (['claimId', 'siteId', 'claim', 'src', 'tgt', 'role', 'citation', 'path', 'digest', 'because'] as const)
    .every((key) => a[key] === b[key])
}

function worklistProblems(todo: unknown): string[] {
  if (!isRecord(todo) || todo.schemaVersion !== 1 || typeof todo.repo !== 'string' ||
      typeof todo.pair !== 'string' || !Array.isArray(todo.pairs)) {
    return ['malformed verification worklist']
  }
  const findings: string[] = []
  if (todo.selection !== undefined && (!isRecord(todo.selection) ||
      typeof todo.selection.sampleRate !== 'number' || !Number.isFinite(todo.selection.sampleRate) ||
      todo.selection.sampleRate < 0 || todo.selection.sampleRate > 1 ||
      typeof todo.selection.maxVerify !== 'number' || !Number.isSafeInteger(todo.selection.maxVerify) || todo.selection.maxVerify < 1)) {
    findings.push('malformed verification selection options')
  }
  const claims = new Set<string>()
  const sites = new Set<string>()
  for (const pair of todo.pairs) {
    if (!isPair(pair)) {
      findings.push('malformed pair in the verification worklist')
      continue
    }
    if (claims.has(pair.claimId) || (pair.siteId && sites.has(pair.siteId))) {
      findings.push(`${pair.claimId}: duplicate claim or site in the worklist`)
    }
    claims.add(pair.claimId)
    if (pair.siteId) sites.add(pair.siteId)
  }
  return findings
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
