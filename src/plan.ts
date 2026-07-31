// plan: turn an inventory into work.
//
// The unit of work is a GROUP, never a site. The same sentence at four sites
// must get one translation, and making the group the unit means divergence is
// not representable rather than merely detected — there is no reconciliation
// pass that can fail to run.
//
// Grouping on text alone is the trap. In a real repository `'done'` is both a
// rendered label and a persisted enum value, so one translation for both
// silently invalidates every existing user's stored data. Hence the key is
// (text × roleClass × translatabilityClass), and a text carrying two
// incompatible verdicts becomes a HAZARD the engine refuses to plan at all.
import type { Inventory, Site, Surface } from './types'
import { sha256, normalizeForGrouping } from './identity'
import type { Category, PluralFamily, WriteMode } from './plural'

/** Register vocabulary handed to a translator. One token replaces a paragraph of instructions. */
export type Role =
  | 'button' | 'link' | 'tab' | 'menu-item' | 'label'
  | 'paragraph' | 'list-item' | 'doc-prose' | 'tooltip'
  | 'aria-label' | 'alt' | 'title-attr'
  | 'status' | 'error' | 'heading' | 'doc-heading'

/** Roles that may share a translation. `Focus` as a button and as a link must not diverge. */
export type RoleClass = 'ui-short' | 'ui-long' | 'a11y' | 'doc'

export type GroupStatus = 'pending' | 'memo' | 'hazard' | 'structural' | 'skip'

/**
 * A plural family as a unit of work.
 *
 * This is the field that makes plurals possible at all. Everywhere else a group
 * is one source text and one target text, and that shape simply cannot express
 * the operation: English has two forms and Russian needs four, so there is no
 * single string to return. The family carries every form in and expects every
 * form the TARGET requires back.
 *
 * `op` distinguishes the two jobs that look alike from the outside. Translating
 * an English family into Russian is one. COMPLETING a Russian family that only
 * ever had `one` and `other` — a bug already rendering the wrong string for 2,
 * 3 and 4 — is the other, and a translator told to "translate ru to ru" would
 * rightly be confused by it.
 */
export interface PluralPlan {
  familyId: string
  shape: string
  writeMode: WriteMode
  op: 'translate' | 'complete'
  locale: string | null
  /** Source forms, keyed by CLDR category. */
  forms: Record<string, string>
  sourceCategories: Category[]
  /** Exactly the keys the answer must come back with. */
  targetCategories: Category[]
  /** `=0`-style ICU branches, carried through untouched. */
  exact: { selector: string; value: string }[]
  /** Placeholders that appear somewhere in the source forms. */
  placeholders: string[]
}

export interface Group {
  id: string
  text: string
  role: Role
  roleClass: RoleClass
  status: GroupStatus
  /** Character budget for the target, when the host constrains it. */
  max: number | null
  /** Placeholder indices the translation must preserve exactly. */
  holes: number[]
  /** Gloss per hole, derived from the expression, for a translator with no file access. */
  holeGloss: Record<string, string>
  /** Sites this group will patch. */
  sites: string[]
  /** Test assertions that must move with it, or CI goes red on a correct repo. */
  mirrors: string[]
  /** Set when status is hazard or structural: why the engine will not plan it. */
  blocked?: string
  /** Populated for `memo`: where the translation came from without a model call. */
  memo?: { text: string; origin: 'glossary' | 'tm' }
  /** Set when this group is a plural family rather than a single string. */
  plural?: PluralPlan
}

export interface Plan {
  schemaVersion: 1
  sourceLang: string
  targetLang: string
  mode: 'audit' | 'swap' | 'i18n' | 'sync'
  groups: Group[]
  hazards: Group[]
  structural: Group[]
  /** Test literals in an assertion position that match no group — these block a run. */
  unlinked: { file: string; line: number; value: string }[]
  counts: {
    sites: number
    groups: number
    toTranslate: number
    memo: number
    hazard: number
    structural: number
    skipped: number
    plural: number
    /** Families that will gain forms their locale requires and does not have. */
    pluralCompleting: number
  }
}

export interface PlanOptions {
  mode?: Plan['mode']
  /** Human-authored term store: source text → target text. Wins over everything. */
  glossary?: Map<string, string>
  /** Machine translation memory from previous runs. */
  tm?: Map<string, string>
}

const TEST_FILE = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|e2e)\//

export function plan(inv: Inventory, opts: PlanOptions = {}): Plan {
  const mode = opts.mode ?? 'swap'
  const glossary = opts.glossary ?? new Map()
  const tm = opts.tm ?? new Map()

  // A site that is one form of a plural family is never grouped on its own.
  // Grouping it by text would put `{{count}} item` and `{{count}} items` in
  // two unrelated batches, and no answer to either can be right without the
  // other: the target decides how many forms there are.
  const families = (inv.plurals ?? []) as PluralFamily[]
  const familySites = new Set(families.flatMap((f) => f.sites))

  const translatable = inv.sites.filter((s) => s.verdict === 'translate' && !familySites.has(s.id))
  const excluded = inv.sites.filter((s) => s.verdict === 'do-not-translate')

  // A text asserted as copy in one place and as an IDENTIFIER in another is the
  // dual-use hazard, seen from the planning side. Detect it before grouping so
  // it never reaches a batch.
  //
  // Only genuine conflicts count. A test fixture holding the same words is not
  // a conflict — it is a mirror, and mirrors are meant to move WITH the copy
  // they assert. Treating them as conflicts would make every well-tested string
  // unplannable, which is precisely backwards: the better the test coverage,
  // the less the tool could do.
  const CONFLICTING = new Set([
    'identifier', 'module-specifier', 'enum-member', 'persisted-value',
    'api-contract', 'interop-format',
  ])
  const conflicting = excluded.filter((s) => s.reason !== null && CONFLICTING.has(s.reason))
  const excludedText = new Set(conflicting.map((s) => normalizeForGrouping(s.value)))

  const byKey = new Map<string, Site[]>()
  for (const site of translatable) {
    const key = groupKey(site)
    const list = byKey.get(key)
    if (list) list.push(site)
    else byKey.set(key, [site])
  }

  const groups: Group[] = []
  for (const [key, sites] of [...byKey.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const first = sites[0]!
    const normalized = normalizeForGrouping(first.value)
    const role = roleOf(first)
    const group: Group = {
      id: 'g_' + key.slice(0, 12),
      text: first.value,
      role,
      roleClass: classOf(role),
      status: 'pending',
      max: first.constraints.maxLength ?? maxFor(role, first.value),
      holes: first.constraints.mustKeepHoles,
      holeGloss: glossFor(sites),
      sites: sites.map((s) => s.id),
      mirrors: [],
    }

    if (first.holes.some((h) => h.grammar)) {
      group.status = 'structural'
      group.blocked =
        'a plural or agreement rule is baked into the interpolation; the target language may need a different number of agreement sites, so this needs a code edit rather than a translated string'
    } else if (excludedText.has(normalized)) {
      group.status = 'hazard'
      group.blocked = `the same text is an identifier elsewhere (${conflicting
        .filter((s) => normalizeForGrouping(s.value) === normalized)
        .slice(0, 3)
        .map((s) => `${s.file}:${s.line}`)
        .join(', ')}); translating both would break the identifier, translating neither leaves the label untranslated`
    } else {
      const hit = glossary.get(first.value) ?? tm.get(memoKey(first.value, group.roleClass))
      if (hit !== undefined) {
        group.status = 'memo'
        group.memo = {
          text: hit,
          origin: glossary.has(first.value) ? 'glossary' : 'tm',
        }
      }
    }

    groups.push(group)
  }

  const bySiteId = new Map(inv.sites.map((s) => [s.id, s]))
  for (const family of families) {
    const group = pluralGroup(family, inv.targetLanguage, bySiteId)
    if (group) groups.push(group)
  }

  attachMirrors(groups, inv)

  const unlinked = findUnlinked(inv, groups)

  const pending = groups.filter((g) => g.status === 'pending')
  const plural = groups.filter((g) => g.plural)
  return {
    schemaVersion: 1,
    sourceLang: inv.sourceLanguage ?? 'unknown',
    targetLang: inv.targetLanguage,
    mode,
    groups,
    hazards: groups.filter((g) => g.status === 'hazard'),
    structural: groups.filter((g) => g.status === 'structural'),
    unlinked,
    counts: {
      sites: inv.sites.length,
      groups: groups.length,
      toTranslate: pending.length,
      memo: groups.filter((g) => g.status === 'memo').length,
      hazard: groups.filter((g) => g.status === 'hazard').length,
      structural: groups.filter((g) => g.status === 'structural').length,
      skipped: inv.sites.length - groups.reduce((n, g) => n + g.sites.length, 0),
      plural: plural.length,
      pluralCompleting: plural.filter((g) => g.plural!.op === 'complete').length,
    },
  }
}

/**
 * One group per plural family, or none.
 *
 * A family is planned when its sites are translatable, and separately when an
 * ANNOTATION declared it — because an annotated family sits on a site the
 * engine has verdicted `grammar-hole`, which is a refusal to translate the
 * string, not a refusal to act on forms someone supplied by hand.
 */
function pluralGroup(
  family: PluralFamily,
  targetLang: string,
  bySiteId: Map<string, Site>,
): Group | null {
  const sites = family.sites.map((id) => bySiteId.get(id)).filter((s): s is Site => s !== undefined)
  if (sites.length === 0) return null

  const translatable = sites.some((s) => s.verdict === 'translate')
  if (!translatable && family.declaredBy !== 'annotation') return null

  const targetCategories = family.targetRequired ?? family.sourceCategories
  const forms: Record<string, string> = {}
  for (const form of family.forms) forms[form.category] = form.value

  // A family already in the target locale is not being translated, it is being
  // COMPLETED — which is a different instruction, and one the model needs.
  const op = family.locale === targetLang ? 'complete' : 'translate'

  const canonical = forms.other ?? family.forms[0]?.value ?? ''
  const group: Group = {
    id: 'g_' + family.id.slice(3, 15),
    text: canonical,
    role: 'label',
    roleClass: 'ui-short',
    status: 'pending',
    max: null,
    holes: [],
    holeGloss: {},
    sites: family.sites,
    mirrors: [],
    plural: {
      familyId: family.id,
      shape: family.shape,
      writeMode: family.writeMode,
      op,
      locale: family.locale,
      forms,
      sourceCategories: family.sourceCategories,
      targetCategories,
      exact: family.exact,
      placeholders: placeholdersIn(Object.values(forms)),
    },
  }

  // A family needing a code edit is still translated: the forms are what the
  // structural worklist is FOR, and withholding them would leave whoever makes
  // that edit to translate by hand.
  if (family.writeMode === 'code-edit') {
    group.blocked =
      family.blocked ?? 'the forms cannot be written mechanically here; they go to the structural worklist'
  }

  return group
}

const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}|\{\d+\}|\{[\w.]+\}|%\{[\w.]+\}|%\d*\$?[sd@]|#/g

/** Every placeholder token appearing in any source form, deduplicated. */
export function placeholdersIn(values: string[]): string[] {
  const out = new Set<string>()
  for (const value of values) {
    for (const m of value.matchAll(PLACEHOLDER)) out.add(m[0])
  }
  return [...out].sort()
}

/**
 * Case is preserved and role CLASS (not role) is part of the key.
 *
 * Preserved case, because `focus: 'Focus'` puts a persisted enum and a display
 * label one token apart. Role class rather than role, because a word used on a
 * button and on a link must not diverge, while the same word in a button and in
 * a paragraph legitimately may.
 */
export function groupKey(site: Site): string {
  const role = classOf(roleOf(site))
  const translatability = site.holes.length > 0 ? 'holes' : 'plain'
  return sha256(`${normalizeForGrouping(site.value)}\0${role}\0${translatability}`)
}

export function memoKey(text: string, roleClass: RoleClass): string {
  return sha256(`${normalizeForGrouping(text)}\0${roleClass}`)
}

export function roleOf(site: Site): Role {
  const attr = site.evidence.siblingKeys // unused, kept for shape parity
  void attr
  switch (site.surface as Surface) {
    case 'doc.markdown-prose':
    case 'doc.changelog':
      return site.kind === 'prose-run' && /^#/.test(site.raw) ? 'doc-heading' : 'doc-prose'
    case 'ui.release-notes':
      return 'doc-prose'
    case 'meta.head':
    case 'meta.package.description':
    case 'meta.webmanifest':
    case 'meta.extension-manifest':
    case 'meta.oci-label':
    case 'meta.store-listing':
      return 'paragraph'
    case 'comment.line':
    case 'comment.block':
    case 'comment.docstring':
      return 'doc-prose'
    case 'error.message':
      return 'error'
    case 'log.message':
      return 'status'
    case 'ui.issue-form':
      return 'label'
    case 'ui.attribute-text':
      return 'aria-label'
    case 'ui.jsx-text':
      return site.value.length > 48 ? 'paragraph' : 'button'
    default:
      return site.value.length > 48 ? 'paragraph' : 'label'
  }
}

export function classOf(role: Role): RoleClass {
  switch (role) {
    case 'button': case 'link': case 'tab': case 'menu-item': case 'label': case 'heading':
      return 'ui-short'
    case 'aria-label': case 'alt': case 'title-attr':
      return 'a11y'
    case 'doc-prose': case 'doc-heading':
      return 'doc'
    default:
      return 'ui-long'
  }
}

/**
 * A character budget for the target.
 *
 * French runs 15–20% longer than English, and a button label that overflows its
 * container is a visible regression the translator cannot see. Only short UI
 * roles get a budget: constraining a paragraph would trade a real problem for
 * an invented one.
 */
function maxFor(role: Role, source: string): number | null {
  const roleClass = classOf(role)
  if (roleClass !== 'ui-short') return null
  return Math.ceil(source.length * 1.35) + 4
}

function glossFor(sites: Site[]): Record<string, string> {
  const gloss: Record<string, string> = {}
  for (const site of sites) {
    for (const hole of site.holes) {
      if (gloss[hole.index] !== undefined) continue
      // `task.title` → "task title". Enough for word order, and it costs four
      // tokens rather than a file.
      gloss[hole.index] = hole.expr
        .replace(/[.[\]]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .slice(-4)
        .join(' ')
    }
  }
  return gloss
}

/**
 * Attach test assertions to the group they mirror.
 *
 * A test asserting `'Yes, erase it all'` has to change in the same commit as
 * the button it asserts, or CI goes red on an otherwise-correct repository.
 * Mirrors form no group of their own; they ride the group whose text they match
 * and are written in the same atomic pass.
 */
function attachMirrors(groups: Group[], inv: Inventory): void {
  const byText = new Map<string, Group>()
  for (const g of groups) byText.set(normalizeForGrouping(g.text), g)

  for (const site of inv.sites) {
    if (site.reason !== 'test-fixture') continue
    const group = byText.get(normalizeForGrouping(site.value))
    if (group) group.mirrors.push(site.id)
  }
}

/**
 * Test literals that assert copy but match no group.
 *
 * The engine cannot tell one of these from a legitimately untranslatable
 * fixture, and getting it wrong means a red build on a correct translation. So
 * they are reported and they block the run, rather than being guessed at.
 */
function findUnlinked(inv: Inventory, groups: Group[]): Plan['unlinked'] {
  const known = new Set(groups.map((g) => normalizeForGrouping(g.text)))
  const out: Plan['unlinked'] = []
  for (const site of inv.sites) {
    if (!TEST_FILE.test(site.file)) continue
    if (site.reason !== 'test-fixture') continue
    const normalized = normalizeForGrouping(site.value)
    if (known.has(normalized)) continue
    // Two words, or one long one: below that it is a token, not copy.
    if (!/\p{L}{2,}\s+\p{L}{2,}/u.test(site.value) && site.value.length < 8) continue
    out.push({ file: site.file, line: site.line, value: site.value })
  }
  return out
}

export function formatPlan(p: Plan): string {
  const lines: string[] = []
  lines.push(`ultrai18n plan  ${p.sourceLang} → ${p.targetLang}  (${p.mode})`)
  lines.push('')
  lines.push(
    `  ${p.counts.sites} sites → ${p.counts.groups} groups: ` +
      `${p.counts.toTranslate} to translate, ${p.counts.memo} already known`,
  )
  if (p.counts.plural) {
    lines.push(
      `  ${p.counts.plural} plural family(ies)` +
        (p.counts.pluralCompleting
          ? `, ${p.counts.pluralCompleting} of them being completed for a locale that already needs more forms than it has`
          : ''),
    )
  }

  if (p.hazards.length) {
    lines.push('')
    lines.push(`HAZARDS (${p.hazards.length}) — not planned; the engine will not guess these`)
    for (const g of p.hazards) lines.push(`  ${JSON.stringify(g.text)}\n      ${g.blocked}`)
  }
  if (p.structural.length) {
    lines.push('')
    lines.push(`STRUCTURAL (${p.structural.length}) — needs a code edit, not a translation`)
    for (const g of p.structural) lines.push(`  ${JSON.stringify(g.text)}\n      ${g.blocked}`)
  }
  if (p.unlinked.length) {
    lines.push('')
    lines.push(`UNLINKED TEST LITERALS (${p.unlinked.length}) — assert copy but match no group`)
    for (const u of p.unlinked.slice(0, 10)) lines.push(`  ${u.file}:${u.line}  ${JSON.stringify(u.value)}`)
  }
  return lines.join('\n')
}
