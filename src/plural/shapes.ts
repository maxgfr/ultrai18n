// What a detected family IS, and where the catalog is run.
//
// This file used to hold five detector functions with their library knowledge
// baked in: a token table, vue-i18n's positional scheme, Android's path regex.
// All three are now fields on a data row in `dialect/dialects.ts`, read by one
// of three primitives in `primitives/`. What is left here is the shared vocabulary
// and one call.
//
// The reason for the move: "support i18next" is a commitment to one library's
// roadmap, while "read a category appended to a key in a locale bundle" is a
// commitment to an arrangement that i18next, Rails, Symfony and a great deal of
// hand-rolled code all happen to share. A new runtime should be a row, and
// usually not even that.
import type { Site } from '../types'
import { isCategory, type Category } from './cldr'
import type { IcuArgument } from './icu'
import { DIALECTS } from './dialect/dialects'
import type { PluralDialect, PrimitiveId, WriteSpec } from './dialect/types'
import { runDialects } from './primitives'

/**
 * The closed reporting label an arrangement is filed under.
 *
 * A closed vocabulary over an open rule set, exactly as `Surface` sits over the
 * catalog. `other` is for an arrangement matching none of the five — gettext, Qt,
 * `.xcstrings` — because calling a Fluent selector an `inline-select` would be a
 * lie of convenience.
 */
export type PluralShapeId =
  | 'key-suffix'
  | 'sibling-object'
  | 'inline-select'
  | 'attr-quantity'
  | 'delimited'
  | 'annotation'
  | 'other'

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
  /** The dialect that claimed it, so every family is citable back to a documented row. */
  dialect: string
  primitive: PrimitiveId
  /** Whether CLDR governs this family. False for positional and index schemes. */
  cldr: boolean
  /**
   * How this family is written back, carried from the dialect that claimed it.
   *
   * Carried rather than looked up by id: a PROJECT dialect is not in the shipped
   * map, so a lookup silently fell through to `code-edit` and a declared
   * arrangement could never be written mechanically — the same class of bug the
   * annotation channel had.
   */
  write: WriteSpec
  file: string
  /** The structural key the family hangs off, without the category. */
  base: string
  forms: PluralForm[]
  /** `=0`-style exact matches, carried through untouched. */
  exact: { selector: string; value: string }[]
  /** Every site that belongs to the family. */
  sites: string[]
  /** Ordinal families are parsed and preserved, never gated on. */
  ordinal: boolean
  /** inline-select only: the argument, so the skeleton can be rewritten. */
  icu?: { siteId: string; argument: IcuArgument }
  /** value-split only: which delimiter matched, so `apply` rejoins with the same one. */
  delimiter?: string
}

export interface DetectOptions {
  /** True when the file is a locale catalog — the context the weaker dialects need. */
  isBundle: (file: string) => boolean
  /** Extra dialects, merged over the shipped catalog. */
  dialects?: PluralDialect[]
  /** Dialect ids the repository's evidence rules out. */
  inert?: Set<string>
}

/**
 * Find every family in an inventory.
 *
 * Order matters only in that a site claimed by one dialect is not offered to a
 * weaker one: an ICU message living under a `_one` key is an ICU family, not a
 * key-suffix family whose value happens to contain braces. That is `precedence`.
 */
export function detectFamilies(sites: Site[], opts: DetectOptions): DetectedFamily[] {
  return runDialects(mergeDialects(opts.dialects), sites, {
    isBundle: opts.isBundle,
    ...(opts.inert ? { inert: opts.inert } : {}),
  })
}

/**
 * Shipped rows, with project rows layered over them.
 *
 * A project row replaces a shipped one of the same id rather than shadowing it,
 * so `dialects --explain` never has to report two rows with one name.
 */
export function mergeDialects(project?: PluralDialect[]): PluralDialect[] {
  if (!project?.length) return DIALECTS
  const byId = new Map(DIALECTS.map((d) => [d.id, d]))
  for (const d of project) byId.set(d.id, d)
  return [...byId.values()]
}

/**
 * Split a catalog key into its family and its category, or null.
 *
 * Covers both arrangements a locale catalog uses: the category appended to the
 * key (`item_one`) and the category as a child of it (`item/one`). One helper
 * for both because the consumers — `sync`, the gate — care about the family, not
 * about which spelling a runtime chose.
 *
 * Kept as a standalone function rather than routed through the catalog: those
 * consumers ask about a key they already have, with no site and no repository
 * around it, and handing them a dialect run would be answering a different
 * question.
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
