// YAML extraction — an indentation scanner, not a conformant parser.
//
// Deliberately tolerant rather than complete. The alternative to a partial YAML
// reader is no YAML reader, and the files that matter here (issue forms,
// workflows, compose files, locale bundles) use a small, well-behaved subset.
// What it cannot handle is listed at the bottom and is caught by the residual
// sweep, so an unparsed construct surfaces as `unclassified` rather than
// vanishing.
//
// The load-bearing feature is BLOCK SCALARS. `.github/workflows/release.yml`
// holds a release-notes body as `body: |` — markdown that renders on a public
// page. Ordinary YAML tooling reports one opaque string; recursing into it with
// remapped offsets turns it into individually patchable prose.
import type { Span } from '../types'
import type { Container, RawSite } from './raw'
import { pointer } from '../identity'
import { OffsetMap } from '../vendor/text'

export interface YamlExtractResult {
  sites: RawSite[]
  keys: Set<string>
  claimedBytes: number
  complete: boolean
  /** Constructs the scanner knowingly skipped, for the census. */
  skipped: string[]
}

type Frame = { indent: number; type: 'map'; key: string | null } | { indent: number; type: 'seq'; index: number }

export function extractYaml(
  file: string,
  text: string,
  map: OffsetMap,
  /** Recurse into a block scalar's body, remapping every child offset. */
  nested?: (body: string, absoluteStart: number, path: string) => RawSite[],
): YamlExtractResult {
  const sites: RawSite[] = []
  const keys = new Set<string>()
  const skipped: string[] = []
  let claimed = 0
  let complete = true

  const stack: Frame[] = []
  const lines = splitLines(text)

  const pathSegments = (): (string | number)[] =>
    stack
      .map((f) => (f.type === 'map' ? f.key : f.index))
      .filter((s): s is string | number => s !== null)

  const currentPath = (): string => pointer(pathSegments())

  const push = (
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    value: string,
    quote: string | null,
    path: string,
    container: Container = { isKey: false },
    prefix?: string,
  ): void => {
    const span: Span = { start: map.byteOf(startChar), end: map.byteOf(endChar) }
    const valueSpan: Span = quote
      ? { start: map.byteOf(startChar + 1), end: map.byteOf(endChar - 1) }
      : span
    const s = map.lineColOf(startChar)
    const e = map.lineColOf(endChar)
    sites.push({
      file,
      path,
      kind,
      span,
      valueSpan,
      raw: text.slice(startChar, endChar),
      value,
      quote,
      escapes: quote === '"' && /\\/.test(text.slice(startChar, endChar)),
      holes: [],
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'yaml',
      tier: 'structural',
      container,
      ...(prefix !== undefined ? { prefix, suffix: '', linePrefix: '' } : {}),
    })
  }

  for (let li = 0; li < lines.length; li++) {
    const { text: line, start: lineStart } = lines[li]!
    claimed += line.length + 1

    const indentMatch = /^[ \t]*/.exec(line)!
    const indent = indentMatch[0].length
    const body = line.slice(indent)

    if (body === '' || body === '---' || body === '...') continue

    // Comments. A French comment in dependabot.yml is exactly the kind of
    // residue a whole-repo pass misses.
    if (body.startsWith('#')) {
      const value = body.replace(/^#+\s?/, '').trim()
      if (/\p{L}{2,}/u.test(value)) {
        push('comment', lineStart + indent, lineStart + line.length, value, null, currentPath(), {
          isKey: false,
        }, /^#+\s?/.exec(body)![0])
      }
      continue
    }

    // Unwind to this line's indentation level.
    while (stack.length && stack[stack.length - 1]!.indent >= indent) {
      const top = stack[stack.length - 1]!
      if (top.type === 'seq' && top.indent === indent && body.startsWith('- ')) break
      stack.pop()
    }

    let cursor = indent
    let rest = body

    // Sequence entry. `- ` may be followed by a scalar or by an inline mapping.
    if (rest.startsWith('- ') || rest === '-') {
      const top = stack[stack.length - 1]
      if (top?.type === 'seq' && top.indent === indent) top.index++
      else stack.push({ type: 'seq', indent, index: 0 })
      cursor += 2
      rest = rest.slice(2)
      if (rest.trim() === '') continue
    }

    const keyMatch = /^([^:#\n]+?)\s*:(?:\s|$)/.exec(rest)
    if (keyMatch) {
      const rawKey = keyMatch[1]!.trim()
      const key = unquote(rawKey)
      keys.add(key)
      // A key opened by `- ` sits two columns right of its line's indent, and
      // the following sibling keys align with IT, not with the dash. Recording
      // the line indent instead would nest every sibling under the first key —
      // `with:` would become a child of `uses:`.
      const keyIndent = cursor
      const top = stack[stack.length - 1]
      if (top?.type === 'map' && top.indent === keyIndent) top.key = key
      else stack.push({ type: 'map', indent: keyIndent, key })

      const valueStart = cursor + keyMatch[0].length
      const valueText = rest.slice(keyMatch[0].length)
      const path = currentPath()

      // Block scalar. The body is every following line indented deeper.
      const blockMatch = /^([|>])([-+]?)(\d*)\s*(#.*)?$/.exec(valueText.trim())
      if (blockMatch) {
        const block = readBlock(lines, li + 1, indent)
        if (block) {
          const container: Container = { isKey: false }
          push(
            'block-scalar',
            block.start,
            block.end,
            block.dedented,
            null,
            path,
            container,
          )
          if (nested) {
            // Children carry ABSOLUTE offsets. One coordinate system for the
            // whole run, or the patcher writes into the wrong file position.
            for (const child of nested(block.dedented, block.start + block.bodyIndent, path)) {
              sites.push(child)
            }
          }
          li = block.lastLine
        }
        continue
      }

      const trimmedValue = valueText.trim()
      if (trimmedValue === '' || trimmedValue.startsWith('#')) continue
      if (trimmedValue.startsWith('&') || trimmedValue.startsWith('*')) {
        skipped.push(`${file}:${li + 1}: anchor or alias`)
        continue
      }
      // Inline flow collections are left to the JSON lexer's shape; recording
      // the skip keeps the sweep honest about them.
      if (trimmedValue.startsWith('[') || trimmedValue.startsWith('{')) {
        skipped.push(`${file}:${li + 1}: flow collection`)
        continue
      }

      const scalar = readScalar(valueText, lineStart + valueStart)
      if (scalar && /\S/.test(scalar.value)) {
        push('scalar', scalar.start, scalar.end, scalar.value, scalar.quote, path)
      }
      continue
    }

    // A bare scalar as a sequence item.
    const scalar = readScalar(rest, lineStart + cursor)
    if (scalar && /\S/.test(scalar.value)) {
      push('scalar', scalar.start, scalar.end, scalar.value, scalar.quote, currentPath())
    }
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, keys, claimedBytes: claimed, complete, skipped }
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

interface Block {
  start: number
  end: number
  dedented: string
  bodyIndent: number
  lastLine: number
}

function readBlock(lines: Line[], from: number, parentIndent: number): Block | null {
  let bodyIndent = -1
  // `last` follows the final NON-EMPTY line. Trailing blank lines belong to the
  // document, not to the block — YAML's default `clip` chomping drops them, and
  // including them would put a spurious newline at the end of every translated
  // release-notes body.
  let last = from - 1
  for (let i = from; i < lines.length; i++) {
    const { text } = lines[i]!
    if (text.trim() === '') continue
    const indent = /^[ \t]*/.exec(text)![0].length
    if (indent <= parentIndent) break
    if (bodyIndent === -1) bodyIndent = indent
    last = i
  }
  if (bodyIndent === -1) return null

  const first = lines[from]!
  const lastLine = lines[last]!
  const start = first.start
  const end = lastLine.start + lastLine.text.length
  const dedented = lines
    .slice(from, last + 1)
    .map((l) => l.text.slice(Math.min(bodyIndent, /^[ \t]*/.exec(l.text)![0].length)))
    .join('\n')
  return { start, end, dedented, bodyIndent, lastLine: last }
}

interface Scalar {
  value: string
  start: number
  end: number
  quote: string | null
}

function readScalar(text: string, absoluteStart: number): Scalar | null {
  const leading = /^\s*/.exec(text)![0].length
  const rest = text.slice(leading)
  if (rest === '') return null
  const start = absoluteStart + leading

  const quote = rest[0]
  if (quote === '"' || quote === "'") {
    let value = ''
    let i = 1
    while (i < rest.length) {
      const c = rest[i]!
      if (quote === '"' && c === '\\') {
        value += unescapeYaml(rest[i + 1] ?? '')
        i += 2
        continue
      }
      // In single quotes, '' is an escaped quote.
      if (quote === "'" && c === "'" && rest[i + 1] === "'") {
        value += "'"
        i += 2
        continue
      }
      if (c === quote) return { value, start, end: start + i + 1, quote }
      value += c
      i++
    }
    return null
  }

  // Plain scalar: runs to an unquoted ` #` comment or end of line.
  const commentAt = rest.search(/\s+#/)
  const raw = commentAt === -1 ? rest : rest.slice(0, commentAt)
  const value = raw.trimEnd()
  return { value, start, end: start + value.length, quote: null }
}

function unescapeYaml(c: string): string {
  switch (c) {
    case 'n': return '\n'
    case 't': return '\t'
    case 'r': return '\r'
    case '0': return '\0'
    case '\\': return '\\'
    case '"': return '"'
    default: return c
  }
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Known gaps, all backstopped by the residual sweep:
 * complex keys (`? :`), anchors and aliases, flow collections, multi-document
 * streams beyond `---` separators, tag shorthands, and multi-line plain scalars.
 */
export const YAML_GAPS = [
  'complex keys (? :)',
  'anchors and aliases',
  'flow collections',
  'tag shorthands',
  'multi-line plain scalars',
]
