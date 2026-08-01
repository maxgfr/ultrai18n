// Reading a dialect somebody else wrote, and refusing the ones that lie.
//
// Shaped after `checkCatalog` in `src/catalog/match.ts`, and for the same
// reason: a row asserting "this arrangement is a plural" without a citation is a
// hunch, and a catalog of hunches is exactly the guessing this tool replaces.
//
// Two of the checks below matter more than the rest, and only one of them is
// obvious. The obvious one is the CLAIM test: a row that matches nothing in this
// repository is speculation about somebody else's. The one that actually
// protects a working repository is the REGRESSION test — because a row that
// steals `item_one` from the i18next dialect and re-reads it wrongly passes the
// claim test without difficulty.
import type { Site } from '../../types'
import { isCategory } from '../cldr'
import type { DetectedFamily } from '../shapes'
import { PRIMITIVES } from '../primitives'
import type { PluralDialect } from './types'

export interface DialectProblem {
  dialect: string
  problem: string
}

/** A pattern a model may have written. Length and nesting are the cheap guards. */
const MAX_PATTERN = 200
const CATASTROPHIC = /\((?:\.\*|\.\+|\[[^\]]*\]\*|\[[^\]]*\]\+)\)[*+]/

/**
 * Turn a parsed JSON row into a dialect, compiling its regexes.
 *
 * Returns null rather than throwing: the caller is either a scan, which must not
 * die on an optional file, or `dialects --check`, which reports the failure with
 * a sentence.
 */
export function compileDialect(raw: unknown): PluralDialect | null {
  if (!raw || typeof raw !== 'object') return null
  const row = { ...(raw as Record<string, unknown>) } as unknown as PluralDialect
  try {
    const where = row.where as { path?: unknown } | undefined
    if (where && typeof where.path === 'string') where.path = toRegExp(where.path)
    const read = row.read as { split?: { kind?: string; re?: unknown } }
    if (read?.split?.kind === 'path-regex' && typeof read.split.re === 'string') {
      read.split.re = toRegExp(read.split.re)
    }
  } catch {
    return null
  }
  return { ...row, declaredBy: 'project' }
}

function toRegExp(source: string): RegExp {
  if (source.length > MAX_PATTERN) throw new Error('pattern too long')
  if (CATASTROPHIC.test(source)) throw new Error('nested quantifier')
  return new RegExp(source)
}

export interface CheckContext {
  shipped: PluralDialect[]
  project: PluralDialect[]
  sites: Site[]
  /** `detectFamilies` bound to this repository, so the two runs are comparable. */
  detect: (dialects: PluralDialect[]) => DetectedFamily[]
}

export function checkDialects(ctx: CheckContext): DialectProblem[] {
  const problems: DialectProblem[] = []
  const shippedIds = new Set(ctx.shipped.map((d) => d.id))
  const seen = new Set<string>()
  const maxShipped = Math.max(0, ...ctx.shipped.map((d) => d.precedence))

  for (const d of ctx.project) {
    const say = (problem: string): void => void problems.push({ dialect: d.id ?? '(unnamed)', problem })

    if (!d.id || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(d.id)) {
      say('id must be dotted lowercase, e.g. polyglot.quad-pipe')
    }
    if (seen.has(d.id)) say('duplicate dialect id')
    seen.add(d.id)
    if (shippedIds.has(d.id) && !d.overrides?.includes(d.id)) {
      say(`this id is already shipped — name it in \`overrides\` to replace it deliberately`)
    }

    // No network, ever. This checks the SHAPE of a citation, not the citation:
    // a well-formed URL to a page that does not exist passes, and the only thing
    // between that and a shipped lie is a human reading the diff — the same
    // protection `glossary.md` has.
    if (!d.docs || !/^https?:\/\/[^\s"'<>]+$/.test(d.docs)) {
      say('needs a `docs` http(s) URL to the runtime\'s own documentation — a row without a citation is a hunch')
    }

    const primitive = d.primitive && PRIMITIVES[d.primitive]
    if (!primitive) {
      say(`unknown primitive ${String(d.primitive)} — a primitive is TypeScript and a row cannot write one`)
      continue
    }
    if ((d.read as { primitive?: string })?.primitive !== d.primitive) {
      say(`read.primitive must be ${d.primitive}`)
    }
    for (const problem of primitive.validate(d.read)) say(problem)

    // A positional scheme cannot know CLDR by construction: `order` says "the
    // second part", never `few`. Claiming otherwise makes the engine report
    // rendering bugs that do not exist.
    //
    // Note this is NOT "tokens must be CLDR names": i18next legitimately maps
    // `singular` to `one` and is `cldr: true`.
    if (d.cldr && (d.read as { order?: unknown }).order) {
      say('`cldr` cannot be true for a scheme whose selectors are positions — `order` names an index, not a grammar')
    }

    if (d.evidence?.mode === 'declared') {
      const e = d.evidence as { dependency?: string[]; configFile?: string[]; importOf?: string[] }
      if (!e.dependency?.length && !e.configFile?.length && !e.importOf?.length) {
        say('`declared` evidence must name a dependency, a config file or an import, or it can never apply')
      }
    }

    if (typeof d.precedence !== 'number') say('needs a numeric `precedence`')
    else if (d.precedence < maxShipped && !d.overrides?.length) {
      say(`precedence ${d.precedence} preempts a shipped dialect — name what it overrides, or move it above ${maxShipped}`)
    }
  }

  if (problems.length) return problems
  return [...problems, ...claimAndRegression(ctx)]
}

/**
 * The two checks that need the repository, run together because they need the
 * same pair of detection passes.
 *
 * CLAIM — a row must claim at least one site the shipped catalog did not. A row
 * that claims nothing here is speculation about somebody else's repository, and
 * accepting it means shipping an arrangement nobody has ever seen work.
 *
 * REGRESSION — every family the shipped catalog found must still exist, with the
 * same anchor and the same categories. This is the one that matters: the claim
 * test is satisfied by a row that steals `item_one`/`item_other` from the
 * i18next dialect and re-reads them wrongly, and only comparing the two runs
 * catches it.
 */
function claimAndRegression(ctx: CheckContext): DialectProblem[] {
  const problems: DialectProblem[] = []
  const before = ctx.detect(ctx.shipped)
  const after = ctx.detect([...ctx.shipped, ...ctx.project])

  const claimedBefore = new Set(before.flatMap((f) => f.sites))
  const byDialect = new Map<string, number>()
  for (const family of after) {
    if (family.sites.some((id) => !claimedBefore.has(id))) {
      byDialect.set(family.dialect, (byDialect.get(family.dialect) ?? 0) + 1)
    }
  }
  for (const d of ctx.project) {
    if (!byDialect.get(d.id)) {
      problems.push({
        dialect: d.id,
        problem: 'claims nothing in this repository — a dialect is a description of what is here, not a guess about elsewhere',
      })
    }
  }

  const afterByAnchor = new Map(after.map((f) => [`${f.file}#${f.base}`, f]))
  for (const family of before) {
    const anchor = `${family.file}#${family.base}`
    const still = afterByAnchor.get(anchor)
    const categories = (f: DetectedFamily): string => f.forms.map((x) => x.category).sort().join(',')
    if (!still) {
      problems.push({ dialect: owner(ctx, anchor), problem: `${anchor} was a family and is no longer one` })
    } else if (categories(still) !== categories(family)) {
      problems.push({
        dialect: still.dialect,
        problem: `${anchor} used to read [${categories(family)}] and now reads [${categories(still)}]`,
      })
    }
  }
  return problems
}

function owner(ctx: CheckContext, anchor: string): string {
  return ctx.project.map((d) => d.id).join(', ') || anchor
}

/** Every category named anywhere in a row, for a quick sanity report. */
export function categoriesNamed(dialect: PluralDialect): string[] {
  const read = dialect.read as { tokens?: Record<string, string>; order?: Record<number, string[]> }
  const out = new Set<string>()
  for (const c of Object.values(read.tokens ?? {})) if (isCategory(c)) out.add(c)
  for (const cats of Object.values(read.order ?? {})) for (const c of cats) if (isCategory(c)) out.add(c)
  return [...out]
}
