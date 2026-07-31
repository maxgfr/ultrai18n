import { describe, it, expect } from 'vitest'
import {
  categoriesFor,
  ordinalCategoriesFor,
  isSingleForm,
  baseLanguage,
  pluralTier,
  sortCategories,
  isCategory,
  TABLE_LOCALES,
  PROFILED_LANGUAGES,
} from '../src/plural/cldr'

describe('categories', () => {
  it('gives each language the number of forms CLDR gives it', () => {
    expect(categoriesFor('en')).toEqual(['one', 'other'])
    expect(categoriesFor('fr')).toEqual(['one', 'many', 'other'])
    expect(categoriesFor('ru')).toEqual(['one', 'few', 'many', 'other'])
    expect(categoriesFor('ar')).toEqual(['zero', 'one', 'two', 'few', 'many', 'other'])
    expect(categoriesFor('ja')).toEqual(['other'])
  })

  it('ignores the region, because a region never changes the plural rule', () => {
    expect(categoriesFor('pt-BR')).toEqual(categoriesFor('pt'))
    expect(categoriesFor('en_US')).toEqual(categoriesFor('en'))
    expect(baseLanguage('zh-Hans-CN')).toBe('zh')
  })

  it('always answers in CLDR order, so two equal sets serialize identically', () => {
    expect(sortCategories(['other', 'few', 'one'])).toEqual(['one', 'few', 'other'])
  })

  it('knows which languages collapse a family into one form', () => {
    expect(isSingleForm('ja')).toBe(true)
    expect(isSingleForm('zh')).toBe(true)
    expect(isSingleForm('en')).toBe(false)
    expect(isSingleForm('ru')).toBe(false)
  })

  it('refuses a tag that is not a language', () => {
    expect(baseLanguage('')).toBe(null)
    expect(baseLanguage('123')).toBe(null)
  })

  it('rejects a non-category string', () => {
    expect(isCategory('one')).toBe(true)
    expect(isCategory('plural')).toBe(false)
    expect(isCategory('=0')).toBe(false)
  })
})

describe('the shipped fallback table', () => {
  // The table only ever runs on a small-ICU build, where by definition it
  // cannot be checked. So it is checked HERE, against the full-ICU runtime
  // developers and CI actually use: drift is caught without the fallback ever
  // silently changing an answer.
  it('agrees with Intl.PluralRules on every locale it claims', () => {
    if (pluralTier().tier !== 'icu') return
    const disagreements: string[] = []
    for (const locale of TABLE_LOCALES) {
      const icu = new Intl.PluralRules(locale).resolvedOptions().pluralCategories
      const table = categoriesFor(locale)
      if (JSON.stringify(sortCategories(icu as never)) !== JSON.stringify(table)) {
        disagreements.push(`${locale}: table ${table?.join(',')} vs ICU ${icu.join(',')}`)
      }
    }
    expect(disagreements).toEqual([])
  })

  it('covers every language the detector profiles', () => {
    expect(PROFILED_LANGUAGES.filter((l) => !TABLE_LOCALES.includes(l))).toEqual([])
  })
})

describe('ordinals', () => {
  it('reads a different rule set from cardinals', () => {
    if (pluralTier().tier !== 'icu') return
    expect(ordinalCategoriesFor('en')).toEqual(['one', 'two', 'few', 'other'])
    // English cardinals have two forms and English ordinals have four: the
    // whole reason an ordinal family is never gated on cardinal completeness.
    expect(ordinalCategoriesFor('en')).not.toEqual(categoriesFor('en'))
  })
})
