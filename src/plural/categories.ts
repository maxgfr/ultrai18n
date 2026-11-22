// The CLDR category vocabulary, on its own.
//
// Separate from `cldr.ts` so the ICU scanner can be read without it: the
// language detector reads ICU messages, and `cldr.ts` reads the detector's list
// of profiled languages, so through `cldr.ts` the two would import each other.

/** CLDR cardinal plural categories, in CLDR's own canonical order. */
export type Category = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other'

export const CATEGORIES: Category[] = ['zero', 'one', 'two', 'few', 'many', 'other']

const CATEGORY_SET = new Set<string>(CATEGORIES)

export function isCategory(s: string): s is Category {
  return CATEGORY_SET.has(s)
}
