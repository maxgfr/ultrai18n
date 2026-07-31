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

/** Register vocabulary handed to a translator. One token replaces a paragraph of instructions. */
export type Role =
  | 'button' | 'link' | 'tab' | 'menu-item' | 'label'
  | 'paragraph' | 'list-item' | 'doc-prose' | 'tooltip'
  | 'aria-label' | 'alt' | 'title-attr'
  | 'status' | 'error' | 'heading' | 'doc-heading'

/** Roles that may share a translation. `Focus` as a button and as a link must not diverge. */
export type RoleClass = 'ui-short' | 'ui-long' | 'a11y' | 'doc'

export type GroupStatus = 'pending' | 'memo' | 'hazard' | 'structural' | 'skip'

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

  const translatable = inv.sites.filter((s) => s.verdict === 'translate')
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

  attachMirrors(groups, inv)

  const unlinked = findUnlinked(inv, groups)

  const pending = groups.filter((g) => g.status === 'pending')
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
    },
  }
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
