import type { Hole, SiteKind, Span, Tier } from '../types'
import type { OffsetMap } from '../vendor/text'

/**
 * How many BYTES a line occupies, its newline included.
 *
 * The census reports `claimRatio` as a fraction of the file's bytes, and a
 * lexer scanning a JS string counts UTF-16 code units. The two agree on an
 * ASCII file and diverge badly on any other: a Japanese bundle read end to end
 * reported 0.72, which reads as "the extractor skipped a quarter of this file"
 * when it had skipped nothing at all. Since the target of this tool is
 * repositories that are not in English, the mismatch showed up almost
 * everywhere it mattered.
 *
 * Clamping at the end of the text is the second half: the final line of a file
 * with no trailing newline has no newline to claim, and counting one anyway put
 * the ratio above 1.
 */
export function lineBytes(map: OffsetMap, text: string, start: number, length: number): number {
  return map.byteOf(Math.min(start + length + 1, text.length)) - map.byteOf(start)
}

/**
 * What an extractor emits, before classification.
 *
 * Deliberately not a full `Site`: an extractor knows WHERE text is and what
 * syntax holds it, but not whether it should be translated. Keeping those two
 * jobs apart is what lets one classifier apply the same rules to text found by
 * five different extractors.
 */
export interface RawSite {
  file: string
  /** Structural path within the file — the siteKey's second half. Never the value. */
  path: string
  kind: SiteKind
  /** Byte offsets of the raw slice, delimiters included. */
  span: Span
  /** Byte offsets of the decodable interior. */
  valueSpan: Span
  raw: string
  /** Decoded: escapes resolved, interpolations replaced by `{n}`. */
  value: string
  quote: string | null
  escapes: boolean
  holes: Hole[]
  /**
   * How to rebuild a delimited site around a new value.
   *
   * A comment's `//` or slash-star is not part of its text but IS part of its
   * span, so writing the text alone over the span deletes the marker and turns
   * a comment into a syntax error. These carry the marker back.
   */
  prefix?: string
  suffix?: string
  /** Re-applied to every line but the first, for multi-line block comments. */
  linePrefix?: string
  line: number
  col: number
  endLine: number
  endCol: number
  extractor: string
  tier: Tier
  container: Container
  /** Sweep sites only: who owned the file and why the span went unclaimed. */
  whyUnclaimed?: string
}

export interface Container {
  /** True when the text is a key/identifier rather than a value. */
  isKey: boolean
  /** For a JSX or HTML attribute: the attribute name, which drives classification. */
  attrName?: string
  /** For a JSX element: the tag. */
  element?: string
  /** The literal is a module specifier — `import x from 'here'`. */
  moduleSpecifier?: boolean
  /** The literal is compared, not rendered: `x === 'here'`, `switch`, `.includes()`. */
  compared?: boolean
  /** The literal is a member of a type union, z.enum, or an `as const` object's keys. */
  enumMember?: boolean
  /** Enclosing named declaration, for evidence and for the anchor path. */
  enclosingSymbol?: string
  /** Nearest preceding comment — often the thing that resolves an ambiguous call. */
  nearestComment?: string
  /** Sibling keys of the enclosing object literal, for cohort inheritance. */
  siblingKeys?: string[]
  /** Set when this literal reaches a storage/cache/alarm API. */
  persisted?: boolean
  /** The enclosing call's callee name, when the literal is an argument. */
  callee?: string
  /** Argument index within that call. */
  argIndex?: number
  /** True inside a test file. */
  inTest?: boolean
  /**
   * The tag of a tagged template — `css`, `gql`, `styled.div`.
   *
   * Kept apart from `callee` because a tagged template is not a call
   * expression, so the call-walking that fills `callee` never sees one. Without
   * this a `css` block reads as an ordinary translatable template literal.
   */
  tag?: string
}

/** Cross-reference indexes, built repo-wide before classification. */
export interface TokenIndex {
  /** value -> sites that define it as an enum member */
  enums: Map<string, string[]>
  /** value -> sites where it is compared rather than rendered */
  compared: Map<string, string[]>
  /** value -> sites where it reaches persistent storage */
  persisted: Map<string, string[]>
  /** Every declared identifier, JSON/YAML key, class name and dependency name. */
  identifiers: Set<string>
}

export function emptyTokenIndex(): TokenIndex {
  return { enums: new Map(), compared: new Map(), persisted: new Map(), identifiers: new Set() }
}

export function addToken(index: Map<string, string[]>, value: string, site: string): void {
  const list = index.get(value)
  if (list) list.push(site)
  else index.set(value, [site])
}
