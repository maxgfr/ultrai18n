// The inventory record and its vocabularies.
//
// Every vocabulary here is CLOSED. A free-text reason cannot be reconciled,
// counted, or gated on, and the moment one is accepted the exceptions file
// becomes a place to write prose instead of a place to record decisions.
import type { PluralFamily } from './plural'
import type { Suspicion } from './plural/suspect'

/** What kind of syntactic thing the text was found in. */
export type SiteKind =
  | 'string-literal'
  | 'template'
  | 'jsx-text'
  | 'attr'
  | 'comment'
  | 'scalar'
  | 'block-scalar'
  | 'prose-run'
  | 'key'

/** What the text IS, semantically. Drives both classification and translator register. */
export type Surface =
  // UI copy
  | 'ui.jsx-text'
  | 'ui.attribute-text'
  | 'ui.template-literal'
  | 'ui.string-literal'
  | 'ui.email'
  | 'ui.issue-form'
  | 'ui.release-notes'
  // Metadata
  | 'meta.package.description'
  | 'meta.package.keywords'
  | 'meta.webmanifest'
  | 'meta.extension-manifest'
  | 'meta.head'
  | 'meta.structured-data'
  | 'meta.oci-label'
  | 'meta.store-listing'
  | 'meta.ci'
  // Docs
  | 'doc.markdown-prose'
  | 'doc.code-fence'
  | 'doc.changelog'
  | 'doc.readme-badge'
  | 'doc.frontmatter'
  // Code-adjacent
  | 'comment.line'
  | 'comment.block'
  | 'comment.docstring'
  | 'log.message'
  | 'error.message'
  // i18n
  | 'i18n.message'
  | 'i18n.key'
  | 'i18n.plural-family'
  // Tokens — never translated
  | 'identifier.object-key'
  | 'identifier.binding'
  | 'token.enum-member'
  | 'token.storage-key'
  | 'token.api-contract'
  | 'token.style'
  | 'token.url-slug'
  // Locale
  | 'locale.declaration'
  | 'locale.format-call'
  // Legal / interop / test
  | 'legal.verbatim'
  | 'interop.column-name'
  | 'test.fixture'
  // Assets
  | 'asset.binary-text'
  | 'asset.derived'
  // Residual
  | 'residual.unclassified'

export type Verdict =
  /** Must be rewritten in the target language. */
  | 'translate'
  /** Must stay byte-identical. Always carries a DoNotTranslateReason. */
  | 'do-not-translate'
  /** Must be RETARGETED, not translated: `lang: "fr"` in an English build is a bug. */
  | 'locale-marker'
  /** The engine declines. Fails `check` until adjudicated. */
  | 'needs-judgment'
  /** Residual sweep only — the engine never even attempted. Fails `check`. */
  | 'unclassified'

export type DoNotTranslateReason =
  | 'identifier'
  | 'module-specifier'
  | 'enum-member'
  | 'persisted-value'
  | 'api-contract'
  | 'interop-format'
  | 'url-or-slug'
  | 'style-token'
  | 'aria-vocabulary'
  | 'test-fixture'
  | 'vendored-legal'
  | 'code-token'
  | 'numeric-or-symbolic'
  | 'already-target-language'
  /**
   * A locale bundle written in the SOURCE language.
   *
   * Not the same thing as `already-target-language`, and reporting it as one
   * inverted the situation: `locales/fr/common.json` on a fr→en run is the
   * source of truth, not a finished translation. It is left alone because a
   * bundle's locale is its PATH — the target gets `locales/en/`, which is
   * `sync`'s job — and rewriting it in place would delete the source text the
   * other catalogs are diffed against.
   */
  | 'source-locale-bundle'
  | 'interpolation'
  | 'explicitly-marked'
  | 'proper-noun'

export type NeedsJudgmentReason =
  | 'short-string'
  | 'ambiguous-role'
  /** Both a rendered label and a persisted value. The engine refuses to guess. */
  | 'dual-use'
  | 'no-rule'
  | 'degraded-tier'
  | 'spec-unknown'
  | 'residual'
  | 'historical'
  | 'discovery-token'
  /** A `label`-named key whose value has no word — do not "helpfully" expand it. */
  | 'label-without-prose'
  /** A plural or agreement rule baked into the expression — needs a code edit, not a string. */
  | 'grammar-hole'
  /**
   * A plural family that does not have the forms its own locale requires.
   *
   * Not a translation problem: a Russian bundle carrying only `one` and `other`
   * renders the wrong string for 2, 3 and 4 right now, in production, with
   * nothing translated.
   */
  | 'plural-incomplete'
  /** 7 or 12 short strings: calendar vocabulary, locale-dependent despite looking symbolic. */
  | 'symbol-set'
  | 'manifest-shaped-object'

export type Reason = DoNotTranslateReason | NeedsJudgmentReason

export type Tier = 'ast' | 'structural' | 'regex' | 'sweep'

/** Byte offsets into the file buffer. Never character indices — see OffsetMap. */
export interface Span {
  start: number
  end: number
}

/** One interpolation in a template literal. */
export interface Hole {
  /** Ordinal, by source position. The translator may reorder these. */
  index: number
  /** Absolute byte span of the interpolation INCLUDING its `${` and `}`. */
  span: Span
  /** Source text of the expression, for the gloss handed to the translator. */
  expr: string
  /**
   * True when the branches are string literals differing only by a suffix —
   * a plural/agreement rule baked into the expression rather than data.
   * Such sites are never batched: the target language may need a different
   * NUMBER of agreement sites, which no string substitution can express.
   */
  grammar?: boolean
}

export interface LanguageGuess {
  /** null when below the length threshold. Refusing to answer is the honest answer. */
  detected: string | null
  confidence: number
  method: 'script' | 'stopword' | 'trigram' | 'combined' | 'inherited' | 'none'
  signals: string[]
  alternatives: [string, number][]
  /** Letter count after stripping placeholders, identifiers and URLs. */
  letters: number
  bucket: 'none' | 'short' | 'medium' | 'long' | 'very-long'
  mixed: boolean
  /** siteKey of the cohort sibling this guess was inherited from. */
  inheritedFrom: string | null
}

export interface Site {
  /** `ul_` + sha1(siteKey). Short, sortable, citable in prose. */
  id: string
  /**
   * Structural anchor path — NEVER the value. Survives the value being
   * translated and lines shifting above it, which is the entire point:
   * an identity derived from content cannot survive the operation this tool
   * performs on content.
   */
  siteKey: string
  /** sha1(NFC(value)). Answers "has this changed since it was adjudicated". */
  contentHash: string
  /** Normalized, case-PRESERVED. Groups duplicated copy across files. */
  dupKey: string

  file: string
  line: number
  col: number
  endLine: number
  endCol: number
  /** Raw slice, including quotes/delimiters. What the patcher replaces. */
  span: Span
  /** The decodable interior. What the patcher rewrites. */
  valueSpan: Span
  raw: string
  /** Decoded text: escapes resolved, holes replaced by `{n}`. */
  value: string

  quote: string | null
  escapes: boolean
  /** The host file uses only ASCII, so writing a literal `é` would break its style. */
  asciiOnlyFile: boolean
  holes: Hole[]
  /** Delimiters to rebuild around a new value — a comment's marker, chiefly. */
  prefix?: string
  suffix?: string
  linePrefix?: string

  kind: SiteKind
  surface: Surface
  verdict: Verdict
  reason: Reason | null
  decidedBy: 'engine' | 'agent' | 'exception' | 'inline-pragma'
  /** Confidence in the VERDICT — deliberately separate from language confidence. */
  confidence: 'high' | 'medium' | 'low'
  /** Catalog rule id, so every decision is citable back to documented evidence. */
  rule: string | null
  hard: boolean

  extractor: string
  tier: Tier
  degraded: boolean

  lang: LanguageGuess
  flags: string[]
  constraints: { maxLength: number | null; mustKeepHoles: number[] }
  evidence: {
    nearestComment: string | null
    siblingKeys: string[]
    enumOrigins: string[]
  }
  links: {
    duplicateOf: string | null
    producedBy: string | null
    pairedTests: string[]
    mirrors: string[]
    resolvedFrom: string | null
    parentSiteId: string | null
  }
  /** Only on residual-sweep sites: which extractor owned the file, and why it did not claim this. */
  whyUnclaimed?: string
  /**
   * Back-reference to the plural family this site is a form of.
   *
   * The family is the unit of work — a target locale may need more forms than
   * the source has — so the site points at it rather than carrying the forms.
   */
  plural?: { familyId: string; category: string; shape: string }
}

export type CensusBucket = 'scanned' | 'scanned-zero' | 'skipped'

export interface CensusEntry {
  file: string
  bucket: CensusBucket
  sites?: number
  extractors?: string[]
  tier?: Tier
  degraded?: boolean
  bytesTotal?: number
  bytesClaimed?: number
  /**
   * Fraction of the file's bytes an extractor accounted for. This is what makes
   * "zero sites" a provable claim ("looked at all of it, found no text") rather
   * than an unfalsifiable one ("the lexer bailed at byte 12 and said nothing").
   */
  claimRatio?: number
  reason?: string
  /** Skipped, but a human can still read text in it: images, PDFs, video. */
  mustVerifyManually?: boolean
  producedBy?: string | null
  referencedFrom?: string[]
}

export interface Inventory {
  schemaVersion: 1
  repo: string
  sourceLanguage: string | null
  targetLanguage: string
  sites: Site[]
  census: CensusEntry[]
  advisories: Advisory[]
  limits: string[]
  recallClaim: 'full' | 'weakened'
  /**
   * Plural families, whole.
   *
   * Carried on the inventory rather than reconstructed downstream, so an agent
   * reading `--json` never has to work out which keys belong together nor how
   * many forms the target needs. The import is type-only and therefore erased,
   * so the cycle it appears to create does not exist at runtime.
   */
  plurals: PluralFamily[]
  /**
   * What looks like a plural and no dialect claimed.
   *
   * The plural counterpart of an `unclassified` site: not "this is broken" but
   * "the engine looked, saw something plural-shaped, and could not account for
   * it". It is what makes a dialect catalog checkable rather than merely
   * extensible — the loop ends when this list is empty.
   */
  pluralResidual: Suspicion[]
}

/**
 * A repo-level finding that is not attached to any one site.
 *
 * Some of the most consequential findings have no single location: "this repo
 * formats dates by hand with no Intl, so translating the strings does not
 * localize the logic" is true of a whole module and false of every individual
 * line in it. Without this channel such findings are simply not expressible,
 * and a per-site tool reports a clean run on a repo it cannot actually localize.
 */
export interface Advisory {
  id: string
  file: string | null
  message: string
  sites: string[]
}
