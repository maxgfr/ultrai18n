// Fluent `.ftl` — one site per pattern, exactly as an ICU message living in a
// JSON string is one site.
//
// The whole `{ $count -> … }` stays inside a single value and the PRIMITIVE
// parses it, rather than the extractor emitting a site per variant. That is not
// an economy: a variant is not independently translatable — the arity of the
// set changes with the target language — and giving each one its own site would
// hand a translator four fragments of one decision.
import type { Container, RawSite } from './raw'
import { lineBytes } from './raw'
import { pointer } from '../identity'
import { parseFluent } from '../plural/fluent'
import type { Span } from '../types'
import type { OffsetMap } from '../vendor/text'

export interface FtlExtractResult {
  sites: RawSite[]
  keys: Set<string>
  claimedBytes: number
  complete: boolean
  /** Junk entries the parser could not read, for the census reason. */
  skipped: string[]
}

export function extractFtl(file: string, text: string, map: OffsetMap): FtlExtractResult {
  const sites: RawSite[] = []
  const keys = new Set<string>()
  const skipped: string[] = []
  let claimed = 0
  let comments = 0

  const { entries, ok } = parseFluent(text)

  const push = (
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    value: string,
    path: string,
    container: Container = { isKey: false },
    prefix?: string,
    linePrefix?: string,
  ): void => {
    const span: Span = { start: map.byteOf(startChar), end: map.byteOf(endChar) }
    const s = map.lineColOf(startChar)
    const e = map.lineColOf(endChar)
    sites.push({
      file,
      path,
      kind,
      span,
      valueSpan: span,
      raw: text.slice(startChar, endChar),
      value,
      quote: null,
      escapes: false,
      // Deliberately empty. A placeable is not a `Hole`: `apply` splices a hole
      // back as `${expr}`, which is JavaScript template syntax, and a Fluent
      // `{ $userName }` written that way would render as literal `${$userName}`.
      // Placeables ride inside the value and the validators check them there.
      holes: [],
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'ftl',
      tier: 'structural',
      container,
      ...(prefix !== undefined ? { prefix, suffix: '', linePrefix: linePrefix ?? '' } : {}),
    })
  }

  for (const entry of entries) {
    if (entry.kind === 'junk') {
      skipped.push(`junk at line ${map.lineColOf(entry.start).line}`)
      continue
    }

    claimed += byteSpan(map, text, entry.start, entry.end)

    if (entry.kind === 'comment') {
      const raw = text.slice(entry.start, entry.end)
      const marker = /^#{1,3}\s?/.exec(raw)?.[0] ?? '# '
      const value = raw.slice(marker.length).trim()
      if (/\p{L}{2,}/u.test(value)) {
        push('comment', entry.start, entry.end, value, `#comment[${comments++}]`, { isKey: false }, marker)
      }
      continue
    }

    keys.add(entry.id)
    if (entry.value) {
      push('scalar', entry.value.start, entry.value.end, entry.value.text, pointer([entry.id]), {
        isKey: false,
      }, undefined, entry.value.indent)
    }
    for (const attr of entry.attributes) {
      keys.add(attr.name)
      push('scalar', attr.start, attr.end, attr.text, pointer([entry.id, `.${attr.name}`]), {
        isKey: false,
      }, undefined, attr.indent)
    }
  }

  // Blank lines between entries are claimed too: they are part of the file and
  // nothing in them was skipped.
  claimed += blankBytes(map, text, entries)

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, keys, claimedBytes: claimed, complete: ok, skipped }
}

function byteSpan(map: OffsetMap, text: string, start: number, end: number): number {
  return lineBytes(map, text, start, Math.max(0, end - start - 1))
}

/** Every byte no entry covered, which for a well-formed file is the blank lines. */
function blankBytes(map: OffsetMap, text: string, entries: { start: number; end: number; kind: string }[]): number {
  const covered = entries
    .filter((e) => e.kind !== 'junk')
    .map((e) => [e.start, e.end] as const)
    .sort((a, b) => a[0] - b[0])

  let total = 0
  let cursor = 0
  for (const [start, end] of covered) {
    if (start > cursor) total += map.byteOf(start) - map.byteOf(cursor)
    cursor = Math.max(cursor, end)
  }
  if (cursor < text.length) total += map.byteOf(text.length) - map.byteOf(cursor)
  return total
}
