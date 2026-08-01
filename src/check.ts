// check: the gates.
//
// Six of them, all evaluated — no short-circuit — because a user fixing one
// failure deserves to see the others in the same run rather than discovering
// them one at a time.
//
// G6 is where the interesting bugs are, and it exists only because the
// inventory is repository-wide. Every one of its sub-checks describes a state
// where each individual site is correct and the repository is not.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Inventory, Site } from './types'
import { runCensus } from './census'
import { slugify } from './extract/markdown'
import { danglingSidecarKeys, type PluralFamily } from './plural'

export interface Exception {
  siteKey: string
  reason: string
  justification: string
  /** Binds the exception to exact bytes, so it can never launder a later edit. */
  contentHash?: string
  pin?: boolean
  evidence?: string[]
  decidedBy?: string
  expires?: string | null
}

export interface Exceptions {
  from?: string
  to?: string
  entries: Exception[]
}

const EXCEPTION_REASONS = new Set([
  'identifier', 'module-specifier', 'enum-member', 'persisted-value', 'api-contract',
  'interop-format', 'url-or-slug', 'style-token', 'aria-vocabulary', 'test-fixture',
  'vendored-legal', 'code-token', 'numeric-or-symbolic', 'already-target-language',
  'source-locale-bundle', 'other-locale-bundle',
  'interpolation', 'explicitly-marked', 'proper-noun', 'escaping-fixture',
  'genuinely-source-language',
  // For G7: a site that looks plural-shaped and genuinely is not.
  'not-a-plural',
])

export interface Finding {
  file?: string
  line?: number
  siteKey?: string
  message: string
  kind?: string
}

export interface Gate {
  id: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8'
  name: string
  ok: boolean
  count: number
  findings: Finding[]
}

export interface CheckReport {
  repo: string
  from: string | null
  to: string
  ok: boolean
  gates: Gate[]
  summary: Record<string, number>
  exitCode: 0 | 1
}

export interface CheckOptions {
  repo: string
  inventory: Inventory
  exceptions?: Exceptions
  /** Report only findings absent from the frozen baseline. */
  baseline?: Set<string>
  confidence?: number
  /**
   * Make a WEAKENED CLAIM a failure.
   *
   * Widens three existing gates and deliberately adds no new id: two gates
   * sharing an id made `fingerprint()` collide across them once already, and
   * baselining one finding silently baselined the other. Every strict finding
   * carries `kind: 'strict'` so a baseline frozen without the flag cannot
   * excuse one by accident.
   */
  strict?: boolean
}

export function check(opts: CheckOptions): CheckReport {
  const { repo, inventory } = opts
  const exceptions = opts.exceptions ?? { entries: [] }
  const excused = new Map(exceptions.entries.map((e) => [e.siteKey, e]))
  const minConfidence = opts.confidence ?? 0.7

  const strict = opts.strict === true
  const gates: Gate[] = [
    gateCensus(repo, inventory, strict),
    gateResidual(inventory, excused),
    gateUnadjudicated(inventory, excused, strict),
    gateSourceLanguage(inventory, excused, minConfidence),
    gateExceptions(inventory, exceptions, strict),
    gateCoherence(inventory, repo),
    gatePluralsClaimed(inventory, excused),
  ]

  if (opts.baseline) {
    for (const gate of gates) {
      gate.findings = gate.findings.filter((f) => !opts.baseline!.has(fingerprint(gate.id, f)))
      gate.count = gate.findings.length
      gate.ok = gate.count === 0
    }
  }

  const ok = gates.every((g) => g.ok)
  return {
    repo,
    from: inventory.sourceLanguage,
    to: inventory.targetLanguage,
    ok,
    gates,
    summary: tally(inventory),
    exitCode: ok ? 0 : 1,
  }
}

export function fingerprint(gate: string, f: Finding): string {
  return `${gate}\0${f.siteKey ?? ''}\0${f.file ?? ''}\0${f.kind ?? ''}\0${f.message}`
}

// --------------------------------------------------------------------------

function gateCensus(repo: string, inv: Inventory, strict: boolean): Gate {
  const census = runCensus(repo)
  const findings: Finding[] = census.unaccounted.map((file) => ({
    file,
    message: 'tracked by git, neither read nor explained',
  }))
  if (census.source !== 'git') {
    findings.push({
      message: 'the denominator came from the filesystem rather than git, so the claim is weaker',
    })
  }
  if (strict) {
    // A file that can be inventoried and not patched, or read without the AST
    // tier. Both are accounted for; both make a weaker claim than the rest.
    for (const entry of inv.census) {
      if (entry.byteAddressable === false) {
        findings.push({
          file: entry.file,
          kind: 'strict',
          message: `read, but not byte-addressable (${entry.reason ?? 'unknown encoding'}) — inventoried and refused by \`apply\``,
        })
      } else if (entry.degraded) {
        findings.push({
          file: entry.file,
          kind: 'strict',
          message: 'read without its full tier, so the verdicts in it are weaker than elsewhere',
        })
      }
    }
  }
  return { id: 'G1', name: 'census-complete', ok: findings.length === 0, count: findings.length, findings }
}

function gateResidual(inv: Inventory, excused: Map<string, Exception>): Gate {
  const findings = inv.sites
    .filter((s) => s.verdict === 'unclassified' && !excused.has(s.siteKey))
    .map((s) => ({
      file: s.file,
      line: s.line,
      siteKey: s.siteKey,
      message: `unclassified: ${JSON.stringify(clip(s.value))} — ${s.whyUnclaimed ?? 'no extractor claimed this span'}`,
    }))
  return { id: 'G2', name: 'no-residual', ok: findings.length === 0, count: findings.length, findings }
}

function gateUnadjudicated(inv: Inventory, excused: Map<string, Exception>, strict = false): Gate {
  const findings: Finding[] = inv.sites
    .filter((s) => s.verdict === 'needs-judgment' && !excused.has(s.siteKey))
    .map((s) => ({
      file: s.file,
      line: s.line,
      siteKey: s.siteKey,
      kind: s.reason ?? 'no-rule',
      message: `${s.reason ?? 'no-rule'}: ${JSON.stringify(clip(s.value))}`,
    }))
  if (strict) {
    // The engine records a confidence on every decision and nothing consumes
    // it. Under `--strict` a low-confidence decision is one somebody should
    // look at, which is what the field was recorded for.
    for (const s of inv.sites) {
      if (excused.has(s.siteKey)) continue
      if (s.verdict !== 'translate' && s.verdict !== 'do-not-translate') continue
      if (s.confidence !== 'low') continue
      findings.push({
        file: s.file,
        line: s.line,
        siteKey: s.siteKey,
        kind: 'strict',
        message: `decided at low confidence (${s.verdict}): ${JSON.stringify(clip(s.value))}`,
      })
    }
  }
  return { id: 'G3', name: 'no-unadjudicated', ok: findings.length === 0, count: findings.length, findings }
}

function gateSourceLanguage(inv: Inventory, excused: Map<string, Exception>, minConfidence: number): Gate {
  const from = inv.sourceLanguage
  const findings: Finding[] = []
  if (from && from !== inv.targetLanguage) {
    for (const site of inv.sites) {
      if (site.verdict !== 'translate') continue
      if (excused.has(site.siteKey)) continue
      if (site.lang.detected !== from) continue
      if (site.lang.confidence < minConfidence) continue
      findings.push({
        file: site.file,
        line: site.line,
        siteKey: site.siteKey,
        message: `still ${from} (${site.lang.confidence}): ${JSON.stringify(clip(site.value))}`,
      })
    }
  }
  return { id: 'G4', name: 'source-language-clear', ok: findings.length === 0, count: findings.length, findings }
}

/**
 * Exceptions have to be kept honest, or the file becomes a place to put things
 * one does not want to think about.
 */
function gateExceptions(inv: Inventory, exceptions: Exceptions, strict = false): Gate {
  const bySiteKey = new Map(inv.sites.map((s) => [s.siteKey, s]))
  const findings: Finding[] = []
  for (const entry of exceptions.entries) {
    const site = bySiteKey.get(entry.siteKey)
    if (!site) {
      findings.push({ siteKey: entry.siteKey, message: 'the site this excuses no longer exists' })
      continue
    }
    if (!EXCEPTION_REASONS.has(entry.reason)) {
      findings.push({ siteKey: entry.siteKey, message: `reason ${JSON.stringify(entry.reason)} is outside the closed vocabulary` })
    }
    if (!entry.justification?.trim()) {
      findings.push({ siteKey: entry.siteKey, message: 'no justification — an exception without a reason is a place to hide' })
    }
    if (strict && !entry.contentHash) {
      // `pin` voids an exception whose text CHANGED. An exception carrying no
      // hash at all can never be voided, which is the loophole: it survives the
      // text being rewritten underneath it.
      findings.push({
        siteKey: entry.siteKey,
        file: site.file,
        line: site.line,
        kind: 'strict',
        message: 'unpinned: with no contentHash this exception survives the text being rewritten',
      })
    }
    if (entry.pin && entry.contentHash && entry.contentHash !== site.contentHash) {
      findings.push({
        siteKey: entry.siteKey,
        file: site.file,
        line: site.line,
        message: 'the pinned text changed since this exception was written, so the exception is void',
      })
    }
  }
  return { id: 'G5', name: 'exceptions-valid', ok: findings.length === 0, count: findings.length, findings }
}

/**
 * The cross-site checks.
 *
 * Each of these describes a repository where every individual site passes and
 * the result is still broken — which is precisely what a per-site tool cannot
 * see.
 */
/**
 * G7 — every plural-shaped site is claimed by some dialect.
 *
 * The semantic twin of this gate is G2, not G6. G6 exists for states where each
 * individual site is correct and the REPOSITORY is not; this is not that. It is
 * "the engine looked, saw something plural-shaped, and could not account for it"
 * — G2's proposition one level up. G2 says no BYTE went unaccounted for; G7 says
 * no plural ARRANGEMENT did.
 *
 * Keeping them apart buys something concrete for anyone reading `check --json`:
 * G6's `plural-incomplete` means "your repository has a rendering bug", and G7
 * means "my engine does not understand your repository". Those are the user's
 * problem and the tool's problem respectively, and merging them is exactly the
 * kind of quiet conflation this codebase is built against.
 *
 * It is also what makes the dialect catalog CHECKABLE rather than merely
 * extensible. `dialects --propose` hands an agent this list; the loop ends when
 * the list is empty.
 */
function gatePluralsClaimed(inv: Inventory, excused: Map<string, Exception>): Gate {
  const findings: Finding[] = []
  for (const suspicion of inv.pluralResidual ?? []) {
    if (excused.has(suspicion.siteKey)) continue
    findings.push({
      file: suspicion.file,
      line: suspicion.line,
      siteKey: suspicion.siteKey,
      kind: 'plural-unclaimed',
      message:
        `looks like a plural (${suspicion.signals.join(', ')}) and no dialect claimed it: ` +
        `${JSON.stringify(clipValue(suspicion.value))}`,
    })
  }
  return {
    id: 'G7',
    name: 'plurals-claimed',
    ok: findings.length === 0,
    count: findings.length,
    findings,
  }
}

function clipValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? flat.slice(0, 59) + '\u2026' : flat
}

function gateCoherence(inv: Inventory, repo: string): Gate {
  const findings: Finding[] = []

  // A locale marker still naming the source language: the build says it is
  // French while its text is English.
  for (const site of inv.sites) {
    if (site.verdict !== 'locale-marker') continue
    const declared = site.value.split(/[-_]/)[0]!.toLowerCase()
    if (declared && declared !== inv.targetLanguage) {
      findings.push({
        file: site.file,
        line: site.line,
        siteKey: site.siteKey,
        kind: 'locale-drift',
        message: `declares ${JSON.stringify(site.value)}, expected ${inv.targetLanguage}`,
      })
    }
  }

  // The same copy at two sites, now in two languages. Translate one, miss the
  // other, and neither site is individually wrong.
  const byDup = new Map<string, Site[]>()
  for (const site of inv.sites) {
    // Locale bundles are in scope on both sides: a string held in the source
    // bundle and in the target bundle is the same copy in two languages, which
    // is exactly what this check is looking for.
    if (
      site.verdict !== 'translate' &&
      site.reason !== 'already-target-language' &&
      site.reason !== 'source-locale-bundle' &&
      site.reason !== 'other-locale-bundle'
    ) {
      continue
    }
    const list = byDup.get(site.dupKey)
    if (list) list.push(site)
    else byDup.set(site.dupKey, [site])
  }
  for (const group of byDup.values()) {
    if (group.length < 2) continue
    const langs = new Set(group.map((s) => s.lang.detected).filter(Boolean))
    if (langs.size > 1) {
      findings.push({
        file: group[0]!.file,
        line: group[0]!.line,
        kind: 'duplicate-divergence',
        message: `the same text is now in ${[...langs].join(' and ')}: ${group
          .map((s) => `${s.file}:${s.line}`)
          .join(', ')}`,
      })
    }
  }

  // A translated heading whose anchor other files still link to.
  const slugs = new Set<string>()
  for (const site of inv.sites) {
    if (site.extractor === 'markdown' && /^h\d/.test(site.siteKey.split('#')[1] ?? '')) {
      slugs.add(slugify(site.value))
    }
  }
  for (const site of inv.sites) {
    if (site.extractor !== 'markdown') continue
    for (const m of site.raw.matchAll(/\]\(#([^)]+)\)/g)) {
      const anchor = m[1]!.toLowerCase()
      if (slugs.size > 0 && !slugs.has(anchor)) {
        findings.push({
          file: site.file,
          line: site.line,
          kind: 'anchor-drift',
          message: `links to #${anchor}, which no heading in the inventory produces`,
        })
      }
    }
  }

  // A translation that lost a placeholder its host still supplies.
  for (const site of inv.sites) {
    if (site.constraints.mustKeepHoles.length === 0) continue
    for (const index of site.constraints.mustKeepHoles) {
      if (!site.value.includes(`{${index}}`)) {
        findings.push({
          file: site.file,
          line: site.line,
          siteKey: site.siteKey,
          kind: 'hole-loss',
          message: `placeholder {${index}} is missing from ${JSON.stringify(clip(site.value))}`,
        })
      }
    }
  }

  // A plural family that does not have the forms its own locale selects.
  //
  // Unlike every other check here, this one does not need a translation to have
  // happened. A Russian bundle carrying only `one` and `other` renders the
  // wrong string for 2, 3 and 4 right now, and an English one carrying `few`
  // has a key nothing will ever select. Both are findings about the repository
  // as it stands, which makes this the most valuable thing an audit run
  // produces.
  for (const family of (inv.plurals ?? []) as PluralFamily[]) {
    if (family.missing.length === 0 && family.extra.length === 0) continue
    const parts: string[] = []
    if (family.missing.length) parts.push(`no ${family.missing.join(' or ')} form`)
    if (family.extra.length) {
      parts.push(`a ${family.extra.join(' and ')} form that ${family.locale ?? 'this locale'} never selects`)
    }
    findings.push({
      file: family.file,
      siteKey: family.anchor,
      kind: 'plural-incomplete',
      message:
        `${family.base} is a plural family in ${family.locale ?? 'an unknown locale'}, which selects ` +
        `${family.ownRequired?.join(', ') ?? '?'} — and it has ${parts.join(', and ')}`,
    })
  }

  // A declaration pointing at a site that no longer exists. Usually the code
  // moved and the annotation did not.
  for (const key of danglingSidecarKeys(join(repo, '.ultrai18n', 'plurals.json'), inv.sites)) {
    findings.push({
      siteKey: key,
      kind: 'plural-dangling',
      message: 'a plural declaration names a site that is not in the inventory',
    })
  }

  // A length budget blown — a store listing that will be rejected, or a button
  // that will overflow.
  for (const site of inv.sites) {
    const max = site.constraints.maxLength
    if (max !== null && site.value.length > max) {
      findings.push({
        file: site.file,
        line: site.line,
        siteKey: site.siteKey,
        kind: 'max-length',
        message: `${site.value.length} characters exceeds the ${max} this surface allows`,
      })
    }
  }

  // The repository's own statement about which language it is written in. The
  // one line whose miss contradicts every other change in the run.
  const from = inv.sourceLanguage
  if (from && from !== inv.targetLanguage) {
    for (const rel of ['CONTRIBUTING.md', 'README.md', 'docs/CONTRIBUTING.md']) {
      const abs = join(repo, rel)
      if (!existsSync(abs)) continue
      const text = readFileSync(abs, 'utf8')
      const policy =
        /\b(commit messages|comments|documentation|everything in this repository|tout(?:e)? (?:le|la)? ?(?:dépôt|projet)|les commentaires|les messages de commit)\b[^.\n]{0,80}\b(français|french|anglais|english|español|spanish|deutsch|german)\b/i
      const m = policy.exec(text)
      if (m && namesLanguage(m[0], from)) {
        findings.push({
          file: rel,
          line: text.slice(0, m.index).split('\n').length,
          kind: 'policy-drift',
          message: `the repository's own language policy still says ${JSON.stringify(m[0].trim())}`,
        })
      }
    }
  }

  return { id: 'G6', name: 'coherence', ok: findings.length === 0, count: findings.length, findings }
}

function namesLanguage(text: string, lang: string): boolean {
  const names: Record<string, RegExp> = {
    fr: /français|french/i,
    en: /anglais|english/i,
    es: /español|spanish|espagnol/i,
    de: /deutsch|german|allemand/i,
  }
  return names[lang]?.test(text) ?? false
}

function tally(inv: Inventory): Record<string, number> {
  const out: Record<string, number> = {}
  for (const site of inv.sites) out[site.verdict] = (out[site.verdict] ?? 0) + 1
  return out
}

function clip(s: string, n = 56): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n - 1) + '…' : flat
}

export function readExceptions(path: string): Exceptions {
  if (!existsSync(path)) return { entries: [] }
  return JSON.parse(readFileSync(path, 'utf8')) as Exceptions
}

export function formatCheck(r: CheckReport): string {
  const lines: string[] = []
  lines.push(`ultrai18n check  ${r.from ?? '?'} → ${r.to}  ${r.repo}`)
  lines.push('')
  for (const gate of r.gates) {
    lines.push(`${gate.id} ${gate.name.padEnd(24)} ${gate.ok ? 'ok' : `FAIL (${gate.count})`}`)
    if (gate.ok) continue
    const shown = gate.findings.slice(0, 12)
    for (const f of shown) {
      const where = f.file ? `${f.file}${f.line ? ':' + f.line : ''}  ` : ''
      lines.push(`   ${where}${f.message}`)
    }
    if (gate.findings.length > shown.length) {
      lines.push(`   … and ${gate.findings.length - shown.length} more`)
    }
  }
  lines.push('')
  lines.push(
    `VERDICT  ${r.ok ? 'pass' : 'fail'} — ` +
      Object.entries(r.summary)
        .sort()
        .map(([k, v]) => `${v} ${k}`)
        .join(', '),
  )
  return lines.join('\n')
}
