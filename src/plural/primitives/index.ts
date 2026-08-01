// The primitive registry, and the loop that runs a catalog of dialects.
//
// Precedence is the whole of the ordering logic: a site claimed by a lower
// number is never offered to a higher one. That is what the old `detectFamilies`
// expressed by the order of five function calls, and expressing it as a field
// means a project can slot a dialect between two shipped ones without editing
// this package.
import type { Site } from '../../types'
import { compileGlobs } from '../../vendor/glob'
import type { PluralDialect, PrimitiveId } from '../dialect/types'
import type { DetectedFamily } from '../shapes'
import { detectFluent } from './fluent'
import { detectIcu, validateGrammar } from './icu'
import { detectPathPart, validatePathPart } from './path-part'
import { detectValueSplit, validateValueSplit } from './value-split'
import { pathOf, type DetectContext } from './shared'

export type { DetectContext } from './shared'

export interface Primitive {
  id: PrimitiveId
  detect(sites: Site[], dialect: PluralDialect, ctx: DetectContext): DetectedFamily[]
  /** Reject a `read` block this primitive cannot execute. Powers `dialects --check`. */
  validate(read: unknown): string[]
}

export const PRIMITIVES: Record<PrimitiveId, Primitive> = {
  'path-part': {
    id: 'path-part',
    detect: (sites, d, ctx) => detectPathPart(sites, d as never, ctx),
    validate: validatePathPart,
  },
  'value-split': {
    id: 'value-split',
    detect: (sites, d, ctx) => detectValueSplit(sites, d as never, ctx),
    validate: validateValueSplit,
  },
  icu: {
    id: 'icu',
    detect: (sites, d, ctx) => detectIcu(sites, d as never, ctx),
    validate: validateGrammar,
  },
  fluent: {
    id: 'fluent',
    detect: (sites, d, ctx) => detectFluent(sites, d as never, ctx),
    validate: validateGrammar,
  },
}

export interface RunOptions {
  /** True when the file is a locale catalog — `scan`'s `isBundleFile`. */
  isBundle: (file: string) => boolean
  /** Dialect ids this repository's evidence rules out. Empty until step 7. */
  inert?: Set<string>
}

export function runDialects(
  dialects: PluralDialect[],
  sites: Site[],
  opts: RunOptions,
): DetectedFamily[] {
  const ctx = makeContext(opts)
  const claimed = new Set<string>()
  const families: DetectedFamily[] = []

  for (const dialect of ordered(dialects)) {
    if (opts.inert?.has(dialect.id)) continue
    for (const family of PRIMITIVES[dialect.primitive].detect(sites, dialect, ctx)) {
      if (family.sites.some((id) => claimed.has(id))) continue
      families.push(family)
      for (const id of family.sites) claimed.add(id)
    }
  }

  return families.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.base < b.base ? -1 : a.base > b.base ? 1 : 0,
  )
}

/** Ascending precedence, then by id, so two rows never race. */
export function ordered(dialects: PluralDialect[]): PluralDialect[] {
  return [...dialects].sort((a, b) =>
    a.precedence !== b.precedence ? a.precedence - b.precedence : a.id < b.id ? -1 : 1,
  )
}

const globCache = new Map<string, (rel: string) => boolean>()

function makeContext(opts: RunOptions): DetectContext {
  return {
    applies(dialect, site) {
      const where = dialect.where
      if (where.bundleOnly && !opts.isBundle(site.file)) return false
      if (where.file?.length && !fileMatches(where.file, site.file)) return false
      if (where.path && !where.path.test(pathOf(site))) return false
      return true
    },
  }
}

function fileMatches(globs: string[], file: string): boolean {
  const key = globs.join(' ')
  let fn = globCache.get(key)
  if (!fn) {
    const positive = compileGlobs(globs.filter((g) => !g.startsWith('!')))
    const negative = compileGlobs(globs.filter((g) => g.startsWith('!')).map((g) => g.slice(1)))
    fn = (rel: string) => (!positive || positive(rel)) && !negative?.(rel)
    globCache.set(key, fn)
  }
  return fn(file)
}
