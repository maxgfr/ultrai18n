// A dialect says how a repository SPELLS a plural, and cites its evidence.
//
// The shape of this file is borrowed deliberately from `src/catalog/types.ts`,
// because the two solve the same problem. A surface rule says where text is
// known to live; a dialect says how a plural family is known to be written down.
// Both are DATA, both carry a required `docs` URL, and both are validated by a
// check that rejects a row asserting something it cannot cite.
//
// The reason this is data at all: "support i18next" is a commitment to one
// library's roadmap, while "read a category appended to a key in a locale
// bundle" is a commitment to an arrangement that i18next, Rails, Symfony and a
// great deal of hand-rolled code all happen to share. Written as a detector
// function, every new runtime costs TypeScript. Written as a row, most cost
// nothing at all — and a project can add its own without touching this package.
import type { Category } from '../cldr'
import type { PluralShapeId } from '../shapes'
import type { WriteMode } from '../index'

/**
 * The mechanically distinct ways a set of forms can be laid out.
 *
 * There are three, not five, and that is the load-bearing claim of the design.
 * `key-suffix`, `sibling-object` and `attr-quantity` are ONE algorithm — read
 * the category off the site's anchor path — differing only in where the path is
 * cut. What genuinely differs is whether the forms are separate sites, one
 * delimited value, or one value needing a real parser.
 */
export type PrimitiveId = 'path-part' | 'value-split' | 'icu' | 'fluent'

export interface PluralDialect {
  /** Dotted lowercase, namespaced by ecosystem — like a catalog rule id. */
  id: string
  ecosystem: string
  title: string
  /**
   * URL documenting that this arrangement means a plural. Required, always.
   *
   * A dialect without a citation is a hunch, and `dialects --check` rejects one.
   * This matters most for a row a model wrote: the engine has no network and
   * cannot verify the page exists, so the citation is what makes the claim
   * reviewable by a person instead of merely plausible.
   */
  docs: string
  primitive: PrimitiveId
  /**
   * Detection order, ascending, then by id.
   *
   * A site claimed by a lower number is never offered to a higher one. This is
   * what stops an ICU message living under a `_one` key being read twice — once
   * as ICU, once as a key-suffix family whose value happens to contain braces.
   */
  precedence: number
  where: Where
  evidence: EvidenceSpec
  read: PathPartRead | ValueSplitRead | GrammarRead
  write: WriteSpec
  /**
   * Whether CLDR governs this family.
   *
   * False for positional schemes and for gettext, whose indices answer to a C
   * expression in a file header rather than to CLDR. When false the engine never
   * computes `missing` or `extra`, and the target keeps the source's arity —
   * because reporting a Russian `few` as missing from a vue-i18n pipe string
   * would be inventing a failure.
   */
  cldr: boolean
  /** The closed reporting label this arrangement is filed under. See `shapes.ts`. */
  shape: PluralShapeId
  declaredBy: 'shipped' | 'project'
  /** A project dialect may only preempt a shipped one by naming it. */
  overrides?: string[]
  notes?: string
}

export interface Where {
  /** Globs; a leading `!` excludes. Empty means every file. */
  file?: string[]
  /**
   * Only inside a locale catalog.
   *
   * The weaker arrangements are unusable without it: a key ending in `_one` is a
   * plural form in a message bundle and a coincidence anywhere else.
   */
  bundleOnly?: boolean
  /** Extra guard on the anchor path, for a dialect owning one region of a file. */
  path?: RegExp
}

/**
 * What has to be true of the REPOSITORY before a dialect applies.
 *
 * This is the "en fonction des libs" half. Nothing in the engine reads
 * dependencies today, so `isBundleFile` is the whole evidence layer — and it
 * answers "does this path contain a locale?", never "does this repository use
 * i18next?".
 */
export type EvidenceSpec =
  /**
   * The arrangement attests to itself. `{n, plural, …}` and `<item quantity=>`
   * do not occur by accident, so no dependency is needed.
   */
  | { mode: 'intrinsic' }
  /**
   * A locale catalog is enough. `prefer` is PRECEDENCE AND CITATION, not a
   * barrier: when two catalog-strength dialects both match a site, the one whose
   * dependency is actually present wins, and `dialects --explain` can cite the
   * manifest line.
   */
  | { mode: 'catalog'; prefer?: EvidenceNames }
  /**
   * A named dependency, config file or import MUST be present, or the dialect is
   * inert. This is what keeps Polyglot's `||||` from eating any string with four
   * pipes in a repository that has never heard of Polyglot.
   */
  | ({ mode: 'declared' } & EvidenceNames)

export interface EvidenceNames {
  dependency?: string[]
  configFile?: string[]
  importOf?: string[]
}

// ---------------------------------------------------------------------------
// Per-primitive parameters. Every hardcoded table in the old `shapes.ts` lands
// in one of these three blocks.

export interface PathPartRead {
  primitive: 'path-part'
  /**
   * Where the anchor path is cut into (base, token).
   *
   *  - `leaf-suffix`  — `item_one`, `item.one`. i18next, Rails, hand-rolled.
   *  - `leaf-is-token`— `item/one`. The category is a child key; the separator
   *                     just happens to be the path delimiter.
   *  - `path-regex`   — anything structural, e.g. Android's
   *                     `plurals[task_count]/item[one]`.
   */
  split:
    | { kind: 'leaf-suffix'; separators: string[] }
    | { kind: 'leaf-is-token' }
    | { kind: 'path-regex'; re: RegExp }
  /**
   * Native token → CLDR category.
   *
   * The ONLY place a runtime's own spelling is named. Numeric tokens are absent
   * on purpose: they collide with array indices, and guessing wrong invents a
   * form nobody wrote. A scheme whose tokens ARE numbers uses `order` instead.
   */
  tokens?: Record<string, Category>
  /**
   * Numeric token → category, keyed by how many forms the family has.
   *
   * For gettext `msgstr[0]` and Qt `<numerusform>`, where the token is a
   * position. The names are LABELS FOR AN ORDINAL POSITION, never claims about
   * grammar — which is why such a dialect sets `cldr: false`.
   */
  order?: Record<number, Category[]>
  /** Infix marking an ordinal family: i18next's `_ordinal_`. */
  ordinalInfix?: string[]
  /**
   * Distinct categories needed before this is a family. Default 1.
   *
   * Two, for `leaf-is-token`: one child called `other` is just a key, and
   * `other` is a word people use for other things.
   */
  minForms?: number
  /** How the selector reads in a report: `quantity="{token}"`. Default `{token}`. */
  selectorTemplate?: string
}

export interface ValueSplitRead {
  primitive: 'value-split'
  /** Literal, tried LONGEST FIRST so Polyglot's `||||` beats vue-i18n's `|`. */
  delimiters: string[]
  /** Part count → the categories those positions mean. Omit when `partSelector` is set. */
  order?: Record<number, Category[]>
  /**
   * Each part carries its OWN selector, so POSITION means nothing.
   *
   * Symfony writes `{0} Rien|]0,1] Un article|]1,Inf[ %count% articles`. Read
   * positionally that is a three-part `zero|one|other` family and all three
   * labels are wrong; read by selector it is `zero|one|other` for a reason.
   * The distinction is invisible until a two-part string disagrees — `{0} …|
   * ]1,Inf[ …` is `zero|other` by selector and `one|other` by position — which
   * is why the corpus pins that pair specifically.
   *
   * A part whose selector is absent from `tokens` DISQUALIFIES the whole value
   * rather than defaulting to a position. `]2,5[` has no CLDR category, and
   * inventing one is exactly the guess a cited catalog exists to prevent.
   */
  partSelector?: {
    /** Anchored at the start of a part; group 1 is the selector, the rest is the body. */
    re: RegExp
    /** Selector spelling → category. An absent spelling disqualifies the value. */
    tokens: Record<string, Category>
  }
  /**
   * A part must count something.
   *
   * Without this, `"Save | Cancel"` becomes a plural family. A plural has to
   * count, and a scheme where it does not is not one this can read.
   */
  requiresCounting?: boolean
  /** Trim each part. Default true. */
  trim?: boolean
}

export interface GrammarRead {
  primitive: 'icu' | 'fluent'
  /**
   * Whether an ordinal argument (`selectordinal`) is read as ordinal.
   *
   * Always true for ICU; named rather than assumed so a grammar that has no
   * ordinal concept can say so.
   */
  ordinals?: boolean
}

export interface WriteSpec {
  mode: WriteMode
  /** `insert` only: how to spell a new key. `{category}`, `{base}`, `{sep}`. */
  keyTemplate?: string
  /** `replace` only: how forms rejoin. Defaults to the first delimiter, padded. */
  join?: string
  /** Verbatim, when the mode is `code-edit` or `insertableWhen` fails. */
  blocked?: string
  /**
   * A format-conditional downgrade: `insert` where these globs match, and
   * `code-edit` everywhere else.
   *
   * `insert` in JSON/YAML and `code-edit` elsewhere is ONE dialect, not two.
   */
  insertableWhen?: { file: string[] }
}
