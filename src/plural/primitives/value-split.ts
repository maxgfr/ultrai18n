// Every form in one value, separated by a literal, categorised by POSITION.
//
// vue-i18n's pipes and Polyglot's `||||` are the same arrangement with a
// different delimiter and a different arity table, which is exactly the kind of
// difference that should cost a data row rather than a function.
//
// Positional is not CLDR. `zero|one|other` here means "the first part, the
// second part, the third part", and a dialect using this primitive says so with
// `cldr: false` — otherwise the engine would report a Russian `few` as missing
// from a string whose runtime has no notion of `few` at all.
import type { Site } from '../../types'
import { isCategory } from '../cldr'
import type { Category } from '../cldr'
import type { PluralDialect, ValueSplitRead } from '../dialect/types'
import type { DetectedFamily, PluralForm } from '../shapes'
import { pathOf, type DetectContext } from './shared'

/** The guard that keeps `"Save | Cancel"` out: a plural has to count something. */
const COUNTS = /\d|\{[^}]*\}|%[sd@]|%\{/

export function detectValueSplit(
  sites: Site[],
  dialect: PluralDialect & { read: ValueSplitRead },
  ctx: DetectContext,
): DetectedFamily[] {
  const read = dialect.read
  const trim = read.trim !== false
  // Longest first, or `||||` is read as four empty vue-i18n parts.
  const delimiters = [...read.delimiters].sort((a, b) => b.length - a.length)

  const out: DetectedFamily[] = []
  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!ctx.applies(dialect, site)) continue

    const delimiter = delimiters.find((d) => site.value.includes(d))
    if (!delimiter) continue

    const parts = site.value.split(delimiter).map((p) => (trim ? p.trim() : p))
    if (parts.some((p) => !/\p{L}{2,}/u.test(p))) continue
    if (read.requiresCounting !== false && !parts.some((p) => COUNTS.test(p))) continue

    // Each part names its own category, so its POSITION carries no information.
    const forms = read.partSelector
      ? bySelector(parts, read.partSelector, site.id)
      : byPosition(parts, read.order?.[parts.length], site.id)
    if (!forms) continue

    out.push({
      shape: dialect.shape,
      dialect: dialect.id,
      primitive: 'value-split',
      cldr: dialect.cldr,
      write: dialect.write,
      file: site.file,
      base: pathOf(site),
      forms,
      exact: [],
      sites: [site.id],
      ordinal: false,
      delimiter,
    })
  }
  return out
}

/** Categories from the parts' positions — vue-i18n, Polyglot. */
function byPosition(parts: string[], order: Category[] | undefined, siteId: string): PluralForm[] | null {
  if (!order) return null
  return parts.map((value, i) => ({ category: order[i]!, selector: `[${i}]`, siteId, value }))
}

/**
 * Categories from each part's own selector — Symfony intervals.
 *
 * Three refusals, and each one earns its place. A part with no selector means
 * this is somebody else's arrangement that happens to contain a pipe. A
 * selector this row cannot cite means an interval with no CLDR equivalent, and
 * an unclaimed value surfaces through G7 for a human rather than being guessed
 * at. Two parts resolving to one category means the reading is wrong, whatever
 * the file says.
 */
function bySelector(
  parts: string[],
  spec: NonNullable<ValueSplitRead['partSelector']>,
  siteId: string,
): PluralForm[] | null {
  const forms: PluralForm[] = []
  for (const part of parts) {
    const m = spec.re.exec(part)
    if (!m || m[1] === undefined) return null
    const category = spec.tokens[m[1]]
    if (!category) return null
    forms.push({ category, selector: m[1], siteId, value: part.slice(m[0].length) })
  }
  if (new Set(forms.map((f) => f.category)).size !== forms.length) return null
  return forms
}

export function validateValueSplit(read: unknown): string[] {
  const problems: string[] = []
  const r = read as Partial<ValueSplitRead>
  if (!r || typeof r !== 'object') return ['read must be an object']
  if (!r.delimiters?.length) problems.push('read.delimiters must list at least one delimiter')
  for (const d of r.delimiters ?? []) {
    if (typeof d !== 'string' || d.length === 0) problems.push('a delimiter must be a non-empty string')
  }
  const hasOrder = r.order && Object.keys(r.order).length > 0
  const hasSelector = r.partSelector !== undefined
  if (!hasOrder && !hasSelector) {
    problems.push('read needs `order` (categories by position) or `partSelector` (a selector on each part)')
  }
  if (hasOrder && hasSelector) {
    // They answer the same question two ways, and a row carrying both leaves a
    // reader unable to tell which one decided.
    problems.push('read has both `order` and `partSelector`; a part is categorised by its position or by its own selector, not both')
  }
  for (const [n, cats] of Object.entries(r.order ?? {})) {
    if (cats.length !== Number(n)) problems.push(`order[${n}] lists ${cats.length} categories, not ${n}`)
    for (const c of cats) if (!isCategory(c)) problems.push(`order[${n}] contains ${c}, which is not a CLDR category`)
  }
  if (hasSelector) {
    const spec = r.partSelector!
    if (!(spec.re instanceof RegExp)) problems.push('read.partSelector.re must be a regular expression')
    else if (!/\((?!\?)/.test(spec.re.source)) {
      problems.push('read.partSelector.re must capture the selector in group 1')
    }
    const tokens = spec.tokens ?? {}
    if (Object.keys(tokens).length === 0) problems.push('read.partSelector.tokens must map at least one selector')
    for (const [spelling, c] of Object.entries(tokens)) {
      if (!isCategory(c)) problems.push(`partSelector.tokens[${spelling}] is ${c}, which is not a CLDR category`)
    }
  }
  return problems
}
