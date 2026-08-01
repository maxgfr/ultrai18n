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
import type { PluralDialect, ValueSplitRead } from '../dialect/types'
import type { DetectedFamily } from '../shapes'
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
    const order = read.order[parts.length]
    if (!order) continue
    if (parts.some((p) => !/\p{L}{2,}/u.test(p))) continue
    if (read.requiresCounting !== false && !parts.some((p) => COUNTS.test(p))) continue

    out.push({
      shape: dialect.shape,
      dialect: dialect.id,
      primitive: 'value-split',
      cldr: dialect.cldr,
      write: dialect.write,
      file: site.file,
      base: pathOf(site),
      forms: parts.map((value, i) => ({
        category: order[i]!,
        selector: `[${i}]`,
        siteId: site.id,
        value,
      })),
      exact: [],
      sites: [site.id],
      ordinal: false,
      delimiter,
    })
  }
  return out
}

export function validateValueSplit(read: unknown): string[] {
  const problems: string[] = []
  const r = read as Partial<ValueSplitRead>
  if (!r || typeof r !== 'object') return ['read must be an object']
  if (!r.delimiters?.length) problems.push('read.delimiters must list at least one delimiter')
  for (const d of r.delimiters ?? []) {
    if (typeof d !== 'string' || d.length === 0) problems.push('a delimiter must be a non-empty string')
  }
  if (!r.order || Object.keys(r.order).length === 0) {
    problems.push('read.order must say what each part count means')
  }
  for (const [n, cats] of Object.entries(r.order ?? {})) {
    if (cats.length !== Number(n)) problems.push(`order[${n}] lists ${cats.length} categories, not ${n}`)
    for (const c of cats) if (!isCategory(c)) problems.push(`order[${n}] contains ${c}, which is not a CLDR category`)
  }
  return problems
}
