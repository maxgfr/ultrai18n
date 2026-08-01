// Every form in one value, categorised by Fluent's grammar.
//
// The sibling of `primitives/icu.ts`, and the second — and last — place this
// design pays for a real parser. `plural/fluent.ts` is that parser; this file
// only adapts it to the dialect interface.
//
// Three decisions here are grammar knowledge rather than configuration, which
// is precisely why a data row could not have expressed them:
//
//   1. A numeric variant key is an EXACT MATCH, not a position. `[0]` beside
//      `*[other]` means "when the count is zero", and a positional table would
//      read it as the first of two forms and invent a category nobody wrote.
//   2. A selector that is a message or term reference is a `select`, not a
//      plural — the same refusal `detectIcu` makes for `select` arguments.
//   3. Two CLDR-category variants are required. `{ $gender -> [male] … *[other] }`
//      yields exactly one, and one is not a plural family.
import type { Site } from '../../types'
import { isCategory } from '../cldr'
import type { GrammarRead, PluralDialect } from '../dialect/types'
import { looksLikeFluentSelect, scanFluentPattern } from '../fluent'
import type { DetectedFamily, PluralForm } from '../shapes'
import { pathOf, type DetectContext } from './shared'

export function detectFluent(
  sites: Site[],
  dialect: PluralDialect & { read: GrammarRead },
  ctx: DetectContext,
): DetectedFamily[] {
  const out: DetectedFamily[] = []
  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!ctx.applies(dialect, site)) continue
    if (!looksLikeFluentSelect(site.value)) continue
    const scan = scanFluentPattern(site.value)
    if (!scan.ok) continue

    for (const select of scan.selects) {
      // A term or message reference selects on a string the author chose.
      if (select.selectorKind === 'reference') continue

      const forms: PluralForm[] = []
      const exact: { selector: string; value: string }[] = []
      for (const variant of select.variants) {
        if (variant.kind === 'number') {
          exact.push({ selector: variant.selector, value: variant.body })
          continue
        }
        if (!isCategory(variant.key)) continue
        forms.push({
          category: variant.key,
          selector: variant.selector,
          siteId: site.id,
          value: variant.body,
          branch: { start: variant.start, end: variant.end },
        })
      }
      // One category is a select on an enumerated value, not a plural.
      if (forms.length < 2) continue

      out.push({
        shape: dialect.shape,
        dialect: dialect.id,
        primitive: 'fluent',
        cldr: dialect.cldr,
        write: dialect.write,
        file: site.file,
        // A nested select needs its offset in the base, or two plurals in one
        // pattern would collide on the same anchor.
        base: `${pathOf(site)}${select.depth > 0 ? `@${select.start}` : ''}`,
        forms,
        exact,
        sites: [site.id],
        // Fluent has no ordinal selector at all, so this is never true — stated
        // by the row's `ordinals: false` rather than assumed here.
        ordinal: false,
        fluent: { siteId: site.id, select },
      })
    }
  }
  return out
}
