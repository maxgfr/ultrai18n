// Assembling families: shapes and annotations in, one accounted-for record out.
//
// Everything the rest of the pipeline needs to know about a plural lives here,
// and two of the fields are the whole reason the feature is worth building.
//
// `ownRequired` is what the family's OWN locale demands, and comparing it with
// what is actually written is how a bug already sitting in the repository gets
// found: a Russian bundle with only `_one` and `_other` renders the wrong string
// for 2, 3 and 4, today, with no translation involved. That is the same class of
// finding as `sync`'s arity mismatch, and it is worth more than anything the
// translation half of this tool does.
//
// `targetRequired` is what the language being translated INTO demands, and it is
// why a plural cannot be an ordinary group: en→ru turns two forms into four, and
// no 1-text-in-1-text-out pipeline can express that.
import { sha1 } from '../identity'
import type { Site } from '../types'
import { categoriesFor, ordinalCategoriesFor, sortCategories, type Category } from './cldr'
import {
  detectFamilies,
  type DetectOptions,
  type DetectedFamily,
  type PluralForm,
  type PluralShapeId,
} from './shapes'
import { DIALECTS_BY_ID } from './dialect/dialects'
import type { PluralDialect, PrimitiveId } from './dialect/types'
import { compileGlobs } from '../vendor/glob'
import { syntaxFor } from '../escape'
import { splitPluralKey } from './shapes'
import { readPragmas, readSidecar, type AnnotatedFamily } from './annotate'

export type { Category } from './cldr'
export type { PluralForm, PluralShapeId } from './shapes'
export type { PluralDialect, PrimitiveId } from './dialect/types'
export { splitPluralKey, mergeDialects, detectFamilies } from './shapes'
export { DIALECTS, DIALECTS_BY_ID } from './dialect/dialects'
export { PRIMITIVES, ordered } from './primitives'
export { categoriesFor, ordinalCategoriesFor, pluralTier, resetPluralTier, isSingleForm } from './cldr'
export { scanIcu, serializeArgument, splice, branchPlaceholders, looksLikeIcu } from './icu'
export { readPragmas, readSidecar, danglingSidecarKeys, parseFields, PRAGMA } from './annotate'

/**
 * How a completed family gets written back.
 *
 *  - `replace`  — the whole family lives in one value span; rewrite it.
 *  - `insert`   — each form is its own key; a new form is a new sibling.
 *  - `code-edit`— no mechanical write is sound here. Reported, never guessed.
 */
export type WriteMode = 'replace' | 'insert' | 'code-edit'

export interface PluralFamily {
  id: string
  file: string
  /** `file#base` — structural, and stable across the text being translated. */
  anchor: string
  base: string
  shape: PluralShapeId
  /**
   * The dialect that claimed this family.
   *
   * The traceability field: every family is citable back to a documented row,
   * exactly as every site is citable back to a catalog rule. `null` for an
   * annotation, which came from a person rather than from a rule.
   */
  dialect: string | null
  /** Which mechanical arrangement was read. `null` for an annotation. */
  primitive: PrimitiveId | null
  declaredBy: 'shape' | 'annotation'
  /** The locale the family is WRITTEN in, from the file path. */
  locale: string | null
  forms: PluralForm[]
  /** `=0`-style ICU branches, carried through untouched. */
  exact: { selector: string; value: string }[]
  sourceCategories: Category[]
  /** What this family's own locale requires. Null when no tier could say. */
  ownRequired: Category[] | null
  /** What the target locale requires — the shape the translation must take. */
  targetRequired: Category[] | null
  /** Required by its own locale and absent: a live rendering bug. */
  missing: Category[]
  /** Present and not required by its own locale: a form that never renders. */
  extra: Category[]
  sites: string[]
  ordinal: boolean
  writeMode: WriteMode
  /** `insert` only: how to spell a new key, with `{category}` for the form. */
  keyTemplate: string | null
  /** `insert` only: the form whose entry a new sibling is written after. */
  insertAfterSiteId: string | null
  /** The counting expression, when an annotation named one. */
  count: string | null
  /**
   * `replace` only: how the forms rejoin.
   *
   * Carried rather than assumed. `' | '` was hardcoded, which is vue-i18n's
   * separator and nobody else's — a Polyglot family rewritten with it silently
   * becomes one string its own runtime reads as a single form.
   */
  join: string | null
  /** Set when the family cannot be completed mechanically. */
  blocked?: string
}

export interface AssembleOptions {
  sites: Site[]
  targetLanguage: string
  sourceLanguage: string | null
  /** Locale a file's path declares — `scan`'s `fileLocale`. */
  fileLocale: (file: string) => string | null
  /** True when the file is a locale catalog. */
  isBundle: (file: string) => boolean
  /** Path to `.ultrai18n/plurals.json`, when one exists. */
  sidecarPath?: string
  /** Project dialects, merged over the shipped catalog. */
  dialects?: PluralDialect[]
  /** Dialect ids the repository's evidence rules out. */
  inert?: Set<string>
}

export interface AssembleResult {
  families: PluralFamily[]
  /** Site ids belonging to some family, so `scan` can re-surface them. */
  memberSites: Map<string, { familyId: string; category: Category }>
  /** Comment sites carrying a pragma: directives, not prose. */
  pragmaSites: Set<string>
}

export function assembleFamilies(opts: AssembleOptions): AssembleResult {
  const detectOpts: DetectOptions = {
    isBundle: opts.isBundle,
    ...(opts.dialects ? { dialects: opts.dialects } : {}),
    ...(opts.inert ? { inert: opts.inert } : {}),
  }
  const detected = detectFamilies(opts.sites, detectOpts)

  const annotated = [
    ...readPragmas(opts.sites),
    ...(opts.sidecarPath ? readSidecar(opts.sidecarPath, opts.sites) : []),
  ]

  const byId = new Map(opts.sites.map((s) => [s.id, s]))
  const families: PluralFamily[] = []
  const claimed = new Set<string>()

  // Annotations win over shapes. Someone said so explicitly; that outranks
  // anything derived, and it is the only way to correct a shape that guessed.
  for (const a of annotated) {
    families.push(fromAnnotation(a, byId, opts))
    claimed.add(a.siteId)
  }
  for (const d of detected) {
    if (d.sites.some((id) => claimed.has(id))) continue
    families.push(fromDetected(d, opts))
    for (const id of d.sites) claimed.add(id)
  }

  families.sort((a, b) => (a.anchor < b.anchor ? -1 : a.anchor > b.anchor ? 1 : 0))

  const memberSites = new Map<string, { familyId: string; category: Category }>()
  for (const family of families) {
    for (const form of family.forms) {
      // A one-site family (ICU, delimited) has every form on the same site;
      // the first category wins as that site's label, and the family carries
      // the rest.
      if (!memberSites.has(form.siteId)) {
        memberSites.set(form.siteId, { familyId: family.id, category: form.category })
      }
    }
  }

  return {
    families,
    memberSites,
    pragmaSites: new Set(annotated.map((a) => a.pragmaSiteId).filter((id): id is string => id !== null)),
  }
}

// ---------------------------------------------------------------------------

function fromDetected(d: DetectedFamily, opts: AssembleOptions): PluralFamily {
  const locale = opts.fileLocale(d.file) ?? opts.sourceLanguage
  const sourceCategories = sortCategories(d.forms.map((f) => f.category))
  const ownRequired = locale ? categoriesFor(locale) : null

  // What the answer must come back with, which is not always the cardinal set.
  //
  //  - An ORDINAL family follows the ordinal rules: English wants four there
  //    and two for cardinals.
  //  - A family whose dialect declares `cldr: false` follows its own runtime's
  //    scheme, so the only defensible target is the arity it already has.
  //    Handing vue-i18n four Russian categories produces a string it cannot
  //    index; handing gettext a `few` claims something only its own header
  //    could say.
  const targetRequired = d.ordinal
    ? ordinalCategoriesFor(opts.targetLanguage) ?? sourceCategories
    : !d.cldr
      ? sourceCategories
      : categoriesFor(opts.targetLanguage)

  const { writeMode, keyTemplate, insertAfterSiteId, blocked } = writePlan(d, opts)

  // Some families are detected, translated and reported, but never measured
  // against CLDR — because CLDR is not the rule they follow.
  //
  //  - An ORDINAL family answers to the ordinal rule set, where English has
  //    four forms and its cardinals have two. Gating one on the other invents
  //    a failure.
  //  - A POSITIONAL or INDEXED family answers to its runtime. A three-part
  //    English vue-i18n string is correct and would read as a spurious `zero`.
  const cldrApplies = !d.ordinal && d.cldr && ownRequired !== null

  return {
    id: familyId(d.file, d.base),
    file: d.file,
    anchor: `${d.file}#${d.base}`,
    base: d.base,
    shape: d.shape,
    dialect: d.dialect,
    primitive: d.primitive,
    declaredBy: 'shape',
    locale,
    forms: d.forms,
    exact: d.exact,
    sourceCategories,
    ownRequired,
    targetRequired,
    missing: cldrApplies ? ownRequired!.filter((c) => !sourceCategories.includes(c)) : [],
    extra: cldrApplies ? sourceCategories.filter((c) => !ownRequired!.includes(c)) : [],
    sites: [...new Set(d.sites)],
    ordinal: d.ordinal,
    writeMode,
    keyTemplate,
    insertAfterSiteId,
    count: null,
    join: joinFor(d),
    ...(blocked ? { blocked } : {}),
  }
}

function fromAnnotation(
  a: AnnotatedFamily,
  byId: Map<string, Site>,
  opts: AssembleOptions,
): PluralFamily {
  const site = byId.get(a.siteId)!
  const locale = opts.fileLocale(a.file) ?? opts.sourceLanguage
  // An annotation with no explicit forms still declares the site a plural. Its
  // single form is what is written there now, and completing it needs a code
  // edit — which is the honest answer for a rule baked into an expression.
  const forms: PluralForm[] =
    a.forms.length > 0
      ? a.forms
      : [{ category: 'other', selector: 'other', siteId: a.siteId, value: site.value }]

  const sourceCategories = sortCategories(forms.map((f) => f.category))
  const ownRequired = a.categories ?? (locale ? categoriesFor(locale) : null)
  const targetRequired = a.categories ?? categoriesFor(opts.targetLanguage)

  return {
    id: familyId(a.file, a.siteKey),
    file: a.file,
    anchor: a.siteKey,
    base: a.siteKey.slice(a.siteKey.indexOf('#') + 1),
    shape: 'annotation',
    // An annotation came from a person, not from a rule, and the inventory has
    // always kept those distinguishable.
    dialect: null,
    primitive: null,
    declaredBy: 'annotation',
    locale,
    forms,
    exact: [],
    sourceCategories,
    ownRequired,
    targetRequired,
    missing: ownRequired ? ownRequired.filter((c) => !sourceCategories.includes(c)) : [],
    extra: [],
    sites: [a.siteId],
    ordinal: false,
    count: a.count,
    join: null,
    ...declaredWritePlan(a, site),
  }
}

/**
 * How a DECLARED family is written back.
 *
 * This used to be unconditional: every pragma and every sidecar entry became
 * `code-edit`, so a declaration landing on a JSON scalar in a locale bundle —
 * where inserting a sibling key is exactly what `apply` already does — could
 * never be written mechanically. Nothing downstream required that. `writeFamily`
 * has always handled `insert` for any family carrying `keyTemplate` and
 * `insertAfterSiteId`; `fromAnnotation` was the only thing withholding them.
 *
 * The default is derived from the FORMAT rather than from the origin, and the
 * test is `syntaxFor` — the same one `apply` applies. Deriving it any other way
 * lets `plan` and `apply` disagree about the same site.
 */
function declaredWritePlan(
  a: AnnotatedFamily,
  site: Site,
): Pick<PluralFamily, 'writeMode' | 'keyTemplate' | 'insertAfterSiteId'> & { blocked?: string } {
  const blocked =
    'the forms live in an expression, so completing this family is a code edit; the translated forms are supplied in the worklist'

  if (a.write === 'replace') {
    return { writeMode: 'replace', keyTemplate: null, insertAfterSiteId: null }
  }
  if (a.write === 'code-edit') {
    return { writeMode: 'code-edit', keyTemplate: null, insertAfterSiteId: null, blocked }
  }

  const insertable = INSERTABLE_SYNTAX.has(syntaxFor(site))
  if (a.write === 'auto' && (!insertable || a.forms.length === 0)) {
    return { writeMode: 'code-edit', keyTemplate: null, insertAfterSiteId: null, blocked }
  }
  if (a.write === 'insert' && !insertable) {
    return {
      writeMode: 'code-edit',
      keyTemplate: null,
      insertAfterSiteId: null,
      blocked: `the declaration asks for an inserted key, but ${a.file} is not a format a sibling key can be written into`,
    }
  }

  return {
    writeMode: 'insert',
    keyTemplate: a.keyTemplate ?? templateFor(a.siteKey),
    insertAfterSiteId: a.siteId,
  }
}

/** The two syntaxes `apply.buildInsertion` will write a new sibling into. */
const INSERTABLE_SYNTAX = new Set(['json-string', 'yaml-scalar'])

/**
 * How a new key is spelled, read off the site the declaration points at.
 *
 * Reuses `splitPluralKey`, so a declared family in an `item_one` bundle gets
 * `item_{category}` and one under `item/one` gets `{category}` — the same two
 * answers a detected family gets, from the same function.
 */
function templateFor(siteKey: string): string {
  const path = siteKey.slice(siteKey.indexOf('#') + 1)
  const split = splitPluralKey(path)
  if (!split) return '{category}'
  if (split.separator === '/') return '{category}'
  return `${baseKey(split.base)}${split.separator}{category}`
}

/**
 * How a completed family gets written back, read off its dialect.
 *
 * This used to switch on the shape literal, which meant every new arrangement
 * needed a branch here as well as a detector. Now `write` is a field: a dialect
 * declares `replace`, `insert` or `code-edit`, and the one conditional left is
 * the format downgrade — `insert` where a sibling key can be written, and
 * `code-edit` everywhere else — because that is a property of the FILE rather
 * than of the arrangement.
 */
function writePlan(
  d: DetectedFamily,
  _opts: AssembleOptions,
): { writeMode: WriteMode; keyTemplate: string | null; insertAfterSiteId: string | null; blocked?: string } {
  const spec = d.write

  if (!spec || spec.mode === 'code-edit') {
    return {
      writeMode: 'code-edit',
      keyTemplate: null,
      insertAfterSiteId: null,
      ...(spec?.blocked ? { blocked: spec.blocked } : {}),
    }
  }

  // One value span holds the whole family, so adding a form is an ordinary
  // rewrite of that span.
  if (spec.mode === 'replace') {
    return { writeMode: 'replace', keyTemplate: null, insertAfterSiteId: null }
  }

  if (spec.insertableWhen && !matchesGlobs(spec.insertableWhen.file, d.file)) {
    return {
      writeMode: 'code-edit',
      keyTemplate: null,
      insertAfterSiteId: null,
      blocked: spec.blocked
        ? `${spec.blocked} — ${d.file} is neither`
        : `a new form cannot be inserted into ${d.file}`,
    }
  }

  const first = d.forms[0]
  const last = d.forms[d.forms.length - 1]
  if (!first || !last) return { writeMode: 'code-edit', keyTemplate: null, insertAfterSiteId: null }

  return {
    writeMode: 'insert',
    keyTemplate: fillTemplate(spec.keyTemplate ?? '{category}', d.base, first.selector),
    insertAfterSiteId: last.siteId,
  }
}

/**
 * How a delimited family rejoins, in this order: what the dialect declared, the
 * delimiter that actually matched (padded), then nothing.
 */
function joinFor(d: DetectedFamily): string | null {
  if (d.write.join) return d.write.join
  return d.delimiter ? ` ${d.delimiter} ` : null
}

/** `{base}` and `{sep}` resolve against the family; `{category}` stays for later. */
function fillTemplate(template: string, base: string, firstSelector: string): string {
  return template
    .replace('{base}', baseKey(base))
    .replace('{sep}', separatorOf(firstSelector))
}

const globCache = new Map<string, (rel: string) => boolean>()

function matchesGlobs(globs: string[], file: string): boolean {
  const key = globs.join(' ')
  let fn = globCache.get(key)
  if (!fn) {
    const compiled = compileGlobs(globs)
    fn = (rel: string) => (compiled ? compiled(rel) : true)
    globCache.set(key, fn)
  }
  return fn(file)
}

/** `/task/count` → `count`. The family's base without its parent path. */
function baseKey(base: string): string {
  const cut = base.lastIndexOf('/')
  return cut === -1 ? base : base.slice(cut + 1)
}

/** `_one` → `_`. Whatever the file already uses is what a new key uses. */
function separatorOf(selector: string): string {
  const first = selector[0]
  return first === '_' || first === '.' ? first : '_'
}

export function familyId(file: string, base: string): string {
  return 'pf_' + sha1(`${file}#${base}`).slice(0, 12)
}

/** The key a new form takes, for an insertable family. */
export function keyForCategory(family: PluralFamily, category: Category): string | null {
  return family.keyTemplate ? family.keyTemplate.replace('{category}', category) : null
}

/**
 * Is this family complete for its own locale?
 *
 * Deliberately not "does it have the same forms as English". A Japanese bundle
 * with one form is correct and a gate that says otherwise is noise.
 */
export function isComplete(family: PluralFamily): boolean {
  return family.missing.length === 0 && family.extra.length === 0
}
