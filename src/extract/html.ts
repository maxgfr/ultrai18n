// HTML, SVG and single-file-component markup.
//
// A tolerant tag scanner rather than a conformant parser, because it has to
// survive template syntax it does not understand: `{{ }}`, `{% %}`, `<% %>`,
// `{#if}`. A parser that rejects those reads zero Vue, Svelte, Astro, ERB or
// Jinja files, which is most of the markup this tool is pointed at.
//
// SVG is here rather than treated as an image because it is text and it carries
// <title> and <desc> — the accessible name of every icon in a UI.
import type { Span } from '../types'
import type { Container, RawSite } from './raw'
import { OffsetMap } from '../vendor/text'
import { pointer } from '../identity'
import { extractCss } from './css'

/**
 * Is this `.ts` file a Qt Linguist catalog rather than a TypeScript module?
 *
 * Anchored at the head of the file — an optional BOM, an optional XML
 * declaration, any number of comments — so a TypeScript module that merely
 * CONTAINS the string `"<TS version="` is never handed to the markup scanner.
 * Sniffing on content is right here and nowhere else: this is the one extension
 * two unrelated formats genuinely share.
 */
const QT_HEAD = /^﻿?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+TS\b|<TS[\s>])/i

export function isQtTranslation(text: string): boolean {
  return QT_HEAD.test(text.slice(0, 512))
}

/** Attributes whose value is shown to, or read to, a person. */
const TEXT_ATTRS =
  /^(alt|title|placeholder|label|summary|abbr|download|aria-label|aria-description|aria-roledescription|aria-valuetext|aria-placeholder|srcdoc)$/i
/** Framework-bound variants of the same attributes: `:title`, `v-bind:alt`, `bind:label`. */
const BOUND_PREFIX = /^(:|v-bind:|bind:|\[)/

/** Elements whose text content is markup or code, never copy. */
const OPAQUE_ELEMENTS = new Set(['script', 'style', 'template', 'code', 'pre', 'svg:path'])
/** Elements whose text content IS copy even inside an SVG. */
const SVG_TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan', 'textpath'])

export interface HtmlExtractResult {
  sites: RawSite[]
  claimedBytes: number
  identifiers: Set<string>
  /**
   * Inline `<script>` bodies, as CHAR ranges into the text this was given.
   *
   * This scanner does not read them: JavaScript needs the AST tier, which is
   * async and belongs to `scan`. Reporting the ranges rather than swallowing
   * them is what lets the caller decide, and the caller is the only one that
   * can — it has the parser.
   *
   * Char offsets rather than byte spans because the caller has to RE-READ the
   * region, and every reader here indexes characters. `claimedBytes` counts
   * them as read: whether they truly were is the caller's answer to give, and
   * `scan` subtracts the ones it could not parse before reporting a ratio.
   *
   * `lang` is whatever the tag declared — `lang="ts"`, `type="module"`,
   * `type="application/ld+json"` — so the caller can pick a reader instead of
   * assuming JavaScript. A single-file component's script block is routinely
   * TypeScript, and a `ld+json` body is structured data rather than code.
   */
  scripts: { from: number; to: number; lang: string | null }[]
}

/**
 * Read markup, or one region of a larger document.
 *
 * `range` exists for a raw HTML block inside a markdown file — a `<summary>`,
 * an `<img alt>`, the `<p align="center">` banner at the top of half the
 * READMEs in existence. Offsets stay absolute against the original text and
 * map, so the sites it returns are indistinguishable from any other.
 */
export function extractHtml(
  file: string,
  text: string,
  map: OffsetMap,
  range?: { from: number; to: number },
): HtmlExtractResult {
  const sites: RawSite[] = []
  const identifiers = new Set<string>()
  let index = 0
  let i = range?.from ?? 0
  const n = range?.to ?? text.length
  // The stack carries each open element's attributes, not just its name. A
  // resource `<item>` means nothing without the `quantity` that labels it and
  // the `<plurals name>` that owns it, and a bare document-order index cannot
  // express either.
  const openStack: {
    tag: string
    attrs: Record<string, string>
    /** plist only: the `<key>` most recently seen inside this `<dict>`. */
    pendingKey?: string | null
    /** plist `<array>` only: how many values have been emitted at this level. */
    index?: number
  }[] = []

  // Decided by the first element and never re-decided. Everything guarded by it
  // is ADDITIVE: an ordinary HTML, SVG, Vue, Svelte or Astro document takes
  // exactly the path it took before, which is the property the regression test
  // in `extract-text-formats` pins.
  const scripts: HtmlExtractResult['scripts'] = []
  let docKind: 'markup' | 'plist' | 'qt' = 'markup'
  let messageOrdinal = -1
  let numerusOrdinal = 0

  const push = (
    path: string,
    kind: RawSite['kind'],
    startChar: number,
    endChar: number,
    value: string,
    quote: string | null,
    container: Container,
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
      escapes: /&\w+;|&#\d+;/.test(value),
      holes: [],
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'html',
      tier: 'structural',
      container,
      ...(prefix !== undefined ? { prefix, suffix: suffix ?? '', linePrefix: '' } : {}),
    })
  }

  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt === -1) {
      emitText(text.slice(i), i)
      break
    }

    emitText(text.slice(i, lt), i)

    // Comments and doctype.
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      const stop = end === -1 ? n : end + 3
      const value = text.slice(lt + 4, end === -1 ? n : end).trim()
      if (/\p{L}{2,}/u.test(value)) {
        push(`comment[${index++}]`, 'comment', lt, stop, value, null, { isKey: false }, '<!-- ', ' -->')
      }
      i = stop
      continue
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt)
      i = end === -1 ? n : end + 1
      continue
    }

    const gt = findTagEnd(text, lt)
    if (gt === -1) {
      i = n
      break
    }
    const tagBody = text.slice(lt + 1, gt)
    const closing = tagBody.startsWith('/')
    const nameMatch = /^\/?\s*([a-zA-Z][\w:-]*)/.exec(tagBody)
    const tag = nameMatch?.[1]?.toLowerCase() ?? ''

    if (closing) {
      let at = -1
      for (let k = openStack.length - 1; k >= 0; k--) {
        if (openStack[k]!.tag === tag) {
          at = k
          break
        }
      }
      if (at !== -1) openStack.length = at
      if (docKind === 'qt' && tag === 'numerusform') numerusOrdinal++
    } else if (tag === '') {
      // `<?xml …?>`, `<!DOCTYPE …>`, `<![CDATA[`. Not elements, and pushing a
      // frame for one put every real root element at depth 1 — which silently
      // disabled every check that asks "is this the document's first element?"
      i = gt + 1
      continue
    } else {
      identifiers.add(tag)
      if (docKind === 'markup' && openStack.length === 0) {
        if (tag === 'plist') docKind = 'plist'
        else if (tag === 'ts') docKind = 'qt'
      }
      if (docKind === 'qt') {
        if (tag === 'message') {
          messageOrdinal++
          numerusOrdinal = 0
        }
      }
      extractAttributes(tagBody, lt + 1, tag)
      const selfClosing = tagBody.trimEnd().endsWith('/')
      if (!selfClosing) openStack.push({ tag, attrs: allAttributes(tagBody), pendingKey: null, index: 0 })
    }

    i = gt + 1

    // The body of a `<script>` or `<style>` is code, and reading it as prose
    // would emit nonsense — but it is not empty of text, and pretending it was
    // read is what made a `content:` value disappear from a file claiming full
    // coverage.
    if (!closing && (tag === 'script' || tag === 'style')) {
      const close = text.toLowerCase().indexOf(`</${tag}`, i)
      const end = close === -1 ? n : close
      if (tag === 'style') {
        // A stylesheet has a reader. Hand it the range rather than the file, so
        // every offset stays absolute against this document.
        const css = extractCss(file, text, map, { from: i, to: end })
        for (const site of css.sites) sites.push(site)
        for (const id of css.identifiers) identifiers.add(id)
      } else {
        // No JS reader HERE — the AST tier is async and belongs to `scan`. The
        // range goes back to the caller, which has the parser; what it cannot
        // parse it sweeps, exactly as before.
        const attrs = openStack[openStack.length - 1]?.attrs ?? {}
        scripts.push({ from: i, to: end, lang: attrs.lang ?? attrs.type ?? null })
      }
      i = end
      openStack.pop()
    }
  }

  function emitText(chunk: string, at: number): void {
    if (!chunk.trim()) return
    const enclosing = openStack[openStack.length - 1]?.tag ?? ''
    // Inside <title>/<desc>/<text> the content is copy even in an SVG; inside
    // <code>/<pre> it is not, whatever it looks like.
    if (OPAQUE_ELEMENTS.has(enclosing)) return
    const isSvgText = SVG_TEXT_ELEMENTS.has(enclosing)

    // A plist dict is a MAP written as alternating <key>/<value> siblings, so
    // the only honest path for it is the one JSON and YAML already use. The
    // generic `string/text[7]` says where a value sits in the document and
    // nothing about which key owns it — and which key owns it is exactly what
    // an Apple plural is made of.
    if (docKind === 'plist') {
      const body = chunk.trim()
      if (enclosing === 'key') {
        const dict = openStack[openStack.length - 2]
        if (dict) dict.pendingKey = body
        const p = plistPointer(body)
        // Emitted as a key, exactly as the JSON extractor emits one: the
        // classifier decides a key structurally, long before any rule.
        if (p) push(p, 'key', at, at + chunk.length, body, null, { isKey: true })
        return
      }
      if (!/\p{L}{2,}/u.test(body)) return
      const p = plistPointer()
      if (p) push(p, 'prose-run', at, at + chunk.length, body, null, { isKey: false, element: enclosing })
      return
    }

    if (!isSvgText && !/\p{L}{2,}/u.test(chunk)) return

    const qualified = resourcePath()
    for (const match of chunk.matchAll(/\S[^\n]*\S|\S/g)) {
      const body = match[0]
      if (!/\p{L}{2,}/u.test(body)) continue
      // Template interpolation is an expression, not text.
      if (/^\{\{[^}]*\}\}$|^\{[^}]*\}$|^<%.*%>$/.test(body.trim())) continue
      const from = at + (match.index ?? 0)
      push(
        qualified ?? `${enclosing || 'root'}/text[${index++}]`,
        'prose-run',
        from,
        from + body.length,
        body,
        null,
        {
          isKey: false,
          element: enclosing,
          ...(declaredUntranslatable() ? { untranslatable: true } : {}),
        },
      )
    }
  }

  /**
   * Does the enclosing element — or its parent — say this must not be translated?
   *
   * `<string translatable="false">` is Android's own machine-readable exception,
   * and the catalog rule for `strings.xml` says out loud that it must win over
   * any heuristic. It could not: the file-level rule marks every string in the
   * resource translatable, and the attribute never reached the site. The parent
   * is checked too, because `<string-array translatable="false">` marks its
   * items rather than itself.
   */
  function declaredUntranslatable(): boolean {
    for (const frame of openStack.slice(-2)) {
      if (frame.attrs.translatable === 'false') return true
    }
    return false
  }

  /**
   * `plurals[cart_items]/item[one]`, for a resource item inside a named parent.
   *
   * Named rather than numbered on purpose. A document-order index renumbers
   * every site below an insertion, and for a plural that is worse than untidy:
   * the forms are the identity, and `item[3]` says nothing about which form it
   * is. This is also the only path shape the plural detector can read.
   */
  /**
   * `/task_count/tasks/one` — a JSON Pointer into a plist's dict nesting.
   *
   * Built from the `<key>` each enclosing `<dict>` last saw. Through `pointer()`
   * so a `/` or `~` inside a key is escaped, which makes these paths comparable
   * with the ones JSON and YAML produce rather than merely similar to them.
   */
  function plistPointer(forKey?: string): string | null {
    const segments: (string | number)[] = []
    for (let k = 0; k < openStack.length; k++) {
      const frame = openStack[k]!
      if (frame.tag === 'dict') {
        const next = openStack[k + 1]
        // The value currently being emitted sits under the dict's pending key.
        if (frame.pendingKey && (next === undefined || next.tag !== 'key')) {
          segments.push(frame.pendingKey)
        }
      } else if (frame.tag === 'array') {
        segments.push(frame.index ?? 0)
      }
    }
    if (forKey !== undefined) {
      // The key site names itself, so its own segment is the key text.
      const own = [...segments]
      if (own[own.length - 1] !== forKey) own.push(forKey)
      return pointer(own)
    }
    return segments.length ? pointer(segments) : null
  }

  function resourcePath(): string | null {
    const top = openStack[openStack.length - 1]
    // Qt gives a <message> no name attribute: its identity is its <source>
    // string, which is arbitrary user prose and has no business inside an
    // anchor. An ordinal renumbers if a message is inserted above — the same
    // guarantee `p[n]` and `~sweep[n]` already make, and strictly better than
    // the file-global `text[n]` it replaces, which gave every numerusform in
    // the whole catalog one shared base and collapsed two messages into one
    // four-form family.
    if (docKind === 'qt' && top?.tag === 'numerusform') {
      return `message[${Math.max(0, messageOrdinal)}]/numerusform[${numerusOrdinal}]`
    }
    const parent = openStack[openStack.length - 2]
    if (!top || !parent) return null
    if (top.tag !== 'item') return null
    const quantity = top.attrs.quantity
    const owner = parent.attrs.name
    if (!quantity || !owner) return null
    return `${parent.tag}[${owner}]/item[${quantity}]`
  }

  function extractAttributes(tagBody: string, base: number, tag: string): void {
    for (const match of tagBody.matchAll(/([@:\w[\]().-]+)\s*=\s*(["'])((?:\\.|(?!\2)[^\\])*)\2/g)) {
      const rawName = match[1]!
      const name = rawName.replace(BOUND_PREFIX, '').replace(/[[\]]/g, '')
      identifiers.add(name)
      const value = match[3]!
      const quote = match[2]!
      const valueAt = base + (match.index ?? 0) + match[0].lastIndexOf(quote + value + quote)
      // On a <meta>, `content` carries no information by itself — what decides
      // whether the value is copy or configuration is the meta's OWN name.
      // `description` is prose; `viewport` is a layout directive that reads
      // like prose and must never be translated. So the meta's name is what
      // the catalog gets to match on.
      const isMeta = tag === 'meta' && /^content$/i.test(name)
      if (isMeta) {
        const metaName = metaKey(tagBody)
        if (!metaName) continue
        const container: Container = { isKey: false, attrName: metaName, element: 'meta' }
        push(`meta[${metaName}]@content`, 'attr', valueAt, valueAt + value.length + 2, value, quote, container)
        continue
      }
      const container: Container = { isKey: false, attrName: name, element: tag }
      if (!TEXT_ATTRS.test(name)) continue
      if (!/\p{L}{2,}/u.test(value)) continue
      push(`${tag}@${name}[${index++}]`, 'attr', valueAt, valueAt + value.length + 2, value, quote, container)
    }
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  // Every byte in range is counted as read. A `<script>` body is only truly
  // unread if the caller cannot parse it, and the caller subtracts those before
  // reporting a ratio — this scanner is no longer the one that knows.
  const scanned = map.byteOf(n) - map.byteOf(range?.from ?? 0)
  return { sites, claimedBytes: scanned, identifiers, scripts }
}

/** Every quoted attribute on a tag, lowercased by name. */
function allAttributes(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tagBody.matchAll(/([@:\w[\]().-]+)\s*=\s*(["'])((?:\\.|(?!\2)[^\\])*)\2/g)) {
    out[m[1]!.toLowerCase()] = m[3]!
  }
  return out
}

/** The identifying name of a <meta>: `name`, `property`, `itemprop` or `http-equiv`. */
function metaKey(tagBody: string): string | null {
  const m = /\b(name|property|itemprop|http-equiv)\s*=\s*["']([^"']+)["']/i.exec(tagBody)
  return m ? m[2]!.toLowerCase() : null
}

/** Find the `>` closing a tag, skipping any inside quoted attribute values. */
function findTagEnd(text: string, from: number): number {
  let quote: string | null = null
  for (let i = from + 1; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}
