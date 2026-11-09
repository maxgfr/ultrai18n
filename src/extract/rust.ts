// Rust extraction — a hand-written lexer, on the model of `extract/sql.ts`.
//
// A `.rs` file with no reader went to the residual sweep whole, which forced
// `Motion::PanUp`, `use std::fs;` and `pub type BBox` into the inventory as
// `unclassified`: thousands of refusals nobody could act on, with the French in
// the comments buried underneath them.
//
// Hand-written because no Rust grammar ships, and the job is a lexer anyway.
// Four things in Rust break a naive one, and each has a branch here: block
// comments NEST, a raw string has no escapes and a delimiter of its own
// length, `'` opens both a char literal and a lifetime, and an attribute's
// strings are mostly configuration. Whatever cannot be lexed stops the reader
// and is left to the sweep rather than guessed at.
import type { Hole, Span } from '../types'
import type { RawSite } from './raw'
import { commentShape } from './ts'
import { OffsetMap } from '../text'

export interface RustExtractResult {
  sites: RawSite[]
  claimedBytes: number
  /** True when the lexer reached the end without losing sync. */
  complete: boolean
}

/** Comments addressed to a tool rather than to a person. */
const DIRECTIVE = /^(?:rustfmt::|clippy::|cargo:)/

/**
 * A format placeholder: `{}`, `{0}`, `{name}`, `{name:>8}`, `{:?}`.
 *
 * Recorded in every string, not only in the argument of a format macro. A
 * placeholder in a plain literal is usually the same placeholder on its way to
 * a `.replace("{name}", …)`, and keeping it costs nothing when it is not.
 */
const PLACEHOLDER = /\{(?:[\p{XID_Start}_]\p{XID_Continue}*|\d+)?(?::[^{}\n]*)?\}/uy

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '0': '\0',
  '\\': '\\',
  "'": "'",
  '"': '"',
}

/** Letters, digits, `_`, and anything non-ASCII: operators are all ASCII. */
function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code >= 0x80
  )
}

function isWordStart(code: number): boolean {
  return isWordChar(code) && !(code >= 0x30 && code <= 0x39)
}

export function extractRust(file: string, text: string, map: OffsetMap): RustExtractResult {
  const sites: RawSite[] = []
  const n = text.length
  let index = 0
  let i = 0
  let complete = true
  // Depth of `[` inside a `#[...]`, so strings there can be filtered. Zero
  // outside any attribute.
  let attrDepth = 0

  const push = (
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    valueStartChar: number,
    valueEndChar: number,
    value: string,
    quote: string | null,
    escapes: boolean,
    holes: Hole[],
    shape?: { prefix: string; suffix: string; linePrefix: string },
  ): void => {
    const span: Span = { start: map.byteOf(startChar), end: map.byteOf(endChar) }
    const s = map.lineColOf(startChar)
    const e = map.lineColOf(endChar)
    sites.push({
      file,
      path: `${kind === 'comment' ? '#comment' : 'string'}[${index++}]`,
      kind,
      span,
      valueSpan: { start: map.byteOf(valueStartChar), end: map.byteOf(valueEndChar) },
      raw: text.slice(startChar, endChar),
      value,
      quote,
      escapes,
      holes,
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'rust',
      tier: 'structural',
      container: { isKey: false },
      ...(shape ?? {}),
    })
  }

  const pushComment = (start: number, end: number): void => {
    const shape = commentShape(text.slice(start, end))
    if (DIRECTIVE.test(shape.body)) return
    if (!/\p{L}{2,}/u.test(shape.body)) return
    push('comment', start, end, start, end, shape.body, null, false, [], shape)
  }

  /** Decode a string's interior into its value and the holes it carries. */
  const decode = (from: number, to: number, raw: boolean): { value: string; holes: Hole[] } => {
    const holes: Hole[] = []
    let value = ''
    let k = from
    while (k < to) {
      const c = text[k]!
      if (c === '\\' && !raw) {
        const next = text[k + 1]
        if (next === '\n' || next === '\r') {
          // A line continuation: the newline and the indentation after it
          // are not part of the string.
          k += 2
          while (k < to && /\s/.test(text[k]!)) k++
          continue
        }
        if (next === 'x') {
          value += String.fromCharCode(parseInt(text.slice(k + 2, k + 4), 16))
          k += 4
          continue
        }
        if (next === 'u' && text[k + 2] === '{') {
          const close = text.indexOf('}', k + 3)
          value += String.fromCodePoint(parseInt(text.slice(k + 3, close).replace(/_/g, ''), 16))
          k = close + 1
          continue
        }
        value += SIMPLE_ESCAPES[next ?? ''] ?? next ?? ''
        k += 2
        continue
      }
      // `{{` and `}}` stay doubled in the value. The brace-skeleton validator
      // then refuses a translation that loses one, and writing them back needs
      // no special case.
      if ((c === '{' && text[k + 1] === '{') || (c === '}' && text[k + 1] === '}')) {
        value += c + c
        k += 2
        continue
      }
      if (c === '{') {
        PLACEHOLDER.lastIndex = k
        const m = PLACEHOLDER.exec(text)
        if (m && k + m[0].length <= to) {
          const end = k + m[0].length
          holes.push({
            index: holes.length,
            span: { start: map.byteOf(k), end: map.byteOf(end) },
            expr: m[0].slice(1, -1),
          })
          value += `{${holes.length - 1}}`
          k = end
          continue
        }
      }
      // The compiler normalises CRLF in a literal to LF when it loads the file.
      if (c === '\r' && text[k + 1] === '\n') {
        k++
        continue
      }
      value += c
      k++
    }
    return { value, holes }
  }

  const emitString = (
    start: number,
    end: number,
    from: number,
    to: number,
    quote: string,
    raw: boolean,
  ): void => {
    const { value, holes } = decode(from, to, raw)
    if (!/\p{L}{2,}/u.test(value)) return
    // An attribute's strings are mostly configuration — a default, a rename
    // rule, a feature name. Whitespace is what separates those from a sentence
    // like `about = "Read and animate"`.
    if (attrDepth > 0 && !/\s/.test(value)) return
    const escapes = !raw && text.slice(from, to).includes('\\')
    push(holes.length > 0 ? 'template' : 'string-literal', start, end, from, to, value, quote, escapes, holes)
  }

  /** The offset of the `"` closing a non-raw string opened at `open`, or -1. */
  const closeOfString = (open: number): number => {
    let k = open + 1
    while (k < n) {
      if (text[k] === '\\') {
        k += 2
        continue
      }
      if (text[k] === '"') return k
      k++
    }
    return -1
  }

  /**
   * Where a `'` token ends, or -1 when it is neither form.
   *
   * The order is the compiler's own. `'x'` is a char whatever `x` is, and only
   * a word start NOT closed by a `'` right after one character is a lifetime —
   * which is what tells `'a'` from `<'a>`.
   */
  const endOfQuoteToken = (open: number): number => {
    const next = text[open + 1]
    if (next === undefined || next === "'") return -1
    if (next === '\\') {
      let k = open + 3
      while (k < n && text[k] !== "'" && text[k] !== '\n') k++
      return text[k] === "'" ? k + 1 : -1
    }
    const width = text.codePointAt(open + 1)! > 0xffff ? 2 : 1
    if (text[open + 1 + width] === "'") return open + 2 + width
    if (isWordStart(next.charCodeAt(0))) {
      let k = open + 2
      while (k < n && isWordChar(text.charCodeAt(k))) k++
      return text[k] === "'" ? -1 : k
    }
    return -1
  }

  scan: while (i < n) {
    const c = text[i]!

    if (c === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i)
      if (end === -1) end = n
      // Trailing whitespace stays out of the span, so a `\r` survives a write.
      while (end > i && /\s/.test(text[end - 1]!)) end--
      pushComment(i, end)
      i = end
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      let depth = 1
      let k = i + 2
      while (k < n && depth > 0) {
        if (text[k] === '/' && text[k + 1] === '*') {
          depth++
          k += 2
        } else if (text[k] === '*' && text[k + 1] === '/') {
          depth--
          k += 2
        } else {
          k++
        }
      }
      if (depth > 0) {
        complete = false
        break scan
      }
      pushComment(i, k)
      i = k
      continue
    }

    if (c === '"') {
      const close = closeOfString(i)
      if (close === -1) {
        complete = false
        break scan
      }
      emitString(i, close + 1, i + 1, close, '"', false)
      i = close + 1
      continue
    }

    if (c === "'") {
      const end = endOfQuoteToken(i)
      if (end === -1) {
        complete = false
        break scan
      }
      i = end
      continue
    }

    if (isWordChar(c.charCodeAt(0))) {
      let k = i + 1
      while (k < n && isWordChar(text.charCodeAt(k))) k++
      const word = text.slice(i, k)

      if (word === 'r' || word === 'br' || word === 'cr') {
        let q = k
        while (text[q] === '#') q++
        if (text[q] === '"') {
          const closer = '"' + '#'.repeat(q - k)
          const close = text.indexOf(closer, q + 1)
          if (close === -1) {
            complete = false
            break scan
          }
          const end = close + closer.length
          if (word === 'r') emitString(i, end, q + 1, close, text.slice(i, q + 1), true)
          i = end
          continue
        }
        // `r#type` is a raw identifier, not a string.
      }

      if ((word === 'b' || word === 'c') && text[k] === '"') {
        const close = closeOfString(k)
        if (close === -1) {
          complete = false
          break scan
        }
        i = close + 1
        continue
      }

      if (word === 'b' && text[k] === "'") {
        const end = endOfQuoteToken(k)
        if (end === -1) {
          complete = false
          break scan
        }
        i = end
        continue
      }

      i = k
      continue
    }

    if (c === '#') {
      let k = i + 1
      if (text[k] === '!') k++
      while (k < n && /\s/.test(text[k]!)) k++
      if (text[k] === '[') {
        attrDepth++
        i = k + 1
        continue
      }
    }

    if (attrDepth > 0) {
      if (c === '[') attrDepth++
      else if (c === ']') attrDepth--
    }

    // Identifiers, keywords, operators, numbers, whitespace. Read, and judged
    // non-textual.
    i++
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, claimedBytes: map.byteOf(complete ? n : i), complete }
}
