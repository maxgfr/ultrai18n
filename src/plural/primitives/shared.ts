// What every primitive needs and none of them owns.
import type { Site } from '../../types'
import { sortCategories, type Category } from '../cldr'
import type { PluralDialect } from '../dialect/types'
import type { PluralForm } from '../shapes'

/**
 * What a primitive is allowed to ask about the repository it is reading.
 *
 * Deliberately one predicate. A primitive decides how forms are LAID OUT; the
 * question of whether this dialect belongs anywhere near this file is the
 * dialect's own (`where`, `evidence`) and is answered before it is called.
 */
export interface DetectContext {
  applies(dialect: PluralDialect, site: Site): boolean
}

/** The anchor path, without the `file#` prefix. */
export function pathOf(site: Site): string {
  return site.siteKey.slice(site.siteKey.indexOf('#') + 1)
}

/** Last writer wins, so a duplicated category never produces two forms. */
export function dedupe(forms: PluralForm[]): PluralForm[] {
  const byCategory = new Map<Category, PluralForm>()
  for (const form of forms) byCategory.set(form.category, form)
  return sortCategories(byCategory.keys()).map((c) => byCategory.get(c)!)
}
