// sync: keep locale catalogs in step.
//
// The hard part is STALENESS, and catalogs do not record it. A target value
// tells you what it says, never whether the source has moved since someone
// wrote it. So a sidecar records a hash of each source value at the moment a
// translation was accepted — never a mutation of the user's own files.
//
// The honest consequence: the first run has no baseline. It can report what is
// present and what is missing, and it says plainly that it cannot yet report
// what is stale. No heuristic is offered, because none is sound.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from './identity'
import type { Inventory, Site } from './types'
import { fileLocale } from './scan'

export type DiffClass =
  | 'missing'
  | 'stale'
  | 'orphan'
  | 'untranslated'
  | 'identical-ok'
  | 'arity-mismatch'
  | 'ok'

export interface KeyState {
  srcHash: string
  locales: Record<string, { tgtHash: string; srcHashAtTranslation: string }>
}

export interface CatalogState {
  schemaVersion: 1
  sourceLocale: string
  keys: Record<string, KeyState>
}

export interface SyncFinding {
  key: string
  locale: string
  class: DiffClass
  source: string
  target?: string
  detail?: string
}

export interface SyncReport {
  sourceLocale: string
  locales: string[]
  totals: { keys: number }
  byLocale: Record<string, Record<DiffClass, number>>
  findings: SyncFinding[]
  /** True when no prior state existed, so staleness could not be computed. */
  baselineOnly: boolean
  ok: boolean
}

const HOLE = /\{(\d+)\}|\{\{(\w+)\}\}|%[sd@]|\{(\w+)\}/g

export interface SyncOptions {
  repo: string
  inventory: Inventory
  sourceLocale?: string
  statePath?: string
}

export function sync(opts: SyncOptions): SyncReport {
  const sourceLocale = opts.sourceLocale ?? opts.inventory.targetLanguage
  const state = readState(opts.statePath)
  const baselineOnly = state === null

  // Group every catalog site by (locale, key). The key is the site's pointer,
  // which is stable across locales by construction.
  const byLocale = new Map<string, Map<string, Site>>()
  for (const site of opts.inventory.sites) {
    const locale = fileLocale(site.file)
    if (!locale) continue
    if (site.kind === 'key') continue
    const key = site.siteKey.split('#')[1] ?? site.siteKey
    let map = byLocale.get(locale)
    if (!map) {
      map = new Map()
      byLocale.set(locale, map)
    }
    map.set(key, site)
  }

  const source = byLocale.get(sourceLocale) ?? new Map<string, Site>()
  const targets = [...byLocale.keys()].filter((l) => l !== sourceLocale).sort()

  const findings: SyncFinding[] = []
  const counts: SyncReport['byLocale'] = {}

  for (const locale of targets) {
    const target = byLocale.get(locale)!
    const tally: Record<DiffClass, number> = {
      missing: 0, stale: 0, orphan: 0, untranslated: 0, 'identical-ok': 0, 'arity-mismatch': 0, ok: 0,
    }

    for (const [key, srcSite] of source) {
      const tgtSite = target.get(key)
      if (!tgtSite) {
        tally.missing++
        findings.push({ key, locale, class: 'missing', source: srcSite.value })
        continue
      }

      // A locale that lost a placeholder is a runtime bug already living in the
      // repository, and it is usually the most valuable thing sync reports.
      const srcHoles = holeSet(srcSite.value)
      const tgtHoles = holeSet(tgtSite.value)
      if (!sameSet(srcHoles, tgtHoles)) {
        tally['arity-mismatch']++
        findings.push({
          key,
          locale,
          class: 'arity-mismatch',
          source: srcSite.value,
          target: tgtSite.value,
          detail: `source has ${[...srcHoles].join(', ') || 'none'}; target has ${[...tgtHoles].join(', ') || 'none'}`,
        })
        continue
      }

      const record = state?.keys[key]?.locales[locale]
      if (record && record.srcHashAtTranslation !== sha256(srcSite.value).slice(0, 16)) {
        tally.stale++
        findings.push({
          key,
          locale,
          class: 'stale',
          source: srcSite.value,
          target: tgtSite.value,
          detail: 'the source changed after this was translated — revise rather than retranslate',
        })
        continue
      }

      if (tgtSite.value === srcSite.value && /\p{L}{2,}/u.test(srcSite.value)) {
        // Identical is correct for a cognate or a product name, and suspect
        // otherwise. Reporting all of them as untranslated is how a sync report
        // becomes noise.
        const cognate = tgtSite.reason === 'already-target-language' || tgtSite.lang.detected === null
        if (cognate) {
          tally['identical-ok']++
        } else {
          tally.untranslated++
          findings.push({ key, locale, class: 'untranslated', source: srcSite.value, target: tgtSite.value })
        }
        continue
      }

      tally.ok++
    }

    for (const key of target.keys()) {
      if (source.has(key)) continue
      tally.orphan++
      findings.push({
        key,
        locale,
        class: 'orphan',
        source: '',
        detail: 'absent from the source catalog; it may still be referenced dynamically, so it is reported and never pruned',
      })
    }

    counts[locale] = tally
  }

  const arity = findings.filter((f) => f.class === 'arity-mismatch').length
  return {
    sourceLocale,
    locales: targets,
    totals: { keys: source.size },
    byLocale: counts,
    findings: sortFindings(findings),
    baselineOnly,
    ok: arity === 0,
  }
}

/** Severity order: broken now, then silently wrong, then absent, then dead. */
const ORDER: DiffClass[] = ['arity-mismatch', 'stale', 'missing', 'untranslated', 'orphan', 'identical-ok', 'ok']

function sortFindings(findings: SyncFinding[]): SyncFinding[] {
  return findings.sort(
    (a, b) =>
      ORDER.indexOf(a.class) - ORDER.indexOf(b.class) ||
      (a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0) ||
      (a.key < b.key ? -1 : 1),
  )
}

function holeSet(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(HOLE)) out.add(m[0])
  return out
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

function readState(path?: string): CatalogState | null {
  if (!path || !existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CatalogState
  } catch {
    return null
  }
}

export function buildState(inv: Inventory, sourceLocale: string): CatalogState {
  const keys: Record<string, KeyState> = {}
  for (const site of inv.sites) {
    const locale = fileLocale(site.file)
    if (locale !== sourceLocale) continue
    const key = site.siteKey.split('#')[1] ?? site.siteKey
    keys[key] = { srcHash: sha256(site.value).slice(0, 16), locales: {} }
  }
  return { schemaVersion: 1, sourceLocale, keys }
}

export function formatSync(r: SyncReport): string {
  const lines: string[] = [`ultrai18n sync  source ${r.sourceLocale}  →  ${r.locales.join(', ') || '(no other locale found)'}`, '']
  if (r.baselineOnly) {
    lines.push(
      '  No prior state: this run records the baseline. Presence and placeholder',
      '  arity are checked; staleness cannot be, and no heuristic is offered for it.',
      '',
    )
  }
  for (const [locale, tally] of Object.entries(r.byLocale)) {
    const parts = ORDER.filter((c) => tally[c] > 0).map((c) => `${tally[c]} ${c}`)
    lines.push(`  ${locale}: ${parts.join(', ') || 'nothing to do'}`)
  }
  const arity = r.findings.filter((f) => f.class === 'arity-mismatch')
  if (arity.length) {
    lines.push('')
    lines.push(`ARITY MISMATCH (${arity.length}) — a runtime bug already in the repository`)
    for (const f of arity.slice(0, 10)) {
      lines.push(`  ${f.locale} ${f.key}: ${f.detail}`)
    }
  }
  return lines.join('\n')
}
