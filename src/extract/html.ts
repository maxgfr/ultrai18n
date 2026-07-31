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
}

export function extractHtml(file: string, text: string, map: OffsetMap): HtmlExtractResult {
  const sites: RawSite[] = []
  const identifiers = new Set<string>()
  let index = 0
  let i = 0
  const n = text.length
  const openStack: string[] = []

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
      const at = openStack.lastIndexOf(tag)
      if (at !== -1) openStack.length = at
    } else {
      identifiers.add(tag)
      extractAttributes(tagBody, lt + 1, tag)
      const selfClosing = tagBody.trimEnd().endsWith('/')
      if (!selfClosing) openStack.push(tag)
    }

    i = gt + 1

    // Skip the body of script/style wholesale: their content belongs to the
    // JS and CSS extractors, and reading it as prose would emit nonsense.
    if (!closing && (tag === 'script' || tag === 'style')) {
      const close = text.toLowerCase().indexOf(`</${tag}`, i)
      i = close === -1 ? n : close
      openStack.pop()
    }
  }

  function emitText(chunk: string, at: number): void {
    if (!chunk.trim()) return
    const enclosing = openStack[openStack.length - 1] ?? ''
    // Inside <title>/<desc>/<text> the content is copy even in an SVG; inside
    // <code>/<pre> it is not, whatever it looks like.
    if (OPAQUE_ELEMENTS.has(enclosing)) return
    const isSvgText = SVG_TEXT_ELEMENTS.has(enclosing)
    if (!isSvgText && !/\p{L}{2,}/u.test(chunk)) return

    for (const match of chunk.matchAll(/\S[^\n]*\S|\S/g)) {
      const body = match[0]
      if (!/\p{L}{2,}/u.test(body)) continue
      // Template interpolation is an expression, not text.
      if (/^\{\{[^}]*\}\}$|^\{[^}]*\}$|^<%.*%>$/.test(body.trim())) continue
      const from = at + (match.index ?? 0)
      push(
        `${enclosing || 'root'}/text[${index++}]`,
        'prose-run',
        from,
        from + body.length,
        body,
        null,
        { isKey: false, element: enclosing },
      )
    }
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
  return { sites, claimedBytes: text.length, identifiers }
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
