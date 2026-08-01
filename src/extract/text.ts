// Plain-text extraction.
//
// Exists for the files with no extension that every repository has and every
// extension-driven scanner skips: LICENSE, NOTICE, AUTHORS, CHANGELOG, CODEOWNERS.
// LICENSE in particular must be READ in order to be protected — a rule that says
// "never translate this file" cannot fire on a file no extractor ever opened.
import type { Span } from '../types'
import type { RawSite } from './raw'
import { OffsetMap } from '../vendor/text'

export interface TextExtractResult {
  sites: RawSite[]
  claimedBytes: number
}

/**
 * Extensionless files worth reading as prose.
 *
 * `Dockerfile` is deliberately absent: it has its own extractor now, and
 * leaving the name here as well would make routing ORDER the only thing
 * deciding which reader wins — a trap for whoever moves a branch next.
 */
export const PLAIN_TEXT_BASENAMES = new Set([
  'LICENSE', 'LICENCE', 'COPYING', 'NOTICE', 'AUTHORS', 'CONTRIBUTORS',
  'CHANGELOG', 'README', 'INSTALL', 'TODO', 'CODEOWNERS', 'Makefile',
])

export const PLAIN_TEXT_EXT = new Set(['.txt', '.text', '.rst', '.adoc', '.asciidoc'])

export function isPlainText(rel: string, ext: string): boolean {
  if (PLAIN_TEXT_EXT.has(ext)) return true
  if (ext !== '') return false
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  return PLAIN_TEXT_BASENAMES.has(base) || PLAIN_TEXT_BASENAMES.has(base.toUpperCase())
}

export function extractText(file: string, text: string, map: OffsetMap): TextExtractResult {
  const sites: RawSite[] = []
  let index = 0
  let start = 0
  let buffer: { from: number; to: number } | null = null

  const flush = (): void => {
    if (!buffer) return
    const value = text.slice(buffer.from, buffer.to)
    if (/\p{L}{2,}/u.test(value)) {
      sites.push(makeSite(file, `p[${index++}]`, buffer.from, buffer.to, value, map))
    }
    buffer = null
  }

  // Paragraphs, split on blank lines. Comment markers are left alone: in a
  // plain-text file a leading `#` is usually a heading, not a comment.
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      const line = text.slice(start, i)
      if (line.trim() === '') flush()
      else if (buffer) buffer.to = i
      else buffer = { from: start + (line.length - line.trimStart().length), to: i }
      start = i + 1
    }
  }
  flush()

  return { sites, claimedBytes: map.byteOf(text.length) }
}

function makeSite(
  file: string,
  path: string,
  startChar: number,
  endChar: number,
  value: string,
  map: OffsetMap,
): RawSite {
  const span: Span = { start: map.byteOf(startChar), end: map.byteOf(endChar) }
  const s = map.lineColOf(startChar)
  const e = map.lineColOf(endChar)
  return {
    file,
    path,
    kind: 'prose-run',
    span,
    valueSpan: span,
    raw: value,
    value,
    quote: null,
    escapes: false,
    holes: [],
    line: s.line,
    col: s.col,
    endLine: e.line,
    endCol: e.col,
    extractor: 'text',
    tier: 'structural',
    container: { isKey: false },
  }
}
