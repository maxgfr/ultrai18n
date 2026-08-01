// Filtered views over the inventory.
//
// The flags this reads — `--verdict`, `--surface`, `--file`, `--dup`, `--value`,
// `--rule`, `--ecosystem` — were parsed and read by nothing for the whole life
// of the project. This is what they were for.
//
// Exit codes carry the distinction that matters: zero matches is a RESULT
// (exit 0, `sites` is a view and `check` is the gate), while a token outside a
// closed vocabulary is a usage error (exit 2). "Your repository has none of
// these" and "you typed something that does not exist" must not look alike.
import { compileGlobs } from './vendor/glob'
import { reconcile, type MatchTier } from './identity'
import type { Inventory, Site } from './types'

export interface SitesFilter {
  verdict?: string
  surface?: string
  file?: string
  rule?: string
  ecosystem?: string
  value?: string
  dup?: boolean
  limit?: number
}

export interface SiteRow {
  id: string
  siteKey: string
  file: string
  line: number
  col: number
  verdict: string
  surface: string
  reason: string | null
  rule: string | null
  hard: boolean
  confidence: string
  lang: { detected: string | null; confidence: number }
  dupKey: string
  flags: string[]
  value: string
}

export interface SitesView {
  filter: SitesFilter
  total: number
  matched: number
  truncated: boolean
  sites: SiteRow[]
  /** Only under `--dup`: texts appearing at more than one matched site. */
  groups?: { dupKey: string; text: string; sites: SiteRow[] }[]
}

const VERDICTS = new Set(['translate', 'do-not-translate', 'locale-marker', 'needs-judgment', 'unclassified'])

export class UnknownTokenError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'UnknownTokenError'
  }
}

export function selectSites(inv: Inventory, f: SitesFilter): SitesView {
  if (f.verdict && !VERDICTS.has(f.verdict)) {
    throw new UnknownTokenError(
      `--verdict ${JSON.stringify(f.verdict)} is not a verdict. One of: ${[...VERDICTS].join(', ')}`,
    )
  }

  const fileGlob = f.file ? compileGlobs([f.file]) : null
  const surfaceGlob = f.surface ? compileGlobs([f.surface]) : null
  // `--ecosystem npm` is sugar for `--rule npm.*`: a catalog rule id is
  // namespaced by ecosystem before its first dot, so one code path serves both.
  const rulePattern = f.rule ?? (f.ecosystem ? `${f.ecosystem}.*` : undefined)
  const ruleGlob = rulePattern ? compileGlobs([rulePattern]) : null

  const matched = inv.sites.filter((s) => {
    if (f.verdict && s.verdict !== f.verdict) return false
    if (fileGlob && !fileGlob(s.file)) return false
    if (surfaceGlob && !surfaceGlob(s.surface)) return false
    if (ruleGlob && !(s.rule && ruleGlob(s.rule))) return false
    if (f.value && !s.value.toLowerCase().includes(f.value.toLowerCase())) return false
    return true
  })

  if (rulePattern && matched.length === 0) {
    const known = new Set(inv.sites.map((s) => s.rule).filter((r): r is string => r !== null))
    const anyMatch = [...known].some((r) => compileGlobs([rulePattern])!(r))
    if (!anyMatch && !known.size) {
      // No rule decided anything anywhere: that is a repository fact, not a typo.
    } else if (!anyMatch) {
      throw new UnknownTokenError(
        `no rule matches ${JSON.stringify(rulePattern)}. Rules that decided something here: ` +
          [...known].sort().slice(0, 8).join(', '),
      )
    }
  }

  const limit = f.limit ?? 50
  const rows = matched.map(rowOf)

  const view: SitesView = {
    filter: f,
    total: inv.sites.length,
    matched: matched.length,
    truncated: rows.length > limit,
    sites: rows.slice(0, limit),
  }

  if (f.dup) {
    const byDup = new Map<string, SiteRow[]>()
    for (const row of rows) {
      const list = byDup.get(row.dupKey)
      if (list) list.push(row)
      else byDup.set(row.dupKey, [row])
    }
    view.groups = [...byDup.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([dupKey, list]) => ({ dupKey, text: list[0]!.value, sites: list }))
      .sort((a, b) => b.sites.length - a.sites.length)
      .slice(0, limit)
  }

  return view
}

function rowOf(s: Site): SiteRow {
  return {
    id: s.id,
    siteKey: s.siteKey,
    file: s.file,
    line: s.line,
    col: s.col,
    verdict: s.verdict,
    surface: s.surface,
    reason: s.reason,
    rule: s.rule,
    hard: s.hard,
    confidence: s.confidence,
    lang: { detected: s.lang.detected, confidence: s.lang.confidence },
    dupKey: s.dupKey,
    flags: s.flags,
    value: s.value,
  }
}

export function formatSites(v: SitesView): string {
  const active = Object.entries(v.filter)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([k, value]) => `${k}=${value}`)
    .join(' ')
  const lines = [
    `ultrai18n sites  ${v.total} site(s), ${v.matched} matched${active ? `   [${active}]` : ''}`,
    '',
  ]

  if (v.groups) {
    for (const g of v.groups) {
      lines.push(`  ${g.sites.length}×  ${clip(g.text)}`)
      for (const s of g.sites) lines.push(`        ${s.file}:${s.line}  ${s.verdict}`)
    }
    if (v.groups.length === 0) lines.push('  no text appears at more than one matched site')
  } else {
    for (const s of v.sites) {
      lines.push(
        `  ${s.file}:${s.line}:${s.col}  ${s.surface}  ${s.verdict}${s.reason ? `/${s.reason}` : ''}  ${clip(s.value)}`,
      )
      const detail = [
        `rule: ${s.rule ?? '—'}`,
        `lang: ${s.lang.detected ?? '—'} (${s.lang.confidence})`,
        `confidence: ${s.confidence}`,
        ...(s.flags.length ? [`flags: ${s.flags.join(',')}`] : []),
      ]
      lines.push(`      ${detail.join('   ')}`)
    }
    if (v.truncated) lines.push(`  … and ${v.matched - v.sites.length} more (raise --limit)`)
  }

  lines.push('', `VERDICT  ${v.matched} of ${v.total} site(s) matched`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// drift

export interface DriftView {
  tiers: Record<MatchTier, number>
  moved: { tier: MatchTier; from: string; to: string; file: string }[]
  removed: string[]
  added: string[]
}

/**
 * Reconcile this inventory against a previous one.
 *
 * `reconcile()` has been in `identity.ts`, tested, and CALLED BY NOTHING. That
 * matters beyond tidiness: an exception is pinned to a `siteKey`, so a site
 * whose anchor moved stops being excused, and the only report anybody got was
 * "the site this excuses no longer exists" — which reads like "delete this
 * line" when the truth is "it moved three lines up".
 */
export function driftAgainst(previous: Inventory, current: Inventory): DriftView {
  const matches = reconcile(
    previous.sites.map(identityOf),
    current.sites.map(identityOf),
  )
  const tiers: Record<MatchTier, number> = { same: 0, moved: 0, renumbered: 0, added: 0, removed: 0 }
  const moved: DriftView['moved'] = []
  const removed: string[] = []
  const added: string[] = []

  for (const m of matches) {
    tiers[m.tier]++
    if ((m.tier === 'moved' || m.tier === 'renumbered') && m.previous && m.current) {
      moved.push({ tier: m.tier, from: m.previous.siteKey, to: m.current.siteKey, file: m.current.file })
    }
    if (m.tier === 'removed' && m.previous) removed.push(m.previous.siteKey)
    if (m.tier === 'added' && m.current) added.push(m.current.siteKey)
  }

  return { tiers, moved, removed, added }
}

function identityOf(s: Site) {
  return { siteKey: s.siteKey, file: s.file, surface: s.surface, contentHash: s.contentHash, dupKey: s.dupKey }
}

export function formatDrift(d: DriftView): string {
  const lines = [
    'ultrai18n sites --drift',
    '',
    `  ${d.tiers.same} same · ${d.tiers.moved} moved · ${d.tiers.renumbered} renumbered · ` +
      `${d.tiers.added} added · ${d.tiers.removed} removed`,
  ]
  if (d.moved.length) {
    lines.push('')
    lines.push(`MOVED (${d.moved.length}) — an exception pinned to one of these has stopped applying`)
    for (const m of d.moved.slice(0, 20)) {
      lines.push(`  ${m.tier.padEnd(11)} ${m.from}`)
      lines.push(`  ${''.padEnd(11)} → ${m.to}`)
    }
  }
  lines.push(
    '',
    d.moved.length
      ? `VERDICT  ${d.moved.length} anchor(s) moved — re-check any exception pinned to them`
      : 'VERDICT  ok — no anchor moved',
  )
  return lines.join('\n')
}

function clip(s: string, n = 60): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > n ? flat.slice(0, n - 1) + '…' : flat)
}
