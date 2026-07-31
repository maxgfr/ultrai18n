// JSON / JSONC / JSON5 extraction.
//
// A hand-written scanner rather than JSON.parse, for two reasons that are not
// negotiable: offsets (parse throws away every position, and the patcher writes
// at positions), and tolerance (a repo's tsconfig.json has comments and trailing
// commas, and refusing to read it would silently drop a file).
//
// There is no tree-sitter grammar for JSON in codeindex's set, so this is the
// primary tier for the format, not a fallback.
import type { Span } from '../types'
import type { Container, RawSite } from './raw'
import { pointer } from '../identity'
import { OffsetMap } from '../vendor/text'

export interface JsonExtractResult {
  sites: RawSite[]
  /** Every key seen, for the repo identifier vocabulary the residual sweep needs. */
  keys: Set<string>
  /** Bytes the scanner accounted for — structure, numbers, literals, strings. */
  claimedBytes: number
  /** True when the scanner reached the end without losing sync. */
  complete: boolean
}

export function extractJson(file: string, text: string, map: OffsetMap): JsonExtractResult {
  const sites: RawSite[] = []
  const keys = new Set<string>()
  let claimed = 0
  let i = 0
  const n = text.length

  // A stack of containers, each tracking its own current position: an object
  // remembers the key it is filling, an array remembers its index. Collapsing
  // the two into one list of segments cannot represent an object nested inside
  // an array, because entering the object must not push a new segment — the
  // array's index already IS the position.
  type Frame = { type: 'object'; key: string | null } | { type: 'array'; index: number }
  const stack: Frame[] = []
  let complete = true

  const currentPath = (): string =>
    pointer(
      stack
        .map((f) => (f.type === 'object' ? f.key : f.index))
        .filter((s): s is string | number => s !== null),
    )

  const at = (k: number): string => text[k] ?? ''

  while (i < n) {
    const c = at(i)

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      claimed++
      i++
      continue
    }

    // JSONC / JSON5 comments. A comment in a config file is often the only
    // French left in an otherwise translated repo, so it is a site, not noise.
    if (c === '/' && (at(i + 1) === '/' || at(i + 1) === '*')) {
      const block = at(i + 1) === '*'
      const end = block ? indexOfOr(text, '*/', i + 2, n) + 2 : indexOfOr(text, '\n', i + 2, n)
      const raw = text.slice(i, Math.min(end, n))
      const value = block ? raw.slice(2, -2).trim() : raw.slice(2).trim()
      if (/\p{L}{2,}/u.test(value)) {
        sites.push(
          site(file, currentPath(), 'comment', i, Math.min(end, n), value, null, [], map, text, {
            isKey: false,
          }),
        )
      }
      claimed += Math.min(end, n) - i
      i = Math.min(end, n)
      continue
    }

    if (c === '"' || c === "'") {
      const parsed = readString(text, i, c)
      if (!parsed) {
        complete = false
        break
      }
      const isKey = isKeyPosition(text, parsed.end, n)
      const top = stack[stack.length - 1]
      if (isKey) {
        if (top?.type === 'object') top.key = parsed.value
        keys.add(parsed.value)
      }
      sites.push(
        site(
          file,
          currentPath(),
          isKey ? 'key' : 'scalar',
          i,
          parsed.end,
          parsed.value,
          c,
          [],
          map,
          text,
          { isKey, siblingKeys: [] },
          parsed.escapes,
        ),
      )
      claimed += parsed.end - i
      i = parsed.end
      continue
    }

    if (c === '{') {
      stack.push({ type: 'object', key: null })
      claimed++
      i++
      continue
    }
    if (c === '[') {
      stack.push({ type: 'array', index: 0 })
      claimed++
      i++
      continue
    }
    if (c === '}' || c === ']') {
      stack.pop()
      claimed++
      i++
      continue
    }
    if (c === ',') {
      const top = stack[stack.length - 1]
      if (top?.type === 'array') top.index++
      else if (top?.type === 'object') top.key = null
      claimed++
      i++
      continue
    }
    if (c === ':') {
      claimed++
      i++
      continue
    }

    // Numbers, true/false/null, and JSON5 bare keys. Claimed, not emitted:
    // "the scanner looked at this and it was not text" is the assertion the
    // census's claimRatio is built from.
    const wordEnd = readBareToken(text, i, n)
    if (wordEnd > i) {
      const word = text.slice(i, wordEnd)
      if (isKeyPosition(text, wordEnd, n)) {
        const top = stack[stack.length - 1]
        if (top?.type === 'object') top.key = word
        keys.add(word)
      }
      claimed += wordEnd - i
      i = wordEnd
      continue
    }

    complete = false
    break
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, keys, claimedBytes: claimed, complete }
}

function indexOfOr(text: string, needle: string, from: number, fallback: number): number {
  const idx = text.indexOf(needle, from)
  return idx === -1 ? fallback : idx
}

function isKeyPosition(text: string, afterToken: number, n: number): boolean {
  let k = afterToken
  while (k < n) {
    const c = text[k]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      k++
      continue
    }
    // Skip a comment sitting between the key and its colon.
    if (c === '/' && (text[k + 1] === '/' || text[k + 1] === '*')) {
      k = text[k + 1] === '*' ? indexOfOr(text, '*/', k + 2, n) + 2 : indexOfOr(text, '\n', k + 2, n)
      continue
    }
    return c === ':'
  }
  return false
}

function readBareToken(text: string, start: number, n: number): number {
  let k = start
  while (k < n && /[^\s:,{}[\]"']/.test(text[k]!)) k++
  return k
}

interface ParsedString {
  value: string
  end: number
  escapes: boolean
}

function readString(text: string, start: number, quote: string): ParsedString | null {
  let value = ''
  let escapes = false
  let k = start + 1
  while (k < text.length) {
    const c = text[k]!
    if (c === '\\') {
      escapes = true
      const next = text[k + 1]
      if (next === undefined) return null
      if (next === 'u') {
        value += String.fromCharCode(parseInt(text.slice(k + 2, k + 6), 16))
        k += 6
      } else {
        value += unescapeJson(next)
        k += 2
      }
      continue
    }
    if (c === quote) return { value, end: k + 1, escapes }
    value += c
    k++
  }
  return null
}

function unescapeJson(c: string): string {
  switch (c) {
    case 'n': return '\n'
    case 't': return '\t'
    case 'r': return '\r'
    case 'b': return '\b'
    case 'f': return '\f'
    case '/': return '/'
    case '\\': return '\\'
    case '"': return '"'
    case "'": return "'"
    default: return c
  }
}

function site(
  file: string,
  path: string,
  kind: RawSite['kind'],
  startChar: number,
  endChar: number,
  value: string,
  quote: string | null,
  holes: RawSite['holes'],
  map: OffsetMap,
  text: string,
  container: Container,
  escapes = false,
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
    escapes,
    holes,
    line: s.line,
    col: s.col,
    endLine: e.line,
    endCol: e.col,
    extractor: 'json',
    tier: 'structural',
    container,
  }
}
