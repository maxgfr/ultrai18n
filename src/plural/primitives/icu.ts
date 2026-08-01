// Every form in one value, categorised by a real parser.
//
// This is the one primitive that CANNOT be data, and saying so plainly is the
// honest boundary of the whole dialect design: an ICU message is a grammar with
// nesting, quoting and exact-match branches, and no table of separators reads
// it. `src/plural/icu.ts` is that parser, unchanged — this file only adapts it
// to the dialect interface.
//
// A Fluent dialect would need a second module beside it, for the same reason.
// That is the price of a genuinely new grammar, and it is the only place the
// design charges one.
import type { Site } from '../../types'
import type { GrammarRead, PluralDialect } from '../dialect/types'
import { looksLikeIcu, scanIcu } from '../icu'
import type { DetectedFamily, PluralForm } from '../shapes'
import { pathOf, type DetectContext } from './shared'

export function detectIcu(
  sites: Site[],
  dialect: PluralDialect & { read: GrammarRead },
  ctx: DetectContext,
): DetectedFamily[] {
  const out: DetectedFamily[] = []
  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!ctx.applies(dialect, site)) continue
    if (!looksLikeIcu(site.value)) continue
    const scan = scanIcu(site.value)
    if (!scan.ok) continue

    for (const argument of scan.arguments) {
      // A `select` chooses on a string, not a count. Reading it as a plural
      // would invent categories out of whatever cases the author wrote.
      if (argument.type === 'select') continue

      const forms: PluralForm[] = []
      const exact: { selector: string; value: string }[] = []
      for (const branch of argument.branches) {
        // `=0` is an exact match, not a category. Carried through untouched so
        // rebuilding the message cannot drop it.
        if (branch.selector.startsWith('=')) {
          exact.push({ selector: branch.selector, value: branch.body })
          continue
        }
        if (!branch.category) continue
        forms.push({
          category: branch.category,
          selector: branch.selector,
          siteId: site.id,
          value: branch.body,
          branch: { start: branch.start, end: branch.end },
        })
      }
      if (forms.length === 0) continue

      out.push({
        shape: dialect.shape,
        dialect: dialect.id,
        primitive: 'icu',
        cldr: dialect.cldr,
        write: dialect.write,
        file: site.file,
        // A nested argument needs its offset in the base, or two plurals in one
        // message would collide on the same anchor.
        base: `${pathOf(site)}${argument.depth > 0 ? `@${argument.start}` : ''}`,
        forms,
        exact,
        sites: [site.id],
        ordinal: (dialect.read.ordinals !== false) && argument.type === 'selectordinal',
        icu: { siteId: site.id, argument },
      })
    }
  }
  return out
}

export function validateGrammar(read: unknown): string[] {
  const r = read as Partial<GrammarRead>
  if (!r || typeof r !== 'object') return ['read must be an object']
  if (r.primitive === 'fluent') {
    return ['the fluent grammar has no reader yet — a dialect cannot declare one into existence']
  }
  if (r.primitive !== 'icu') return [`unknown grammar ${String(r.primitive)}`]
  return []
}
