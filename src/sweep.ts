// The residual sweep — the backstop that makes the recall claim checkable.
//
// Every extractor claims spans: the ones it emitted as sites, and the ones it
// looked at and judged non-textual. The complement of those claims is what
// nobody accounted for. Human-looking text in that complement becomes an
// `unclassified` site, and `check` refuses to pass while one remains.
//
// That is a weaker guarantee than "we find everything", and deliberately so.
// It does not say a miss is impossible; it says a miss cannot be IGNORED. For a
// static tool that is the strongest honest claim available, and unlike the
// other one it can be tested.
import type { Span } from './types'
import type { RawSite } from './extract/raw'
import { OffsetMap } from './vendor/text'

export interface SweepOptions {
  /**
   * Every identifier the repository declares: symbols, JSON and YAML keys, CSS
   * classes, dependency names, path segments.
   *
   * This is what keeps the sweep usable. A lone word that the repository itself
   * declares somewhere is code, not prose — no dictionary, no network, and it
   * removes the large majority of false residuals.
   */
  identifiers: Set<string>
  /** Which extractor owned this file, for the `whyUnclaimed` note. */
  extractor: string
  reason?: string
}

export function sweepFile(
  file: string,
  text: string,
  map: OffsetMap,
  claimed: Span[],
  opts: SweepOptions,
): RawSite[] {
  const bytes = Buffer.from(text, 'utf8')
  const gaps = complement(merge(claimed), bytes.length)
  const out: RawSite[] = []
  let index = 0

  for (const gap of gaps) {
    const slice = bytes.subarray(gap.start, gap.end).toString('utf8')
    for (const run of humanLookingRuns(slice, opts.identifiers)) {
      const startByte = gap.start + Buffer.byteLength(slice.slice(0, run.at), 'utf8')
      const endByte = startByte + Buffer.byteLength(run.text, 'utf8')
      const startChar = charIndexOfByte(text, startByte)
      const s = map.lineColOf(startChar)
      const e = map.lineColOf(startChar + run.text.length)
      out.push({
        file,
        path: `~sweep[${index++}]`,
        kind: 'prose-run',
        span: { start: startByte, end: endByte },
        valueSpan: { start: startByte, end: endByte },
        raw: run.text,
        value: run.text,
        quote: null,
        escapes: false,
        holes: [],
        line: s.line,
        col: s.col,
        endLine: e.line,
        endCol: e.col,
        extractor: 'residual-sweep',
        tier: 'sweep',
        container: { isKey: false },
        // Every residual is an extractor bug report: it names who owned the
        // file and why the span went unclaimed.
        whyUnclaimed: opts.reason ?? `${opts.extractor}: the span was not claimed`,
      })
    }
  }
  return out
}

const SEPARATOR = /[^\p{L}\p{M}\p{Nd}.,;:!?'’"“”()[\]\-–—/&%…«»  ]+/u
const IDENTIFIER_SHAPE = /^(?:[A-Z][A-Z0-9_]*|[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+|[\w]+[-_][\w-]+)$/
const NOT_PROSE = /^(?:[0-9a-f]{7,}|[A-Za-z0-9+/=]{20,}|v?\d+(\.\d+)+|\d{4}-\d{2}-\d{2}|[\d.,%+-]+)$/i

interface Run {
  text: string
  at: number
}

/**
 * A run qualifies as human-looking when it has at least two words, or one long
 * word the repository does not itself declare.
 *
 * Erring toward false positives is deliberate: a false residual costs one
 * adjudication, once, and is then baselined. A false negative is the failure
 * this whole tool exists to prevent.
 */
export function humanLookingRuns(text: string, identifiers: Set<string>): Run[] {
  const out: Run[] = []
  let offset = 0
  for (const chunk of text.split(SEPARATOR)) {
    const at = text.indexOf(chunk, offset)
    offset = at + chunk.length
    const trimmed = chunk.trim()
    if (trimmed.length < 3) continue

    const words = trimmed.match(/\p{L}{2,}/gu) ?? []
    if (words.length === 0) continue

    const letters = (trimmed.match(/\p{L}/gu) ?? []).length
    if (letters / trimmed.length < 0.5) continue
    if (NOT_PROSE.test(trimmed)) continue
    if (IDENTIFIER_SHAPE.test(trimmed)) continue

    // A word the repository declares somewhere is code. Compound identifiers
    // are split before comparing, so `btn-primary` does not read as the two
    // ordinary words `btn` and `primary` once the hyphen breaks it up.
    const known = (w: string): boolean =>
      identifiers.has(w) ||
      identifiers.has(w.toLowerCase()) ||
      [...identifiers].some((id) => id.length > w.length && id.split(/[-_.]/).includes(w))
    const prose = words.filter((w) => !known(w))

    if (words.length === 1) {
      if (words[0]!.length < 4) continue
      if (prose.length === 0) continue
      if (trimmed.length < 12) continue
    } else {
      // Two words is only prose if something separates them like prose does.
      if (!/[\s ]/.test(trimmed) && !/[,;:!?]/.test(trimmed)) continue
      // A run made mostly of names the repository itself uses is a list of
      // identifiers that happens to contain spaces, not a sentence.
      if (prose.length < 2 || prose.length / words.length < 0.5) continue
    }

    const start = at + (chunk.length - chunk.trimStart().length)
    out.push({ text: trimmed, at: start })
  }
  return out
}

export function merge(spans: Span[]): Span[] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const out: Span[] = [{ ...sorted[0]! }]
  for (const span of sorted.slice(1)) {
    const last = out[out.length - 1]!
    if (span.start <= last.end) last.end = Math.max(last.end, span.end)
    else out.push({ ...span })
  }
  return out
}

export function complement(merged: Span[], total: number): Span[] {
  const out: Span[] = []
  let cursor = 0
  for (const span of merged) {
    if (span.start > cursor) out.push({ start: cursor, end: span.start })
    cursor = Math.max(cursor, span.end)
  }
  if (cursor < total) out.push({ start: cursor, end: total })
  return out
}

function charIndexOfByte(text: string, byte: number): number {
  // Fast path: pure ASCII means the two coordinate systems coincide.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(text)) return byte
  let seen = 0
  for (let i = 0; i < text.length; i++) {
    if (seen >= byte) return i
    seen += Buffer.byteLength(text[i]!, 'utf8')
  }
  return text.length
}
