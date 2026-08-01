// One form per site, with the category read off the site's anchor path.
//
// This one primitive replaces three hand-written detectors, and the proof that
// they were always the same algorithm is already in `splitPluralKey`: it treats
// `/` as a separator exactly like `_` and `.`, and `writePlan` derives both key
// templates from that single separator. `attr-quantity` differs only in that its
// cut is a regex rather than a separator.
//
// What is left over — which native tokens exist, whether the category is a
// suffix or a child, how many forms make a family — is parameters, and
// parameters belong in a data row.
import type { Site } from '../../types'
import { isCategory, sortCategories, type Category } from '../cldr'
import type { PathPartRead, PluralDialect } from '../dialect/types'
import type { DetectedFamily, PluralForm } from '../shapes'
import { pathOf, dedupe, type DetectContext } from './shared'

export function detectPathPart(
  sites: Site[],
  dialect: PluralDialect & { read: PathPartRead },
  ctx: DetectContext,
): DetectedFamily[] {
  const read = dialect.read
  const minForms = read.minForms ?? 1
  const suffixRe = read.split.kind === 'leaf-suffix' ? suffixPattern(read, read.split.separators) : null

  interface Group {
    forms: PluralForm[]
    file: string
    base: string
    ordinal: boolean
    /** Numeric tokens, resolved to categories only once the arity is known. */
    positional: { index: number; siteId: string; value: string; token: string }[]
  }
  const groups = new Map<string, Group>()

  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!ctx.applies(dialect, site)) continue

    const path = pathOf(site)
    const cut = path.lastIndexOf('/')
    const parent = cut === -1 ? '' : path.slice(0, cut)
    const leaf = cut === -1 ? path : path.slice(cut + 1)

    let base: string
    let token: string
    let selector: string
    let ordinal = false

    if (read.split.kind === 'path-regex') {
      const m = read.split.re.exec(path)
      if (!m || m[1] === undefined || m[2] === undefined) continue
      base = m[1]
      token = m[2]
      selector = token
    } else if (read.split.kind === 'leaf-is-token') {
      // The category IS the leaf key, so a family needs a parent to hang off.
      if (cut <= 0) continue
      base = parent
      token = leaf
      selector = leaf
    } else {
      const m = suffixRe!.exec(leaf)
      if (!m || !m[1]) continue
      base = `${parent}/${m[1]}`
      ordinal = m[2] !== undefined
      token = m[3]!
      selector = leaf.slice(m[1].length)
    }

    // An explicit `tokens` entry ALWAYS wins, even when the token is spelled
    // with a digit. A hand-rolled `item#1` / `item#n` scheme names its forms `1`
    // and `n`, and treating `1` as a position because it looks like one made the
    // declaration silently claim nothing — the dialect validated, cited its
    // documentation, and read no site at all.
    const declared = read.tokens?.[token]
    const positional = declared === undefined && /^\d+$/.test(token)
    if (positional && !read.order) continue
    if (!positional && declared === undefined) continue

    const groupKey = `${site.file}\0${base}\0${ordinal}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { forms: [], file: site.file, base, ordinal, positional: [] }
      groups.set(groupKey, group)
    }
    if (positional) {
      group.positional.push({ index: Number(token), siteId: site.id, value: site.value, token })
    } else {
      group.forms.push({
        category: declared!,
        selector: render(read.selectorTemplate, selector, token),
        siteId: site.id,
        value: site.value,
      })
    }
  }

  const out: DetectedFamily[] = []
  for (const group of groups.values()) {
    const forms = group.positional.length ? resolvePositional(group.positional, read) : group.forms
    if (forms.length === 0) continue
    if (new Set(forms.map((f) => f.category)).size < minForms) continue
    out.push({
      shape: dialect.shape,
      dialect: dialect.id,
      primitive: 'path-part',
      cldr: dialect.cldr,
      write: dialect.write,
      file: group.file,
      base: group.base,
      forms: dedupe(forms),
      exact: [],
      sites: forms.map((f) => f.siteId),
      ordinal: group.ordinal,
    })
  }
  return out
}

/**
 * Numeric tokens become categories only once the family's ARITY is known.
 *
 * `msgstr[1]` of a three-form Polish catalog is "the second form", and calling
 * it `few` would be a claim about grammar that gettext's own header — a C
 * expression the engine does not evaluate — is the only thing entitled to make.
 * The names are positional labels, which is why such a dialect sets
 * `cldr: false` and is never measured against CLDR.
 */
function resolvePositional(
  positional: { index: number; siteId: string; value: string; token: string }[],
  read: PathPartRead,
): PluralForm[] {
  const sorted = [...positional].sort((a, b) => a.index - b.index)
  const order = read.order?.[sorted.length]
  if (!order) return []
  return sorted.map((p, i) => ({
    category: order[i]!,
    selector: render(read.selectorTemplate, `[${p.token}]`, p.token),
    siteId: p.siteId,
    value: p.value,
  }))
}

/**
 * `^(base)(_ordinal_)?(token)$`, generated from the row rather than written out.
 *
 * The old `SUFFIX_RE` baked in `[_.]`, the i18next ordinal infix and the token
 * list. All three are now fields, so a runtime spelling its categories
 * differently is a row and not a patch.
 */
function suffixPattern(read: PathPartRead, separators: string[]): RegExp {
  const sep = `[${separators.map(escape).join('')}]`
  const infix = read.ordinalInfix?.length
    ? `(?:${read.ordinalInfix.map((o) => `${escape(o)}`).join('|')})`
    : null
  const tokens = Object.keys(read.tokens ?? {}).map(escape).join('|')
  const numeric = read.order ? '|\\d+' : ''
  return new RegExp(`^(.*?)${sep}${infix ? `(${infix}${sep})?` : '()?'}(${tokens}${numeric})$`)
}

function render(template: string | undefined, selector: string, token: string): string {
  return template ? template.replace('{token}', token) : selector
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function validatePathPart(read: unknown): string[] {
  const problems: string[] = []
  const r = read as Partial<PathPartRead>
  if (!r || typeof r !== 'object') return ['read must be an object']
  if (!r.split) problems.push('read.split is required')
  else if (r.split.kind === 'leaf-suffix' && !r.split.separators?.length) {
    problems.push('read.split.separators must list at least one separator')
  }
  for (const [token, category] of Object.entries(r.tokens ?? {})) {
    if (!isCategory(category as string)) problems.push(`token ${token} maps to ${category}, which is not a CLDR category`)
  }
  for (const [n, cats] of Object.entries(r.order ?? {})) {
    if (cats.length !== Number(n)) problems.push(`order[${n}] lists ${cats.length} categories, not ${n}`)
    for (const c of cats) if (!isCategory(c)) problems.push(`order[${n}] contains ${c}, which is not a CLDR category`)
  }
  if (!r.tokens && !r.order) problems.push('read needs `tokens`, `order`, or both — otherwise nothing can be a category')
  return problems
}

export { sortCategories, type Category }
