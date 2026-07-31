import type { DoNotTranslateReason, NeedsJudgmentReason, Surface, Verdict } from '../types'

/**
 * A rule says where text is known to live, and cites its evidence.
 *
 * The `docs` field is not decoration. A rule asserting "translate this" without
 * a citation is a hunch, and a catalog of hunches is exactly the guessing this
 * tool replaces — so `catalog check` rejects one.
 */
export interface Rule {
  /** Stable, namespaced. Appears on every site it decides, so a verdict is traceable. */
  id: string
  ecosystem: string
  title: string
  /** URL documenting that this location is user-visible. Required for `translate`. */
  docs?: string
  when: Matcher
  emit: Emit
  /** Sibling matchers for the same file — usually the traps beside the copy. */
  companions?: { when: Matcher; emit: Emit }[]
  /** Other rules holding the same text, so translating one and missing the rest fails a gate. */
  mirrors?: string[]
  notes?: string
}

export interface Emit {
  surface: Surface
  verdict: Verdict
  reason?: DoNotTranslateReason | NeedsJudgmentReason
  flags?: string[]
  maxLength?: number
  /** No agent verdict may override this. Used for legal text and escaping fixtures. */
  hard?: boolean
}

export type Matcher =
  | FileMatcher
  | PointerMatcher
  | KeyNameMatcher
  | AttrMatcher
  | StructuralMatcher
  | AnyMatcher

export interface FileMatcher {
  kind: 'file'
  /** Globs; a leading `!` excludes. */
  file: string[]
  /** The path must also contain one of these, so a name alone never decides. */
  confirm?: RegExp[]
}

export interface PointerMatcher {
  kind: 'pointer'
  file: string[]
  /** JSON Pointer patterns; `*` matches one segment, `**` any number. */
  pointer?: string[]
  pointerRegex?: RegExp
  /** The file must contain this pointer at all, discriminating look-alike files. */
  requiresPointer?: string
}

export interface KeyNameMatcher {
  kind: 'keyName'
  file?: string[]
  key: RegExp
}

export interface AttrMatcher {
  kind: 'attr'
  file?: string[]
  element?: RegExp
  attr: RegExp
}

/**
 * Matches on the extractor's structural path.
 *
 * This is what finds text that lives inside code rather than inside data — the
 * web manifest declared in a bundler config, where no filename hints at it.
 */
export interface StructuralMatcher {
  kind: 'structural'
  file: string[]
  /** Regex over the site's anchor path, e.g. /VitePWA\(\)\/manifest\/description$/ */
  path: RegExp
}

export interface AnyMatcher {
  kind: 'any'
  of: Matcher[]
}

/** What a rule is matched against. Deliberately small: extractors differ, this does not. */
export interface Candidate {
  file: string
  /** Anchor path: a JSON Pointer for data formats, a structural path for code. */
  path: string
  value: string
  /** Attribute name, for markup. */
  attr?: string
  element?: string
  /** Last path segment, for keyName matching. */
  key?: string
  /** Whether the site is a key rather than a value. */
  isKey?: boolean
}
