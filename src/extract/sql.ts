// SQL extraction — a reader that earns its place by SILENCING.
//
// Every other extractor here exists to find text. This one exists so a schema
// stops being 384 refusals. A `.sql` file has no reader today, so the residual
// sweep runs over all of it and forces every human-looking run of DDL into the
// inventory as `unclassified` — `CREATE TABLE subscriber accounts`, every
// column comment, every `NOT NULL DEFAULT` — and `check` refuses to pass until
// somebody adjudicates them one at a time.
//
// The honest answer is not a cleverer sweep. It is a reader that says out loud
// what the sweep was guessing: the comments are prose, the DDL was looked at
// and judged non-textual, and that judgement is what `claimRatio` records.
//
// Hand-written rather than on the AST tier because codeindex ships no SQL
// grammar, and the job is a comment lexer. What it cannot do — a dialect's
// nested block comments, `$$`-quoted function bodies — leaves those bytes
// unclaimed, so the sweep still covers them.
import type { Span } from '../types'
import type { RawSite } from './raw'
import { OffsetMap } from '../vendor/text'

export interface SqlExtractResult {
  sites: RawSite[]
  claimedBytes: number
  /** True when the lexer reached the end without losing sync. */
  complete: boolean
}

export function extractSql(file: string, text: string, map: OffsetMap): SqlExtractResult {
  const sites: RawSite[] = []
  let index = 0
  let i = 0
  let claimed = 0
  let complete = true
  const n = text.length

  const push = (
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    valueStartChar: number,
    valueEndChar: number,
    value: string,
    quote: string | null,
    prefix?: string,
    suffix?: string,
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
      escapes: quote === "'" && text.slice(startChar, endChar).includes("''"),
      holes: [],
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'sql',
      tier: 'structural',
      container: { isKey: false },
      ...(prefix !== undefined ? { prefix, suffix: suffix ?? '', linePrefix: '' } : {}),
    })
  }

  while (i < n) {
    const c = text[i]!

    // `-- comment`, to end of line. A person writes these; a schema does not.
    if (c === '-' && text[i + 1] === '-') {
      const end = indexOfOr(text, '\n', i, n)
      const marker = /^-{2,}\s?/.exec(text.slice(i, end))![0]
      const value = text.slice(i + marker.length, end).trimEnd()
      if (/\p{L}{2,}/u.test(value)) {
        push('comment', i, end, i + marker.length, end, value, null, marker, '')
      }
      claimed += map.byteOf(end) - map.byteOf(i)
      i = end
      continue
    }

    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      if (close === -1) {
        // An unterminated block comment: the rest of the file is inside it and
        // this lexer has lost sync. Say so rather than guessing — the sweep
        // covers what stays unclaimed.
        complete = false
        break
      }
      const end = close + 2
      const value = text.slice(i + 2, close).trim()
      if (/\p{L}{2,}/u.test(value)) push('comment', i, end, i + 2, close, value, null, '/* ', ' */')
      claimed += map.byteOf(end) - map.byteOf(i)
      i = end
      continue
    }

    // A single-quoted literal. `''` is SQL's escape for a quote inside one.
    if (c === "'") {
      let k = i + 1
      while (k < n) {
        if (text[k] === "'" && text[k + 1] === "'") {
          k += 2
          continue
        }
        if (text[k] === "'") break
        k++
      }
      if (k >= n) {
        complete = false
        break
      }
      const end = k + 1
      const value = text.slice(i + 1, k).replace(/''/g, "'")
      // A literal carrying prose is a seed row or a CHECK message — copy that
      // a person may read. One holding a token is a default, an enum value or a
      // format string, and translating one of those breaks the schema. The
      // engine does not decide that here: it emits the site with the words in
      // it and lets the classifier and its rules answer, which is the same
      // division every other extractor keeps.
      if (/\p{L}{2,}/u.test(value)) push('scalar', i, end, i + 1, k, value, "'")
      claimed += map.byteOf(end) - map.byteOf(i)
      i = end
      continue
    }

    // A quoted identifier: a column or table name, never copy. Claimed as read
    // and deliberately not emitted.
    if (c === '"' || c === '`') {
      const close = text.indexOf(c, i + 1)
      if (close === -1) {
        complete = false
        break
      }
      claimed += map.byteOf(close + 1) - map.byteOf(i)
      i = close + 1
      continue
    }

    // Keywords, identifiers, operators, numbers, whitespace. Read, and judged
    // non-textual — which is the assertion, and the whole point of this reader.
    claimed += map.byteOf(i + 1) - map.byteOf(i)
    i++
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, claimedBytes: claimed, complete }
}

function indexOfOr(text: string, needle: string, from: number, fallback: number): number {
  const idx = text.indexOf(needle, from)
  return idx === -1 ? fallback : idx
}
