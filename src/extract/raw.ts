import type { Hole, SiteKind, Span, Tier } from '../types'

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
