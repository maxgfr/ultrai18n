// Two keyed catalog formats. Parsing and encoding share the same escape
// contract; unsupported syntax invalidates the file, never a guessed subset.
import { pointer } from '../identity'
import type { OffsetMap } from '../text'
import type { RawSite } from './raw'

export type CatalogFormat = 'strings' | 'properties'

export function decodeCatalog(raw: string, format: CatalogFormat): string {
  const text = format === 'properties' ? raw.replace(/\\\r?\n[ \t\f]*/g, '') : raw
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch !== '\\') { out += ch; continue }
    const next = text[++i]
    if (next === undefined) throw new Error('unterminated escape')
    if (next === 'u' || (format === 'strings' && next === 'U')) {
      const hex = text.slice(i + 1, i + 5)
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('invalid Unicode escape')
      out += String.fromCharCode(parseInt(hex, 16)); i += 4
    } else if ('nrtf'.includes(next)) {
      out += ({ n: '\n', r: '\r', t: '\t', f: '\f' } as Record<string, string>)[next]
    } else if (next === 'b' && format === 'strings') out += '\b'
    else if (format === 'properties' || next === '"' || next === '\\') out += next
    else throw new Error(`unsupported escape \\${next}`)
  }
  return out
}

export function encodeCatalog(text: string, format: CatalogFormat): string {
  let out = ''
  // ASCII escapes make properties independent of the consumer's UTF8/Latin1
  // choice, and preserve supplementary characters as UTF16 surrogate pairs.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!, code = text.charCodeAt(i)
    if (ch === '\\') out += '\\\\'
    else if (ch === '"' && format === 'strings') out += '\\"'
    else if (ch === ' ' && format === 'properties' && i === 0) out += '\\ '
    else if (code < 32 || code > 126) out += `\\${format === 'strings' ? 'U' : 'u'}${code.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out
}

/** Preserve printf/NSString and simple MessageFormat tokens as multisets. */
export function catalogPlaceholders(text: string): string[] {
  return (text.match(/%%|%(?:\d+\$)?[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?(?:hh|ll|[hlLzjtq])?[@diuoxXfFeEgGaAcCsSpn]|\{\d+(?:,[^{}]*)?\}/g) ?? []).sort()
}

export function extractCatalog(file: string, text: string, map: OffsetMap, format: CatalogFormat): {
  sites: RawSite[]; keys: Set<string>; claimedBytes: number; complete: boolean; problem?: string
} {
  const sites: RawSite[] = [], keys = new Set<string>()
  function emit(key: string, start: number, end: number, quote: string | null) {
    if (keys.has(key)) throw new Error(`duplicate key ${JSON.stringify(key)}`)
    keys.add(key)
    const a = map.lineColOf(start), b = map.lineColOf(end)
    const valueStart = start + (quote ? 1 : 0), valueEnd = end - (quote ? 1 : 0)
    sites.push({ file, path: pointer([key]), kind: 'scalar',
      span: { start: map.byteOf(start), end: map.byteOf(end) },
      valueSpan: { start: map.byteOf(valueStart), end: map.byteOf(valueEnd) },
      raw: text.slice(start, end), value: decodeCatalog(text.slice(valueStart, valueEnd), format),
      quote, escapes: true, holes: [], line: a.line, col: a.col, endLine: b.line, endCol: b.col,
      extractor: format, tier: 'structural', container: { isKey: false },
    })
  }
  try {
    if (format === 'strings') {
      let i = 0
      const skip = () => {
        for (;;) {
          while (/\s/.test(text[i] ?? '') && i < text.length) i++
          if (text.startsWith('//', i)) { i = text.indexOf('\n', i); if (i < 0) i = text.length }
          else if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2)
            if (end < 0) throw new Error('unterminated comment')
            i = end + 2
          } else break
        }
      }
      const quoted = () => {
        const start = i
        if (text[i++] !== '"') throw new Error('expected a double-quoted string')
        while (i < text.length) {
          if (text[i] === '\n' || text[i] === '\r') throw new Error('literal multiline strings are unsupported; use escapes')
          if (text[i] === '\\') { i += 2; continue }
          if (text[i++] === '"') return { start, end: i }
        }
        throw new Error('unterminated quoted string')
      }
      skip()
      while (i < text.length) {
        const key = quoted(), decoded = decodeCatalog(text.slice(key.start + 1, key.end - 1), format)
        skip(); if (text[i++] !== '=') throw new Error('expected =')
        skip(); const value = quoted(); skip()
        if (text[i++] !== ';') throw new Error('expected ;')
        emit(decoded, value.start, value.end, '"'); skip()
      }
    } else {
      if (/\r(?!\n)/.test(text)) throw new Error('CR-only properties lines are unsupported; use LF or CRLF')
      let start = 0
      while (start < text.length) {
        let end = text.indexOf('\n', start)
        if (end < 0) end = text.length
        let contentEnd = end > start && text[end - 1] === '\r' ? end - 1 : end
        const line = text.slice(start, contentEnd)
        if (/^[ \t\f]*(?:[#!]|$)/.test(line)) { start = end + 1; continue }
        let i = start
        while (/[ \t\f]/.test(text[i] ?? '') && i < contentEnd) i++
        const keyStart = i
        while (i < contentEnd) {
          if (text[i] === '\\') { i += 2; continue }
          if (/[=: \t\f]/.test(text[i]!)) break
          i++
        }
        if (i > contentEnd) throw new Error('continued keys are unsupported')
        if (i === contentEnd) throw new Error('properties keys without a separator are unsupported; use key=')
        const key = decodeCatalog(text.slice(keyStart, i), format)
        while (i < contentEnd && /[ \t\f]/.test(text[i]!)) i++
        if (text[i] === '=' || text[i] === ':') i++
        while (i < contentEnd && /[ \t\f]/.test(text[i]!)) i++
        const valueStart = i
        while ((/\\+$/.exec(text.slice(start, contentEnd))?.[0].length ?? 0) % 2 === 1) {
          if (end === text.length) throw new Error('unterminated continuation')
          end = text.indexOf('\n', end + 1)
          if (end < 0) end = text.length
          contentEnd = text[end - 1] === '\r' ? end - 1 : end
        }
        emit(key, valueStart, contentEnd, null)
        start = end + 1
      }
    }
    return { sites, keys, claimedBytes: map.byteOf(text.length), complete: true }
  } catch (error) {
    return { sites: [], keys: new Set(), claimedBytes: 0, complete: false, problem: (error as Error).message }
  }
}
