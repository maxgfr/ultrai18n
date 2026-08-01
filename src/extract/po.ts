// gettext `.po` / `.pot` — the format most worth reading and the one that was
// least readable.
//
// A PO file is line-oriented and almost entirely comments and keyword lines, so
// a line scanner reads all of it and `claimRatio` is a real 1.0 rather than an
// assertion. That matters beyond tidiness: `sweep` only calls an oracle hit a
// CONFIRMED miss when the file's ratio is 1 under a measured extractor, so a
// format read this way can contradict the engine, and one read by the residual
// sweep can only ever produce candidates.
//
// Anchors are content-addressed on the entry's own identity rather than on its
// position in the file, because `msgmerge` regenerates these files constantly
// and reorders entries freely. A positional anchor would drift on every
// regeneration and every pinned exception would quietly stop applying.
import type { Container, RawSite } from './raw'
import { lineBytes } from './raw'
import { pointer } from '../identity'
import type { Span } from '../types'
import type { OffsetMap } from '../vendor/text'

export interface PoExtractResult {
  sites: RawSite[]
  keys: Set<string>
  claimedBytes: number
  complete: boolean
  /**
   * The catalog's `Plural-Forms:` header, verbatim and UNEVALUATED.
   *
   * Carried so a reader can see it was read and not used. `plural=` is a C
   * expression this engine does not evaluate, which is exactly why the gettext
   * dialect is `cldr: false` and its indices are positions rather than
   * categories.
   */
  pluralForms: string | null
  /** Anchors of entries carrying `#, fuzzy`. */
  fuzzy: string[]
  /** Anchors of obsolete (`#~`) entries. */
  obsolete: string[]
}

/** `msgid`, `msgstr[0]`, `msgctxt`, `msgid_plural` — optionally behind `#~`. */
const KEYWORD = /^(#~\s*)?(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s*(.*)$/

export function extractPo(file: string, text: string, map: OffsetMap): PoExtractResult {
  const sites: RawSite[] = []
  const keys = new Set<string>()
  const fuzzy: string[] = []
  const obsolete: string[] = []
  let pluralForms: string | null = null
  let claimed = 0
  let complete = true

  const lines = splitLines(text)

  // Per-entry state. An entry runs until a blank line, and its identity — the
  // `msgctxt` and `msgid` — is only known once both have been read, so sites
  // are buffered and re-anchored when the entry closes.
  let pending: Pending = fresh()

  const push = (
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    value: string,
    quote: string | null,
    leaf: string,
    container: Container = { isKey: false },
    prefix?: string,
  ): void => {
    const span: Span = { start: map.byteOf(startChar), end: map.byteOf(endChar) }
    const valueSpan: Span = quote
      ? { start: map.byteOf(startChar + 1), end: map.byteOf(endChar - 1) }
      : span
    const s = map.lineColOf(startChar)
    const e = map.lineColOf(endChar)
    pending.sites.push({
      leaf,
      site: {
        file,
        path: leaf,
        kind,
        span,
        valueSpan,
        raw: text.slice(startChar, endChar),
        value,
        quote,
        escapes: /\\/.test(text.slice(startChar, endChar)),
        holes: [],
        line: s.line,
        col: s.col,
        endLine: e.line,
        endCol: e.col,
        extractor: 'po',
        tier: 'structural',
        container,
        ...(prefix !== undefined ? { prefix, suffix: '', linePrefix: '' } : {}),
      },
    })
  }

  const close = (): void => {
    if (pending.sites.length) {
      // The header entry — an empty msgid whose msgstr holds the metadata — is
      // machinery, not copy. It is read (so the bytes are claimed and
      // `Plural-Forms:` is captured) and emits nothing.
      if (pending.msgid !== '') {
        const base = entryBase(pending)
        if (pending.fuzzy) fuzzy.push(base)
        if (pending.obsolete) obsolete.push(base)
        for (const { leaf, site } of pending.sites) {
          site.path = `${base}/${leaf}`
          if (pending.obsolete) {
            // gettext's own machine-readable way of saying "this entry is
            // dead". `classify` honours `untranslatable` before any rule, for
            // Android's `translatable="false"`, and an obsolete PO entry is
            // precisely that: the format itself declaring the text out of
            // service. Reusing the mechanism beats inventing a second one.
            site.container = { ...site.container, untranslatable: true }
          }
          if (pending.fuzzy && !site.container.nearestComment) {
            site.container = { ...site.container, nearestComment: 'gettext flag: fuzzy' }
          }
          sites.push(site)
        }
      }
    }
    pending = fresh()
  }

  for (let li = 0; li < lines.length; li++) {
    const { text: line, start } = lines[li]!
    claimed += lineBytes(map, text, start, line.length)
    const body = line.trim()

    if (body === '') {
      close()
      continue
    }

    // `#~` marks an obsolete entry and prefixes every one of its lines,
    // including the keyword lines, which is why KEYWORD tolerates it.
    if (body.startsWith('#~')) pending.obsolete = true

    if (body.startsWith('#') && !body.startsWith('#~')) {
      // `#:` is a source reference and `#|` is a merge artifact — read, and
      // never text. `#,` carries flags. `#.` and a bare `#` are prose a human
      // wrote and a human reads.
      if (body.startsWith('#,')) {
        if (/\bfuzzy\b/.test(body)) pending.fuzzy = true
        continue
      }
      if (body.startsWith('#:') || body.startsWith('#|')) continue
      const marker = /^#[.\s]?\s?/.exec(body)![0]
      const value = body.slice(marker.length).trim()
      if (/\p{L}{2,}/u.test(value)) {
        const at = start + line.indexOf('#')
        push(
          'comment',
          at,
          at + body.length,
          value,
          null,
          `#comment[${pending.comments++}]`,
          { isKey: false },
          marker,
        )
      }
      continue
    }

    const m = KEYWORD.exec(body)
    if (!m) continue

    const keyword = m[2]!
    const index = m[3]
    const rest = m[4] ?? ''
    const keywordAt = start + line.indexOf(keyword)

    // A PO string may continue over any number of following lines, each one a
    // fresh quoted run. They are ONE site spanning the whole group: the value
    // is the concatenation, and `apply` rebuilds the span as a single quoted
    // string, which is valid PO and is honest about what it rewrote.
    const run = readString(lines, li, rest, start + line.length - rest.length)
    if (!run.terminated) complete = false

    const leaf = index !== undefined ? `msgstr[${index}]` : keyword
    keys.add(leaf)

    if (keyword === 'msgctxt') pending.msgctxt = run.value
    if (keyword === 'msgid') pending.msgid = run.value
    if (keyword === 'msgid_plural') pending.plural = true
    if (keyword === 'msgstr' && pending.msgid === '') {
      const found = /^Plural-Forms:\s*(.*)$/m.exec(run.value.replace(/\\n/g, '\n'))
      if (found) pluralForms = found[1]!.trim()
    }

    // An EMPTY `msgstr` is emitted, and it is the most useful site in the file.
    //
    // It is an untranslated slot — a hole in the catalog — which is precisely
    // what somebody running this tool wants to be shown, and it is the only way
    // `apply` gets byte offsets to write a translation into. Skipping it as
    // "no text here" was measurably wrong: the real-repository sweep turned
    // every one into a CONFIRMED MISS, which is the strongest accusation this
    // project makes, and it was right to.
    //
    // Only an empty `msgctxt` is dropped, because a context that says nothing
    // disambiguates nothing.
    if (run.value !== '' || keyword !== 'msgctxt') {
      push(
        keyword === 'msgctxt' ? 'key' : 'scalar',
        run.start,
        run.end,
        run.value,
        run.multiline ? null : '"',
        leaf,
        // A `msgctxt` disambiguates two identical msgids; it is an identifier,
        // not copy, and `classify` decides a key structurally before any rule.
        keyword === 'msgctxt' ? { isKey: true } : { isKey: false },
        run.multiline ? '"' : undefined,
      )
      if (run.multiline) {
        const last = pending.sites[pending.sites.length - 1]!.site
        last.suffix = '"'
      }
    }
  }
  close()

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, keys, claimedBytes: claimed, complete, pluralForms, fuzzy, obsolete }
}

interface Pending {
  sites: { leaf: string; site: RawSite }[]
  msgctxt: string | null
  msgid: string | null
  plural: boolean
  fuzzy: boolean
  obsolete: boolean
  comments: number
}

function fresh(): Pending {
  return { sites: [], msgctxt: null, msgid: null, plural: false, fuzzy: false, obsolete: false, comments: 0 }
}

/**
 * The entry's anchor: its context and id, which is what gettext itself keys on.
 *
 * Truncated, because a msgid may be a paragraph and an anchor holding one is
 * unreadable in every report that prints it. Collisions after truncation are
 * resolved by `disambiguatePaths` like any other.
 */
function entryBase(p: Pending): string {
  const id = (p.msgid ?? '').slice(0, 80)
  // EOT, which is gettext's own context glue: `msgctxt` and `msgid` are keyed
  // together that way inside a compiled `.mo`, so borrowing the separator keeps
  // the anchor faithful to how the runtime itself identifies the entry. Written
  // as an escape rather than as a literal control byte, which is invisible in a
  // diff and easy to lose in a copy.
  const key = p.msgctxt ? `${p.msgctxt}\u0004${id}` : id
  return (p.obsolete ? '/~obsolete' : '') + pointer([key])
}

interface StringRun {
  value: string
  start: number
  end: number
  multiline: boolean
  terminated: boolean
}

/**
 * Read a quoted PO string and every continuation line following it.
 *
 * Continuations are the reason this cannot be a per-line regex: `msgid ""`
 * followed by three quoted lines is one value, and treating each line as its
 * own site would hand a translator three fragments of one sentence.
 */
function readString(lines: Line[], from: number, first: string, firstAt: number): StringRun {
  const parts: string[] = []
  let terminated = true
  let end = firstAt
  let multiline = false

  const take = (raw: string, at: number): boolean => {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('"')) return false
    const closing = closingQuote(trimmed)
    if (closing < 0) {
      terminated = false
      parts.push(unescapePo(trimmed.slice(1)))
      end = at + raw.length
      return true
    }
    parts.push(unescapePo(trimmed.slice(1, closing)))
    end = at + raw.indexOf('"') + closing + 1
    return true
  }

  take(first, firstAt)
  for (let i = from + 1; i < lines.length; i++) {
    const next = lines[i]!
    const trimmed = next.text.trim().replace(/^#~\s*/, '')
    if (!trimmed.startsWith('"')) break
    multiline = true
    take(trimmed, next.start + next.text.indexOf('"'))
  }

  return { value: parts.join(''), start: firstAt + Math.max(0, first.indexOf('"')), end, multiline, terminated }
}

/** Index of the closing quote, honouring backslash escapes. -1 when unterminated. */
function closingQuote(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') {
      i++
      continue
    }
    if (s[i] === '"') return i
  }
  return -1
}

function unescapePo(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c,
  )
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
