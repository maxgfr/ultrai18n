// CSS extraction.
//
// Two surfaces only, and they are not symmetric. Comments are the reason this
// file exists: a stylesheet's comments are prose nobody thinks of as prose, and
// they are exactly what a whole-repo language pass leaves behind. `content:`
// values are the other — rarely used for copy, occasionally used for a visible
// label, and cheap to include.
//
// Selectors, properties and values are read and deliberately NOT emitted. That
// distinction is what makes the census's claimRatio a measurement rather than a
// guess: the scanner asserts it looked at those bytes and found no text.
import type { Span } from '../types'
import type { RawSite } from './raw'
import { OffsetMap } from '../vendor/text'

export interface CssExtractResult {
  sites: RawSite[]
  claimedBytes: number
  /** Class and custom-property names, for the repo identifier vocabulary. */
  identifiers: Set<string>
}

export function extractCss(file: string, text: string, map: OffsetMap): CssExtractResult {
  const sites: RawSite[] = []
  const identifiers = new Set<string>()
  let index = 0

  // Comments.
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
    const at = match.index ?? 0
    const raw = match[0]
    const value = raw
      .slice(2, -2)
      .split('\n')
      .map((l) => l.replace(/^\s*\*+ ?/, '').trim())
      .join('\n')
      .trim()
    if (!/\p{L}{2,}/u.test(value)) continue
    const s0 = site(file, `comment[${index++}]`, 'comment', at, at + raw.length, value, null, map, text)
    const lines = raw.split('\n')
    const gutter = lines.length > 1 ? (/^(\s*\*+ ?)/.exec(lines[1] ?? '')?.[1] ?? '') : ''
    s0.prefix = lines.length > 1 ? '/*\n' + gutter : '/* '
    s0.suffix = lines.length > 1 ? '\n' + gutter.replace(/\*+ ?$/, '') + '*/' : ' */'
    s0.linePrefix = gutter
    sites.push(s0)
  }

  // `content:` values. Only quoted ones: `content: counter(x)` is a function.
  for (const match of text.matchAll(/content\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const at = match.index ?? 0
    const quoteAt = at + match[0].indexOf(match[1]!)
    const raw = match[0].slice(match[0].indexOf(match[1]!))
    const value = match[2]!
    if (!/\p{L}{2,}/u.test(value)) continue
    sites.push(site(file, `content[${index++}]`, 'string-literal', quoteAt, quoteAt + raw.length, value, match[1]!, map, text))
  }

  for (const match of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) identifiers.add(match[1]!)
  for (const match of text.matchAll(/--([\w-]+)\s*:/g)) identifiers.add(`--${match[1]!}`)

  sites.sort((a, b) => a.span.start - b.span.start)
  // The whole file was scanned; the parts not emitted were read and judged
  // non-textual, which is a different claim from "not looked at".
  return { sites, claimedBytes: map.byteOf(text.length), identifiers }
}

function site(
  file: string,
  path: string,
  kind: RawSite['kind'],
  startChar: number,
  endChar: number,
  value: string,
  quote: string | null,
  map: OffsetMap,
  text: string,
): RawSite {
  const span: Span = { start: map.byteOf(startChar), end: map.byteOf(endChar) }
  const valueSpan: Span = quote
    ? { start: map.byteOf(startChar + 1), end: map.byteOf(endChar - 1) }
    : span
  const s = map.lineColOf(startChar)
  const e = map.lineColOf(endChar)
  return {
    file,
    path,
    kind,
    span,
    valueSpan,
    raw: text.slice(startChar, endChar),
    value,
    quote,
    escapes: false,
    holes: [],
    line: s.line,
    col: s.col,
    endLine: e.line,
    endCol: e.col,
    extractor: 'css',
    tier: 'structural',
    container: { isKey: false },
  }
}
