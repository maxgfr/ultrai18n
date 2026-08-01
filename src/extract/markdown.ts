// Markdown extraction.
//
// Emits typed, byte-anchored prose RUNS rather than cleaned lines. The
// difference matters at write-back time: a run leaves the markup untouched
// because it never consumed it, so the patcher never has to reconstruct
// emphasis, links or lists — a reconstruction that is wrong exactly often
// enough to be dangerous.
import type { Span } from '../types'
import { lineBytes, type RawSite } from './raw'
import { OffsetMap } from '../vendor/text'

export interface MarkdownExtractResult {
  sites: RawSite[]
  claimedBytes: number
  /** Heading slugs, so a translated heading's dangling anchors can be detected. */
  headings: { text: string; slug: string; line: number }[]
}

const FENCE = /^(\s*)(```+|~~~+)(.*)$/
const HEADING = /^(\s*)(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/
const BLOCKQUOTE = /^(\s*>+\s?)/
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_SEP = /^[\s|:-]+$/
const HTML_BLOCK = /^\s*<\/?[a-zA-Z][^>]*>/
const REF_DEF = /^\s*\[[^\]]+\]:\s+\S+/

/** Inline constructs whose TEXT is prose but whose target is not. */
const INLINE_CODE = /`[^`]*`/g
const LINK = /\[([^\]]*)\]\(([^)]*)\)/g
const IMAGE = /!\[([^\]]*)\]\(([^)]*)\)/g
const AUTOLINK = /<https?:\/\/[^>]+>|https?:\/\/\S+/g

export function extractMarkdown(
  file: string,
  text: string,
  map: OffsetMap,
  /** Offset of this text within its host file, for markdown nested in YAML. */
  baseOffset = 0,
): MarkdownExtractResult {
  const sites: RawSite[] = []
  const headings: { text: string; slug: string; line: number }[] = []
  let claimed = 0

  const lines: { text: string; start: number }[] = []
  {
    let start = 0
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text[i] === '\n') {
        lines.push({ text: text.slice(start, i), start })
        start = i + 1
      }
    }
  }

  let inFence = false
  let fenceMarker = ''
  let paragraph: { start: number; end: number; text: string } | null = null
  let blockIndex = 0

  const flush = (): void => {
    if (!paragraph) return
    emitRuns(paragraph.text, paragraph.start, `p[${blockIndex++}]`)
    paragraph = null
  }

  const emitRuns = (raw: string, startChar: number, pathPrefix: string): void => {
    // Blank out what is not prose, preserving length so offsets stay valid.
    // Rebuilding the string would desynchronise every span after the first
    // replacement, which is the classic way these extractors corrupt files.
    let masked = raw
    masked = blank(masked, INLINE_CODE)
    masked = blank(masked, IMAGE, (m) => keepGroup(m, 1))
    masked = blank(masked, LINK, (m) => keepGroup(m, 1))
    masked = blank(masked, AUTOLINK)

    let runIndex = 0
    // `m` is load-bearing. Without it `$` means end of the whole BLOCK, and a
    // run may not cross a newline — so in a hard-wrapped paragraph only the
    // last line could ever satisfy the lookahead, and every line above it was
    // silently dropped while `claimedBytes` still reported the whole file. A
    // three-line paragraph yielded one site and a claimRatio of 1.0.
    //
    // Hard-wrapped prose is the normal way markdown is written, so this was the
    // single largest recall hole in the tool: on one real repository it lost
    // most of the body text of 192 files while reporting them fully read.
    for (const match of masked.matchAll(/[^\s][^\n]*?(?=\s{2,}|$)/gm)) {
      const at = match.index ?? 0
      const slice = match[0]
      const trimmed = slice.trimEnd()
      if (!/\p{L}{2,}/u.test(trimmed)) continue
      const from = startChar + at
      const to = from + trimmed.length
      sites.push(
        makeSite(file, `${pathPrefix}/text[${runIndex++}]`, 'prose-run', from, to, raw.slice(at, at + trimmed.length), map, baseOffset),
      )
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const { text: line, start } = lines[i]!
    claimed += lineBytes(map, text, start, line.length)

    const fence = FENCE.exec(line)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[2]!
      } else if (fence[2]!.startsWith(fenceMarker[0]!)) {
        inFence = false
      }
      flush()
      continue
    }
    // Code inside a fence is not prose. Claimed, not emitted.
    if (inFence) continue

    if (line.trim() === '') {
      flush()
      continue
    }
    if (REF_DEF.test(line) || HTML_BLOCK.test(line)) {
      flush()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      const body = heading[3]!
      const at = start + heading[1]!.length + heading[2]!.length + 1
      headings.push({ text: body, slug: slugify(body), line: i + 1 })
      if (/\p{L}{2,}/u.test(body)) {
        sites.push(makeSite(file, `h${heading[2]!.length}[${blockIndex++}]`, 'prose-run', at, at + body.length, body, map, baseOffset))
      }
      continue
    }

    const table = TABLE_ROW.exec(line)
    if (table && !TABLE_SEP.test(table[1]!)) {
      flush()
      let cursor = start + line.indexOf('|') + 1
      let cell = 0
      for (const part of table[1]!.split('|')) {
        const trimmedStart = part.length - part.trimStart().length
        const body = part.trim()
        if (/\p{L}{2,}/u.test(body)) {
          const from = cursor + trimmedStart
          sites.push(makeSite(file, `table[${blockIndex}]/cell[${cell}]`, 'prose-run', from, from + body.length, body, map, baseOffset))
        }
        cursor += part.length + 1
        cell++
      }
      blockIndex++
      continue
    }

    const list = LIST_ITEM.exec(line)
    const quote = BLOCKQUOTE.exec(line)
    const offset = list ? list[0]!.length : quote ? quote[1]!.length : 0
    const body = line.slice(offset)

    if (list || quote) {
      flush()
      emitRuns(body, start + offset, `li[${blockIndex++}]`)
      continue
    }

    // Ordinary paragraph text; accumulate so a wrapped sentence is one run.
    if (paragraph) {
      paragraph.text += '\n' + body
      paragraph.end = start + line.length
    } else {
      paragraph = { start: start + offset, end: start + line.length, text: body }
    }
  }
  flush()

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, claimedBytes: claimed, headings }
}

function blank(s: string, re: RegExp, keep?: (m: RegExpExecArray) => string): string {
  return s.replace(new RegExp(re.source, re.flags), (...args) => {
    const match = args.slice(0, -2) as unknown as RegExpExecArray
    const whole = args[0] as string
    if (!keep) return ' '.repeat(whole.length)
    return keep(match)
  })
}

/** Blank everything but one capture group, preserving total length. */
function keepGroup(m: RegExpExecArray, group: number): string {
  const whole = m[0] as unknown as string
  const inner = (m[group] ?? '') as string
  const at = whole.indexOf(inner)
  if (at === -1 || inner === '') return ' '.repeat(whole.length)
  return ' '.repeat(at) + inner + ' '.repeat(whole.length - at - inner.length)
}

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function makeSite(
  file: string,
  path: string,
  kind: RawSite['kind'],
  startChar: number,
  endChar: number,
  value: string,
  map: OffsetMap,
  baseOffset: number,
): RawSite {
  const span: Span = { start: baseOffset + map.byteOf(startChar), end: baseOffset + map.byteOf(endChar) }
  const s = map.lineColOf(startChar)
  const e = map.lineColOf(endChar)
  return {
    file,
    path,
    kind,
    span,
    valueSpan: span,
    raw: value,
    value: value.trim(),
    quote: null,
    escapes: false,
    holes: [],
    line: s.line,
    col: s.col,
    endLine: e.line,
    endCol: e.col,
    extractor: 'markdown',
    tier: 'structural',
    container: { isKey: false },
  }
}
