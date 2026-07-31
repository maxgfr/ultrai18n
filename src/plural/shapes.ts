// How a plural family is written down, and nothing about what it means.
//
// The five shapes below are syntactic arrangements, not products. That is the
// whole point: "support i18next" is a commitment to one library's roadmap,
// while "recognise `key_one` / `key_other` in a locale bundle" is a commitment
// to an arrangement that i18next, Rails, Symfony and a great deal of hand-rolled
// code all happen to share. A new runtime is a row in this table, and usually
// not even that.
//
// Each shape carries a `docs` URL for the same reason a catalog rule does: a
// rule without evidence is a hunch, and `catalog check` rejects one.
import type { Site } from '../types'
import { isCategory, sortCategories, type Category } from './cldr'
import { looksLikeIcu, scanIcu, type IcuArgument } from './icu'

export type PluralShapeId =
  | 'key-suffix'
  | 'sibling-object'
  | 'inline-select'
  | 'attr-quantity'
  | 'delimited'
  | 'annotation'

export interface PluralShape {
  id: PluralShapeId
  title: string
  docs: string
  notes?: string
}

export const PLURAL_SHAPES: PluralShape[] = [
  {
    id: 'key-suffix',
    title: 'Category appended to the key',
    docs: 'https://www.i18next.com/translation-function/plurals',
    notes:
      'i18next `key_one`, Rails `key.one`, and any hand-rolled `_singular`/`_plural`. Numeric suffixes (`key_0`) are deliberately NOT read as categories: they collide with array indices, and guessing wrong invents a form nobody wrote.',
  },
  {
    id: 'sibling-object',
    title: 'Categories as sibling keys of one object',
    docs: 'https://guides.rubyonrails.org/i18n.html#pluralization',
    notes: 'Rails, vue-i18n object form, Flutter. Requires at least two category-named siblings.',
  },
  {
    id: 'inline-select',
    title: 'ICU MessageFormat plural argument',
    docs: 'https://unicode-org.github.io/icu/userguide/format_parse/messages/',
    notes:
      'react-intl, FormatJS, ARB, Android ICU, Java. The engine keeps the skeleton and hands the translator only the branch bodies, so a target needing four branches where the source has two costs nothing structural.',
  },
  {
    id: 'attr-quantity',
    title: 'Quantity attribute on a resource item',
    docs: 'https://developer.android.com/guide/topics/resources/string-resource#Plurals',
    notes: 'Android `<plurals><item quantity="one">`, and plists shaped the same way.',
  },
  {
    id: 'delimited',
    title: 'Forms separated by a pipe',
    docs: 'https://vue-i18n.intlify.dev/guide/essentials/pluralization',
    notes:
      'vue-i18n. Positional rather than named: two parts are one|other, three are zero|one|other. Only read inside a locale bundle, and only when a part carries a number — otherwise "Save | Cancel" would become a plural family.',
  },
  {
    id: 'annotation',
    title: 'Declared in place by an annotation',
    docs: 'https://github.com/maxgfr/ultrai18n#plurals',
    notes:
      'The escape hatch for everything above that no shape recognises, and the only remedy for a rule baked into an expression. The engine never infers these: something has to say so.',
  },
]

export const SHAPES_BY_ID = new Map(PLURAL_SHAPES.map((s) => [s.id, s]))

/**
 * Native quantity tokens, mapped onto CLDR.
 *
 * Numeric tokens are absent on purpose — see the `key-suffix` note. `plural`
 * meaning `other` is the i18next v20 spelling and still extremely common.
 */
const SUFFIX_TOKENS: Record<string, Category> = {
  zero: 'zero',
  one: 'one',
  two: 'two',
  few: 'few',
  many: 'many',
  other: 'other',
  singular: 'one',
  plural: 'other',
}

const SUFFIX_RE = new RegExp(`^(.*?)([_.])(?:(ordinal)[_.])?(${Object.keys(SUFFIX_TOKENS).join('|')})$`)

/**
 * Split a catalog key into its family and its category, or null.
 *
 * Covers both arrangements a locale catalog uses: the category appended to the
 * key (`item_one`) and the category as a child of it (`item/one`). One helper
 * for both because the consumers — `sync`, the gate — care about the family,
 * not about which spelling a runtime chose.
 */
export function splitPluralKey(
  path: string,
): { base: string; category: Category; separator: string } | null {
  const cut = path.lastIndexOf('/')
  const parent = cut === -1 ? '' : path.slice(0, cut)
  const key = cut === -1 ? path : path.slice(cut + 1)

  if (isCategory(key) && parent) return { base: parent, category: key, separator: '/' }

  const m = SUFFIX_RE.exec(key)
  if (!m || !m[1]) return null
  return { base: `${parent}/${m[1]}`, category: SUFFIX_TOKENS[m[4]!]!, separator: m[2]! }
}

export interface PluralForm {
  category: Category
  /** As written: `one`, `_other`, `=0`, `quantity="few"`. */
  selector: string
  siteId: string
  value: string
  /** inline-select only: character offsets of the branch body within the site value. */
  branch?: { start: number; end: number }
}

export interface DetectedFamily {
  shape: PluralShapeId
  file: string
  /** The structural key the family hangs off, without the category. */
  base: string
  forms: PluralForm[]
  /** `=0`-style exact matches, carried through untouched. */
  exact: { selector: string; value: string }[]
  /** Every site that belongs to the family, including the key sites. */
  sites: string[]
  /** Ordinal families are parsed and preserved, never gated on. */
  ordinal: boolean
  /** inline-select only: the argument, so the skeleton can be rewritten. */
  icu?: { siteId: string; argument: IcuArgument }
}

export interface DetectOptions {
  /** True when the file is a locale catalog — the context the weaker shapes need. */
  isBundle: (file: string) => boolean
}

/**
 * Find every family in an inventory.
 *
 * Order matters only in that a site claimed by one shape is not offered to a
 * weaker one: an ICU message living under a `_one` key is an ICU family, not a
 * key-suffix family whose value happens to contain braces.
 */
export function detectFamilies(sites: Site[], opts: DetectOptions): DetectedFamily[] {
  const claimed = new Set<string>()
  const families: DetectedFamily[] = []

  for (const family of detectInlineSelect(sites)) {
    families.push(family)
    for (const id of family.sites) claimed.add(id)
  }
  for (const family of detectAttrQuantity(sites)) {
    if (family.sites.some((id) => claimed.has(id))) continue
    families.push(family)
    for (const id of family.sites) claimed.add(id)
  }
  for (const family of detectKeySuffix(sites, opts)) {
    if (family.sites.some((id) => claimed.has(id))) continue
    families.push(family)
    for (const id of family.sites) claimed.add(id)
  }
  for (const family of detectSiblingObject(sites, opts)) {
    if (family.sites.some((id) => claimed.has(id))) continue
    families.push(family)
    for (const id of family.sites) claimed.add(id)
  }
  for (const family of detectDelimited(sites, opts)) {
    if (family.sites.some((id) => claimed.has(id))) continue
    families.push(family)
    for (const id of family.sites) claimed.add(id)
  }

  return families.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.base < b.base ? -1 : 1))
}

// ---------------------------------------------------------------------------

function detectInlineSelect(sites: Site[]): DetectedFamily[] {
  const out: DetectedFamily[] = []
  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!looksLikeIcu(site.value)) continue
    const scan = scanIcu(site.value)
    if (!scan.ok) continue
    for (const argument of scan.arguments) {
      if (argument.type === 'select') continue
      const forms: PluralForm[] = []
      const exact: { selector: string; value: string }[] = []
      for (const branch of argument.branches) {
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
        shape: 'inline-select',
        file: site.file,
        base: `${pathOf(site)}${argument.depth > 0 ? `@${argument.start}` : ''}`,
        forms,
        exact,
        sites: [site.id],
        ordinal: argument.type === 'selectordinal',
        icu: { siteId: site.id, argument },
      })
    }
  }
  return out
}

function detectKeySuffix(sites: Site[], opts: DetectOptions): DetectedFamily[] {
  const groups = new Map<string, { forms: PluralForm[]; file: string; base: string; ordinal: boolean }>()

  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!opts.isBundle(site.file)) continue
    const path = pathOf(site)
    const cut = path.lastIndexOf('/')
    const parent = cut === -1 ? '' : path.slice(0, cut)
    const key = cut === -1 ? path : path.slice(cut + 1)

    const m = SUFFIX_RE.exec(key)
    if (!m) continue
    const base = m[1]!
    const ordinal = m[3] !== undefined
    const category = SUFFIX_TOKENS[m[4]!]!
    if (!base) continue

    const groupKey = `${site.file}\0${parent}\0${base}\0${ordinal}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { forms: [], file: site.file, base: `${parent}/${base}`, ordinal }
      groups.set(groupKey, group)
    }
    group.forms.push({ category, selector: key.slice(base.length), siteId: site.id, value: site.value })
  }

  return [...groups.values()]
    .filter((g) => g.forms.length > 0)
    .map((g) => ({
      shape: 'key-suffix' as const,
      file: g.file,
      base: g.base,
      forms: dedupe(g.forms),
      exact: [],
      sites: g.forms.map((f) => f.siteId),
      ordinal: g.ordinal,
    }))
}

function detectSiblingObject(sites: Site[], opts: DetectOptions): DetectedFamily[] {
  const groups = new Map<string, { forms: PluralForm[]; file: string; base: string }>()

  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!opts.isBundle(site.file)) continue
    const path = pathOf(site)
    const cut = path.lastIndexOf('/')
    if (cut <= 0) continue
    const parent = path.slice(0, cut)
    const key = path.slice(cut + 1)
    if (!isCategory(key)) continue

    const groupKey = `${site.file}\0${parent}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { forms: [], file: site.file, base: parent }
      groups.set(groupKey, group)
    }
    group.forms.push({ category: key, selector: key, siteId: site.id, value: site.value })
  }

  // Two category-named siblings is the signature. One is just a key called
  // `other`, which is a word people use for other things.
  return [...groups.values()]
    .filter((g) => new Set(g.forms.map((f) => f.category)).size >= 2)
    .map((g) => ({
      shape: 'sibling-object' as const,
      file: g.file,
      base: g.base,
      forms: dedupe(g.forms),
      exact: [],
      sites: g.forms.map((f) => f.siteId),
      ordinal: false,
    }))
}

/** `plurals[task_count]/item[one]`, produced by the markup extractor. */
const QUANTITY_PATH = /^(.*plurals\[[^\]]*\])\/item\[([a-z]+)\]$/

function detectAttrQuantity(sites: Site[]): DetectedFamily[] {
  const groups = new Map<string, { forms: PluralForm[]; file: string; base: string }>()

  for (const site of sites) {
    if (site.kind === 'key') continue
    const m = QUANTITY_PATH.exec(pathOf(site))
    if (!m) continue
    const quantity = m[2]!
    if (!isCategory(quantity)) continue

    const groupKey = `${site.file}\0${m[1]}`
    let group = groups.get(groupKey)
    if (!group) {
      group = { forms: [], file: site.file, base: m[1]! }
      groups.set(groupKey, group)
    }
    group.forms.push({
      category: quantity,
      selector: `quantity="${quantity}"`,
      siteId: site.id,
      value: site.value,
    })
  }

  return [...groups.values()].map((g) => ({
    shape: 'attr-quantity' as const,
    file: g.file,
    base: g.base,
    forms: dedupe(g.forms),
    exact: [],
    sites: g.forms.map((f) => f.siteId),
    ordinal: false,
  }))
}

/** Positional forms, per vue-i18n: two parts are one|other, three are zero|one|other. */
const DELIMITED_ORDER: Record<number, Category[]> = {
  2: ['one', 'other'],
  3: ['zero', 'one', 'other'],
}

function detectDelimited(sites: Site[], opts: DetectOptions): DetectedFamily[] {
  const out: DetectedFamily[] = []
  for (const site of sites) {
    if (site.kind === 'key') continue
    if (!opts.isBundle(site.file)) continue
    if (!site.value.includes('|')) continue

    const parts = site.value.split('|').map((p) => p.trim())
    const order = DELIMITED_ORDER[parts.length]
    if (!order) continue
    if (parts.some((p) => !/\p{L}{2,}/u.test(p))) continue
    // The guard that keeps "Save | Cancel" out: a plural has to count something.
    if (!parts.some((p) => /\d|\{[^}]*\}|%[sd@]/.test(p))) continue

    out.push({
      shape: 'delimited',
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
    })
  }
  return out
}

// ---------------------------------------------------------------------------

function pathOf(site: Site): string {
  return site.siteKey.slice(site.siteKey.indexOf('#') + 1)
}

/** Last writer wins, so a duplicated category does not produce two forms. */
function dedupe(forms: PluralForm[]): PluralForm[] {
  const byCategory = new Map<Category, PluralForm>()
  for (const form of forms) byCategory.set(form.category, form)
  return sortCategories(byCategory.keys()).map((c) => byCategory.get(c)!)
}
