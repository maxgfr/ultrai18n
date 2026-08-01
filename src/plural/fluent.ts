// Fluent — the second grammar in the engine, and the only arrangement that
// earns one.
//
// Every other plural layout is a table: a category read off an anchor path, or
// forms split on a delimiter. Fluent's selector is neither. It is a syntactic
// construct with nesting, a mandatory default variant and two kinds of variant
// key, and no amount of data can express "parse this". So it sits beside
// `icu.ts` and is shaped exactly like it — a scanner that reports where the
// branches ARE, and a serializer that puts new ones back — because the pipeline
// downstream already knows how to work with that shape.
//
//   unread-count = { $count ->
//       [one] One unread message
//      *[other] { $count } unread messages
//   }

export interface FluentVariant {
  /** As written: `[one]`, `*[other]`, `[0]`. */
  selector: string
  key: string
  kind: 'identifier' | 'number'
  /** The `*` variant. Fluent requires exactly one per selector. */
  default: boolean
  /** Character offsets of the variant BODY within the scanned text. */
  start: number
  end: number
  body: string
}

export interface FluentSelect {
  start: number
  end: number
  /** `$count`, `NUMBER($count)`, `-brand`, `other-message`. */
  selector: string
  selectorKind: 'variable' | 'function' | 'reference'
  variants: FluentVariant[]
  /** 0 at the top level of a pattern; greater inside another variant's body. */
  depth: number
}

export interface FluentScan {
  selects: FluentSelect[]
  /** Every placeable's source text, `{ $count }` → `$count`. */
  placeables: string[]
  /** False when braces or brackets do not balance. */
  ok: boolean
}

/** Cheap pre-filter, so a JSON string containing `->` is never parsed. */
export function looksLikeFluentSelect(text: string): boolean {
  return text.includes('->') && /\*\s*\[/.test(text)
}

export function scanFluentPattern(text: string): FluentScan {
  const selects: FluentSelect[] = []
  const placeables: string[] = []
  let ok = true

  const walk = (from: number, to: number, depth: number): void => {
    for (let i = from; i < to; i++) {
      if (text[i] !== '{') continue
      const close = matchBrace(text, i, to)
      if (close < 0) {
        ok = false
        return
      }
      const inner = text.slice(i + 1, close)
      const arrow = topLevelArrow(inner)
      if (arrow < 0) {
        placeables.push(inner.trim())
        i = close
        continue
      }

      const selector = inner.slice(0, arrow).trim()
      const variants = readVariants(text, i + 1 + arrow + 2, close, () => {
        ok = false
      })
      selects.push({
        start: i,
        end: close + 1,
        selector,
        selectorKind: selectorKindOf(selector),
        variants,
        depth,
      })
      // A selector may hold another selector inside a variant body — Fluent
      // nests where ICU nests, and for the same reasons.
      for (const v of variants) walk(v.start, v.end, depth + 1)
      i = close
    }
  }

  walk(0, text.length, 0)
  return { selects, placeables, ok }
}

/**
 * Rebuild a select expression with a different set of variants.
 *
 * The analogue of `serializeArgument` in `icu.ts`, and the reason the Fluent
 * row can be `write: replace` at all: en→ru turns two variants into four inside
 * one value, which no join-with-a-delimiter can do.
 */
export function serializeSelect(
  select: FluentSelect,
  bodies: Record<string, string>,
  order?: string[],
  indent = '    ',
): string {
  const categories = order ?? select.variants.map((v) => v.key)
  const existing = new Map(select.variants.map((v) => [v.key, v]))
  // Fluent requires exactly one default variant, and it must survive: a
  // selector with none is a syntax error, not a degraded rendering.
  const fallback =
    select.variants.find((v) => v.default)?.key ??
    (categories.includes('other') ? 'other' : categories[categories.length - 1]!)

  const lines = categories.map((key) => {
    const body = bodies[key] ?? existing.get(key)?.body ?? bodies[fallback] ?? ''
    const star = key === fallback ? '*' : ' '
    return `${indent}${star}[${key}] ${body.trim()}`
  })
  return `{ ${select.selector} ->\n${lines.join('\n')}\n${indent.slice(0, -4)}}`
}

// ---------------------------------------------------------------------------
// Resource level — what the extractor reads.

export interface FluentEntry {
  kind: 'message' | 'term' | 'comment' | 'junk'
  id: string
  start: number
  end: number
  value: { start: number; end: number; text: string; indent: string } | null
  attributes: { name: string; start: number; end: number; text: string; indent: string }[]
  /** 1 for `#`, 2 for `##`, 3 for `###`. */
  commentLevel?: 1 | 2 | 3
}

const ID = /^(-?[A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/
const ATTR = /^\s+\.([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/

export function parseFluent(text: string): { entries: FluentEntry[]; ok: boolean } {
  const entries: FluentEntry[] = []
  const lines = splitLines(text)
  let ok = true

  for (let i = 0; i < lines.length; i++) {
    const { text: line, start } = lines[i]!
    if (line.trim() === '') continue

    if (line.startsWith('#')) {
      const level = (/^#{1,3}/.exec(line)![0].length as 1 | 2 | 3)
      entries.push({
        kind: 'comment',
        id: '',
        start,
        end: start + line.length,
        value: null,
        attributes: [],
        commentLevel: level,
      })
      continue
    }

    const m = ID.exec(line)
    if (!m) {
      // Not a comment, not an identifier, not indented under one: Fluent calls
      // this junk, and junk is NOT claimed — a file the parser could not read
      // reports a ratio below 1 rather than a clean sheet.
      if (!/^\s/.test(line)) {
        ok = false
        entries.push({ kind: 'junk', id: '', start, end: start + line.length, value: null, attributes: [] })
      }
      continue
    }

    const id = m[1]!
    const rest = m[2] ?? ''
    const block = readBlock(lines, i, rest, start + line.length - rest.length)
    const attributes: FluentEntry['attributes'] = []

    let j = block.lastLine
    while (j + 1 < lines.length) {
      const a = ATTR.exec(lines[j + 1]!.text)
      if (!a) break
      const attrRest = a[2] ?? ''
      const attrLine = lines[j + 1]!
      const attrBlock = readBlock(lines, j + 1, attrRest, attrLine.start + attrLine.text.length - attrRest.length)
      attributes.push({ name: a[1]!, start: attrBlock.start, end: attrBlock.end, text: attrBlock.text, indent: attrBlock.indent })
      j = attrBlock.lastLine
    }

    entries.push({
      kind: id.startsWith('-') ? 'term' : 'message',
      id,
      start,
      end: lines[j]!.start + lines[j]!.text.length,
      value: block.text.trim() === '' ? null : { start: block.start, end: block.end, text: block.text, indent: block.indent },
      attributes,
    })
    i = j
  }

  return { entries, ok }
}

interface Block {
  text: string
  start: number
  end: number
  indent: string
  lastLine: number
}

/**
 * A pattern and every continuation line indented under it.
 *
 * The continuation indent is captured rather than discarded because `apply`
 * re-applies it on write; losing it turns a three-line selector into one long
 * line that is still valid Fluent and no longer readable.
 */
function readBlock(lines: Line[], li: number, first: string, at: number): Block {
  const parts = [first]
  let last = li
  let indent = ''
  let depth = braceDelta(first)

  for (let k = li + 1; k < lines.length; k++) {
    const line = lines[k]!.text
    // An attribute belongs to the entry, not to this pattern.
    if (ATTR.test(line) && depth <= 0) break
    // Continuation is normally signalled by indentation — but a select
    // expression's closing `}` conventionally sits at column 0, and stopping at
    // it truncated the value one character short of balanced. The scanner then
    // found no closing brace, reported `ok: false`, and every Fluent plural
    // went unclaimed while the file itself looked perfectly well read.
    if (depth <= 0 && (line.trim() === '' || !/^\s/.test(line))) break
    if (!indent && /^\s/.test(line)) indent = /^[ \t]*/.exec(line)![0]
    parts.push(line.trim())
    depth += braceDelta(line)
    last = k
  }

  const end = lines[last]!.start + lines[last]!.text.length
  return { text: parts.join('\n'), start: at, end, indent: indent || '    ', lastLine: last }
}

function braceDelta(s: string): number {
  let n = 0
  for (const ch of s) {
    if (ch === '{') n++
    else if (ch === '}') n--
  }
  return n
}

// ---------------------------------------------------------------------------

function selectorKindOf(selector: string): FluentSelect['selectorKind'] {
  if (selector.startsWith('$')) return 'variable'
  if (/^[A-Z][A-Z0-9_]*\s*\(/.test(selector)) return 'function'
  return 'reference'
}

/** The `->` at brace depth 0, so a nested selector's arrow is not mistaken for this one. */
function topLevelArrow(inner: string): number {
  let depth = 0
  for (let i = 0; i < inner.length - 1; i++) {
    const ch = inner[i]!
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (depth === 0 && ch === '-' && inner[i + 1] === '>') return i
  }
  return -1
}

function matchBrace(text: string, open: number, to: number): number {
  let depth = 0
  for (let i = open; i < to; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function readVariants(text: string, from: number, to: number, onError: () => void): FluentVariant[] {
  const out: FluentVariant[] = []
  let i = from
  while (i < to) {
    const star = text.indexOf('*', i)
    const bracket = text.indexOf('[', i)
    if (bracket < 0 || bracket >= to) break

    const isDefault = star >= 0 && star < bracket && text.slice(star + 1, bracket).trim() === ''
    const close = text.indexOf(']', bracket)
    if (close < 0 || close >= to) {
      onError()
      break
    }
    const key = text.slice(bracket + 1, close).trim()

    // The body runs to the next variant or to the end of the select.
    let next = to
    for (let k = close + 1; k < to; k++) {
      if (text[k] !== '[') continue
      const back = text.slice(close + 1, k)
      // A `[` inside a nested selector is not the next variant of THIS one.
      if (braceDelta(back) !== 0) continue
      const starAt = back.lastIndexOf('*')
      next = starAt >= 0 && back.slice(starAt + 1).trim() === '' ? close + 1 + starAt : k
      break
    }

    out.push({
      selector: `${isDefault ? '*' : ''}[${key}]`,
      key,
      kind: /^\d+$/.test(key) ? 'number' : 'identifier',
      default: isDefault,
      start: close + 1,
      end: next,
      body: text.slice(close + 1, next).trim(),
    })
    i = next
  }
  return out
}

interface Line {
  text: string
  start: number
}

function splitLines(text: string): Line[] {
  const out: Line[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ text: text.slice(start, i).replace(/\r$/, ''), start })
      start = i + 1
    }
  }
  return out
}
