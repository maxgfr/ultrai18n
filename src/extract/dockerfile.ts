// Dockerfile — instructions, not prose.
//
// This file used to be read by the plain-text extractor, which made
// `RUN apt-get install -y build-essential ca-certificates` a paragraph the
// classifier had to talk itself out of. Recall was fine and precision was poor,
// and the census reported `extractor: text` for a file that is not text in the
// sense that word is doing there.
//
// It also left `docker.label` — a well-formed, cited catalog rule — unable to
// fire in any repository, because that rule matches on a KEY and the prose
// extractor's key is `p[0]`. The rule was never wrong; nothing had ever given
// it a key to match. Emitting `/LABEL/org.opencontainers.image.description`
// fixes both problems with one reader.
import type { Container, RawSite } from './raw'
import { lineBytes } from './raw'
import { pointer } from '../identity'
import type { Span } from '../types'
import type { OffsetMap } from '../vendor/text'

export interface DockerfileExtractResult {
  sites: RawSite[]
  keys: Set<string>
  claimedBytes: number
}

/** `Dockerfile`, `Dockerfile.prod`, `web.dockerfile`, `Containerfile`. */
export function isDockerfile(rel: string): boolean {
  const name = rel.split('/').pop() ?? ''
  return (
    name === 'Dockerfile' ||
    name === 'Containerfile' ||
    name.startsWith('Dockerfile.') ||
    name.toLowerCase().endsWith('.dockerfile')
  )
}

/** The instructions whose values are metadata a person reads. */
const TEXTUAL = /^(LABEL|ENV|ARG)\b/i

export function extractDockerfile(file: string, text: string, map: OffsetMap): DockerfileExtractResult {
  const sites: RawSite[] = []
  const keys = new Set<string>()
  let claimed = 0
  let comments = 0

  const push = (
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    value: string,
    quote: string | null,
    path: string,
    container: Container = { isKey: false },
    prefix?: string,
    suffix?: string,
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
      extractor: 'dockerfile',
      tier: 'structural',
      container,
      ...(prefix !== undefined ? { prefix, suffix: suffix ?? '', linePrefix: '' } : {}),
    })
  }

  const lines = splitLines(text)

  for (let li = 0; li < lines.length; li++) {
    const { text: line, start } = lines[li]!
    claimed += lineBytes(map, text, start, line.length)
    const body = line.trim()
    if (body === '') continue

    if (body.startsWith('#')) {
      // `# syntax=` and friends are parser directives, not prose.
      if (/^#\s*[a-z]+\s*=/.test(body)) continue
      const marker = /^#+\s?/.exec(body)![0]
      const value = body.slice(marker.length).trim()
      if (/\p{L}{2,}/u.test(value)) {
        const at = start + line.indexOf('#')
        push('comment', at, at + body.length, value, null, `#comment[${comments++}]`, { isKey: false }, marker)
      }
      continue
    }

    const instruction = /^([A-Za-z]+)\b/.exec(body)?.[1]?.toUpperCase()
    if (!instruction || !TEXTUAL.test(body)) {
      // FROM, RUN, COPY, CMD, WORKDIR… read, and judged non-textual. That
      // judgement is exactly what `claimRatio` records: the line was looked at.
      // A continuation line of one of them lands here too.
      continue
    }

    // A `\` at end of line continues the instruction. The joined form is only
    // used to FIND pairs; every offset is computed against the original text,
    // because a rebuilt string cannot address the file.
    let last = li
    while (lines[last]!.text.trimEnd().endsWith('\\') && last + 1 < lines.length) {
      last++
      claimed += lineBytes(map, text, lines[last]!.start, lines[last]!.text.length)
    }

    const from = start
    const to = lines[last]!.start + lines[last]!.text.length
    const region = text.slice(from, to)

    let found = 0
    for (const m of region.matchAll(/([A-Za-z0-9_.\-]+)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s\\]+)/g)) {
      const key = m[1]!
      const rawValue = m[2]!
      keys.add(key)
      found++
      const at = from + (m.index ?? 0) + m[0]!.length - rawValue.length
      const quoted = rawValue.startsWith('"') || rawValue.startsWith("'")
      const value = quoted ? unquote(rawValue) : rawValue
      if (!/\p{L}{2,}/u.test(value)) continue
      push(
        'scalar',
        at,
        at + rawValue.length,
        value,
        quoted ? rawValue[0]! : null,
        pointer([instruction, key]),
        { isKey: false, attrName: key },
        // An unquoted value gets quotes on write, because a translation with a
        // space in it is not a legal bare Dockerfile value.
        quoted ? undefined : '"',
        quoted ? undefined : '"',
      )
    }

    if (found === 0) {
      // The legacy `LABEL key value` form, still valid and still in use.
      const legacy = /^(LABEL|ENV|ARG)\s+([A-Za-z0-9_.\-]+)\s+(.+)$/i.exec(region.trim())
      if (legacy) {
        const key = legacy[2]!
        const rawValue = legacy[3]!.trim()
        keys.add(key)
        const at = from + region.lastIndexOf(rawValue)
        const quoted = rawValue.startsWith('"') || rawValue.startsWith("'")
        const value = quoted ? unquote(rawValue) : rawValue
        if (/\p{L}{2,}/u.test(value)) {
          push(
            'scalar',
            at,
            at + rawValue.length,
            value,
            quoted ? rawValue[0]! : null,
            pointer([instruction, key]),
            { isKey: false, attrName: key },
            quoted ? undefined : '"',
            quoted ? undefined : '"',
          )
        }
      }
    }

    li = last
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, keys, claimedBytes: claimed }
}

function unquote(s: string): string {
  const body = s.slice(1, -1)
  return s[0] === '"' ? body.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c)) : body
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
