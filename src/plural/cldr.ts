// Which plural forms a locale actually requires.
//
// This is the one piece of linguistic fact the plural feature needs, and it is
// deliberately NOT a library and NOT a hard-coded language list. `Intl.PluralRules`
// ships CLDR inside the runtime and answers for any BCP-47 tag, which is what
// keeps the rest of the design free of both an i18n-runtime dependency and a
// closed set of supported languages.
//
// The catch is that determinism is a product guarantee here, and a Node built
// with small-ICU answers `one, other` for every locale on earth — silently, and
// with a wrong answer that looks exactly like a right one. So the tier is
// PROBED at first use against a locale whose answer is known, and a runtime
// that fails the probe drops to a shipped table and says so through the
// advisory channel rather than quietly producing English plural rules for
// Russian.
import { SUPPORTED } from '../lang/detect'

/** CLDR cardinal plural categories, in CLDR's own canonical order. */
export type Category = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export const CATEGORIES: Category[] = ['zero', 'one', 'two', 'few', 'many', 'other']

const CATEGORY_SET = new Set<string>(CATEGORIES)

export function isCategory(s: string): s is Category {
  return CATEGORY_SET.has(s)
}

/** Sort into CLDR order, so two equal form sets always serialize identically. */
export function sortCategories(cats: Iterable<Category>): Category[] {
  const seen = new Set(cats)
  return CATEGORIES.filter((c) => seen.has(c))
}

/**
 * The fallback, used only when the runtime fails the probe.
 *
 * It covers the fourteen languages the detector profiles plus the ones whose
 * form count differs most from English, because those are exactly the cases
 * where being wrong is expensive. A locale outside the table on a small-ICU
 * runtime returns null: refusing to answer beats answering `one, other` for
 * Arabic.
 */
const TABLE: Record<string, Category[]> = {
  // The detector's fourteen profiles.
  en: ['one', 'other'],
  fr: ['one', 'many', 'other'],
  es: ['one', 'many', 'other'],
  de: ['one', 'other'],
  it: ['one', 'many', 'other'],
  pt: ['one', 'many', 'other'],
  nl: ['one', 'other'],
  sv: ['one', 'other'],
  da: ['one', 'other'],
  pl: ['one', 'few', 'many', 'other'],
  ro: ['one', 'few', 'other'],
  tr: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
  ja: ['other'],
  // Beyond the profiles: the shapes that differ most from two-form English.
  ar: ['zero', 'one', 'two', 'few', 'many', 'other'],
  cy: ['zero', 'one', 'two', 'few', 'many', 'other'],
  ga: ['one', 'two', 'few', 'many', 'other'],
  sl: ['one', 'two', 'few', 'other'],
  he: ['one', 'two', 'other'],
  lv: ['zero', 'one', 'other'],
  lt: ['one', 'few', 'many', 'other'],
  cs: ['one', 'few', 'many', 'other'],
  sk: ['one', 'few', 'many', 'other'],
  uk: ['one', 'few', 'many', 'other'],
  hr: ['one', 'few', 'other'],
  sr: ['one', 'few', 'other'],
  ca: ['one', 'many', 'other'],
  zh: ['other'],
  ko: ['other'],
  vi: ['other'],
  th: ['other'],
  id: ['other'],
  ms: ['other'],
  hi: ['one', 'other'],
  fa: ['one', 'other'],
  fi: ['one', 'other'],
  el: ['one', 'other'],
  hu: ['one', 'other'],
  bg: ['one', 'other'],
  et: ['one', 'other'],
  nb: ['one', 'other'],
  no: ['one', 'other'],
}

/** Languages the fallback knows, exported so a test can assert table/ICU parity. */
export const TABLE_LOCALES = Object.keys(TABLE).sort()

export interface PluralTier {
  tier: 'icu' | 'table'
  /** Why the ICU tier was rejected, when it was. Surfaced as an advisory. */
  reason?: string
}

let tier: PluralTier | null = null

/**
 * Two probes, chosen because a small-ICU runtime gets both wrong in the same
 * direction: it reports English's two categories for everything.
 */
function probe(): PluralTier {
  try {
    const ru = new Intl.PluralRules('ru').resolvedOptions().pluralCategories
    const ar = new Intl.PluralRules('ar').resolvedOptions().pluralCategories
    if (ru.length === 4 && ar.length === 6) return { tier: 'icu' }
    return {
      tier: 'table',
      reason:
        `this Node was built without full ICU (it reports ${ru.length} plural categories for Russian and ` +
        `${ar.length} for Arabic, where CLDR has 4 and 6). Plural categories come from the shipped table, ` +
        `which covers ${TABLE_LOCALES.length} languages; anything outside it is routed to judgment.`,
    }
  } catch (err) {
    return { tier: 'table', reason: `Intl.PluralRules is unavailable (${(err as Error).message})` }
  }
}

export function pluralTier(): PluralTier {
  if (!tier) tier = probe()
  return tier
}

/** Test seam: forget the probe so a test can exercise both tiers. */
export function resetPluralTier(): void {
  tier = null
}

/**
 * The categories a locale requires, or null when neither tier can say.
 *
 * A region subtag never changes the plural rule — `pt-BR` and `pt-PT` agree —
 * so the tag is reduced to its language before either lookup.
 */
export function categoriesFor(locale: string): Category[] | null {
  const lang = baseLanguage(locale)
  if (!lang) return null

  if (pluralTier().tier === 'icu') {
    try {
      const cats = new Intl.PluralRules(lang).resolvedOptions().pluralCategories
      // A tag Intl does not know falls back to the root locale rather than
      // throwing, and root is `other` alone — indistinguishable from Japanese.
      // The table, when it has an opinion, is the more trustworthy answer.
      if (cats.length > 0 && cats.every(isCategory)) {
        return sortCategories(cats as Category[])
      }
    } catch {
      /* fall through to the table */
    }
  }

  const fromTable = TABLE[lang]
  return fromTable ? [...fromTable] : null
}

/**
 * Ordinal categories — `1st`, `2nd`, `3rd` — which are a different rule set
 * from cardinals in most languages. Parsed and preserved, never gated on: see
 * the stated limits.
 */
export function ordinalCategoriesFor(locale: string): Category[] | null {
  const lang = baseLanguage(locale)
  if (!lang || pluralTier().tier !== 'icu') return null
  try {
    const cats = new Intl.PluralRules(lang, { type: 'ordinal' }).resolvedOptions().pluralCategories
    return cats.every(isCategory) ? sortCategories(cats as Category[]) : null
  } catch {
    return null
  }
}

export function baseLanguage(locale: string): string | null {
  const m = /^([A-Za-z]{2,3})(?:[-_]|$)/.exec(locale.trim())
  return m ? m[1]!.toLowerCase() : null
}

/**
 * Does this language distinguish plural forms at all?
 *
 * Japanese and Chinese have one category, so a two-form English family
 * COLLAPSES into one form there. That is a correct result, not a missing
 * translation, and saying it out loud is what stops the gate reporting it.
 */
export function isSingleForm(locale: string): boolean {
  const cats = categoriesFor(locale)
  return cats !== null && cats.length === 1
}

/** Every language the detector profiles, for cross-checking the table. */
export const PROFILED_LANGUAGES: readonly string[] = SUPPORTED
