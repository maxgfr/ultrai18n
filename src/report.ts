import type { Inventory, Site, Verdict } from './types'
import { PLURAL_SHAPES, pluralTier, type PluralFamily } from './plural'

const ORDER: Verdict[] = ['translate', 'needs-judgment', 'unclassified', 'locale-marker', 'do-not-translate']

export function formatScan(inv: Inventory, opts: { limit?: number } = {}): string {
  const limit = opts.limit ?? 20
  const lines: string[] = []
  const counts = tally(inv.sites)

  lines.push(
    `ultrai18n scan  ${inv.repo}  ${inv.sourceLanguage ?? 'unknown'} → ${inv.targetLanguage}`,
  )
  lines.push('')
  lines.push(`  ${inv.sites.length} sites across ${new Set(inv.sites.map((s) => s.file)).size} files`)
  for (const verdict of ORDER) {
    const n = counts.get(verdict) ?? 0
    if (n === 0) continue
    lines.push(`    ${String(n).padStart(5)}  ${verdict}`)
  }

  const translate = inv.sites.filter((s) => s.verdict === 'translate')
  if (translate.length) {
    lines.push('')
    lines.push(`TO TRANSLATE (${translate.length}${translate.length > limit ? `, showing ${limit}` : ''})`)
    for (const s of translate.slice(0, limit)) {
      lines.push(
        `  ${s.file}:${s.line}:${s.col}  ${s.surface}  ${s.lang.detected ?? '?'}  ${clip(s.value)}` +
          (s.rule ? `\n      rule: ${s.rule}` : ''),
      )
    }
  }

  const judgment = inv.sites.filter((s) => s.verdict === 'needs-judgment')
  if (judgment.length) {
    const byReason = new Map<string, number>()
    for (const s of judgment) byReason.set(s.reason ?? '?', (byReason.get(s.reason ?? '?') ?? 0) + 1)
    lines.push('')
    lines.push(`NEEDS JUDGMENT (${judgment.length}) — the engine declined rather than guessed`)
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${String(n).padStart(5)}  ${reason}`)
    }
    // A dual-use string is the one case where a wrong guess destroys stored
    // user data, so it is always named rather than counted.
    for (const s of judgment.filter((s) => s.reason === 'dual-use')) {
      lines.push(
        `  ! ${s.file}:${s.line}  ${clip(s.value)} — also a persisted value at ${s.evidence.enumOrigins.join(', ')}`,
      )
    }
  }

  if (inv.advisories.length) {
    lines.push('')
    lines.push('ADVISORIES')
    for (const a of inv.advisories) lines.push(`  [${a.id}] ${a.message}`)
  }

  const unscannable = inv.census.filter((c) => c.mustVerifyManually)
  if (unscannable.length) {
    lines.push('')
    lines.push(`UNSCANNABLE — a person can read text in these; the engine cannot (${unscannable.length})`)
    for (const c of unscannable) lines.push(`  ${c.file}`)
  }

  const noExtractor = inv.census.filter((c) => c.reason?.startsWith('no extractor'))
  if (noExtractor.length) {
    lines.push('')
    lines.push(`NO EXTRACTOR YET (${noExtractor.length}) — listed, not counted as clean`)
    const byExt = new Map<string, number>()
    for (const c of noExtractor) {
      const ext = c.file.slice(c.file.lastIndexOf('.')) || '(none)'
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
    }
    for (const [ext, n] of [...byExt].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ${String(n).padStart(5)}  ${ext}`)
    }
  }

  return lines.join('\n')
}

/**
 * The plural report.
 *
 * Ordered by whether the family is BROKEN, not by where it lives. A catalog
 * missing a form its own locale selects is rendering the wrong string right
 * now, and it should not be somewhere on page two under an alphabetical sort.
 */
export function formatPlurals(inv: Inventory): string {
  const families = (inv.plurals ?? []) as PluralFamily[]
  const lines: string[] = [
    `ultrai18n plurals  ${inv.repo}  → ${inv.targetLanguage}`,
    '',
  ]

  if (families.length === 0) {
    lines.push('  No plural families found.')
    lines.push('')
    lines.push('  The engine reads five arrangements, listed by `plurals --shapes`. If this')
    lines.push('  repository pluralises some other way, declare a family in place with an')
    lines.push('  `ultrai18n:plural` comment rather than teaching the engine to guess.')
    return lines.join('\n')
  }

  const tier = pluralTier()
  if (tier.tier !== 'icu') lines.push(`  ! ${tier.reason}`, '')

  const broken = families.filter((f) => f.missing.length || f.extra.length)
  lines.push(`  ${families.length} family(ies), ${broken.length} not complete for their own locale`)

  if (broken.length) {
    lines.push('')
    lines.push(`INCOMPLETE (${broken.length}) — the wrong string renders for some numbers, today`)
    for (const f of broken) {
      lines.push(`  ${f.file}#${f.base}  [${f.shape}]  ${f.locale ?? '?'}`)
      lines.push(
        `      has ${f.sourceCategories.join(', ')} · ${f.locale ?? 'this locale'} selects ` +
          `${f.ownRequired?.join(', ') ?? '?'}` +
          (f.missing.length ? ` · missing ${f.missing.join(', ')}` : '') +
          (f.extra.length ? ` · never selected: ${f.extra.join(', ')}` : ''),
      )
    }
  }

  lines.push('')
  lines.push(`ALL FAMILIES (${families.length})`)
  for (const f of families) {
    lines.push(
      `  ${f.file}#${f.base}\n` +
        `      ${f.shape} · ${f.locale ?? '?'} → ${f.targetRequired?.join(', ') ?? '?'} · writes by ${f.writeMode}` +
        (f.ordinal ? ' · ordinal' : '') +
        (f.declaredBy === 'annotation' ? ' · declared by annotation' : '') +
        (f.blocked ? `\n      blocked: ${f.blocked}` : ''),
    )
  }

  lines.push('')
  lines.push('SHAPES READ')
  for (const shape of PLURAL_SHAPES) {
    lines.push(`  ${shape.id.padEnd(16)} ${shape.title}\n      ${shape.docs}`)
  }
  return lines.join('\n')
}

function tally(sites: Site[]): Map<Verdict, number> {
  const counts = new Map<Verdict, number>()
  for (const s of sites) counts.set(s.verdict, (counts.get(s.verdict) ?? 0) + 1)
  return counts
}

function clip(s: string, n = 64): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? JSON.stringify(flat.slice(0, n - 1) + '…') : JSON.stringify(flat)
}
