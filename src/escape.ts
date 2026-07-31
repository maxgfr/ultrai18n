// Re-encoding a translation for the syntax that will host it.
//
// This is where a write-back tool quietly corrupts files. A translation
// containing an apostrophe, a quote, a backtick, a brace or a colon is not
// unusual — in French it is the common case — and each host syntax breaks on a
// different one of those. So there is one escaper per syntax, and an UNKNOWN
// syntax is never written: refusing is recoverable, writing a broken file is not.
import type { SiteKind } from './types'

export type HostSyntax =
  | 'js-single'
  | 'js-double'
  | 'js-template'
  | 'jsx-text'
  | 'jsx-attr-string'
  | 'json-string'
  | 'yaml-scalar'
  | 'yaml-block'
  | 'md-text'
  | 'html-text'
  | 'html-attr'
  | 'css-comment'
  | 'line-comment'
  | 'block-comment'
  | 'plain'

export class UnknownSyntaxError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'UnknownSyntaxError'
  }
}

/** Work out which syntax hosts a site, from what the extractor recorded. */
export function syntaxFor(site: {
  kind: SiteKind
  quote: string | null
  extractor: string
  raw: string
}): HostSyntax {
  switch (site.extractor) {
    case 'ts-ast':
      if (site.kind === 'jsx-text') return 'jsx-text'
      if (site.kind === 'comment') return site.raw.startsWith('/*') ? 'block-comment' : 'line-comment'
      if (site.quote === '`') return 'js-template'
      if (site.quote === '"') return site.kind === 'attr' ? 'jsx-attr-string' : 'js-double'
      if (site.quote === "'") return 'js-single'
      return 'js-single'
    case 'json':
      if (site.kind === 'comment') return site.raw.startsWith('/*') ? 'block-comment' : 'line-comment'
      return 'json-string'
    case 'yaml':
      if (site.kind === 'comment') return 'line-comment'
      if (site.kind === 'block-scalar') return 'yaml-block'
      return 'yaml-scalar'
    case 'markdown':
      return 'md-text'
    case 'html':
      if (site.kind === 'attr') return 'html-attr'
      if (site.kind === 'comment') return 'block-comment'
      return 'html-text'
    case 'css':
      return site.kind === 'comment' ? 'css-comment' : 'js-double'
    case 'text':
      return 'plain'
    default:
      throw new UnknownSyntaxError(`no escaper for extractor "${site.extractor}"`)
  }
}

export interface EscapeOptions {
  /** The quote character the site is delimited by, when it has one. */
  quote?: string | null
  /**
   * The host file contains only ASCII. Writing a literal accented character
   * into a file whose style is `é` produces a diff the repo's own lint
   * rejects, so the escape has to follow the file rather than the language.
   */
  asciiOnly?: boolean
  /** Indentation to re-apply to each line of a YAML block scalar. */
  blockIndent?: string
}

/**
 * Produce the bytes to write for `text` inside `syntax`.
 *
 * The result replaces the site's VALUE span, never its delimiters — the quotes
 * stay where they were, which is what makes an unchanged delimiter style a
 * property of the patch rather than a hope.
 */
export function escapeFor(syntax: HostSyntax, text: string, opts: EscapeOptions = {}): string {
  const out = escapeRaw(syntax, text, opts)
  return opts.asciiOnly ? toAscii(out, syntax) : out
}

function escapeRaw(syntax: HostSyntax, text: string, opts: EscapeOptions): string {
  switch (syntax) {
    case 'js-single':
      return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    case 'js-double':
      return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    case 'jsx-attr-string':
      return opts.quote === "'"
        ? text.replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        : text.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    case 'js-template':
      // A real newline is legal in a template and must survive; `${` must not.
      return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
    case 'jsx-text':
      // Braces and angle brackets open JSX syntax. `&` is deliberately NOT
      // escaped: JSX renders it literally, and escaping it would turn every
      // "R&D" into "R&amp;D" on screen.
      return text.replace(/[{}]/g, (c) => (c === '{' ? '&#123;' : '&#125;')).replace(/</g, '&lt;').replace(/>/g, '&gt;')
    case 'json-string':
      // RFC 8259, minus the surrounding quotes JSON.stringify would add.
      return JSON.stringify(text).slice(1, -1)
    case 'yaml-scalar':
      if (opts.quote === '"') return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      if (opts.quote === "'") return text.replace(/'/g, "''")
      // An unquoted scalar that starts with an indicator, or contains `: ` or
      // ` #`, silently becomes a different YAML value. Quote it rather than
      // hoping.
      return needsYamlQuoting(text) ? `'${text.replace(/'/g, "''")}'` : text
    case 'yaml-block':
      return opts.blockIndent
        ? text.split('\n').map((l) => (l === '' ? l : opts.blockIndent + l)).join('\n')
        : text
    case 'md-text':
      // Escape only where a character would START a construct at that position.
      // Escaping every `*` would turn prose into a thicket of backslashes.
      return text.replace(/^(\s*)([#>*+-]|\d+[.)])/, '$1\\$2')
    case 'html-text':
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    case 'html-attr':
      return opts.quote === "'"
        ? text.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;')
        : text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    case 'css-comment':
    case 'block-comment':
      // `*/` inside a block comment terminates it early and the rest of the
      // file becomes code.
      return text.replace(/\*\//g, '*\\/')
    case 'line-comment':
      // A newline would move the remainder outside the comment.
      return text.replace(/\r?\n/g, ' ')
    case 'plain':
      return text
  }
}

function needsYamlQuoting(text: string): boolean {
  if (text === '') return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true
  if (/:\s|\s#/.test(text)) return true
  if (/^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|null|Null|NULL|~)$/.test(text)) return true
  if (/^[\d.+-]/.test(text) && !Number.isNaN(Number(text))) return true
  if (/^\s|\s$/.test(text)) return true
  return false
}

/** Re-encode non-ASCII the way the host file already does. */
function toAscii(text: string, syntax: HostSyntax): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(text)) return text
  switch (syntax) {
    case 'js-single':
    case 'js-double':
    case 'js-template':
    case 'json-string':
      return [...text]
        .map((c) => {
          const code = c.codePointAt(0)!
          if (code < 128) return c
          return code > 0xffff
            ? [...c].map((u) => '\\u' + u.charCodeAt(0).toString(16).padStart(4, '0')).join('')
            : '\\u' + code.toString(16).padStart(4, '0')
        })
        .join('')
    case 'html-text':
    case 'html-attr':
    case 'jsx-text':
      return [...text].map((c) => (c.codePointAt(0)! < 128 ? c : `&#${c.codePointAt(0)};`)).join('')
    default:
      // No ASCII-safe encoding exists for this syntax, so keep the real
      // characters rather than inventing one.
      return text
  }
}

/**
 * Decode a value back out of its host syntax.
 *
 * Used by the round-trip self-check: after building the patched buffer, the
 * patched span is re-decoded and compared to the intended translation. That
 * turns an escaper bug from silent corruption into a loud refusal, which is the
 * write-back analogue of re-reading a citation before trusting it.
 */
export function unescapeFor(syntax: HostSyntax, text: string, opts: EscapeOptions = {}): string {
  switch (syntax) {
    case 'js-single':
    case 'js-double':
    case 'js-template':
      return text.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\(['"`$\\])/g, '$1')
    case 'json-string':
      try {
        return JSON.parse(`"${text}"`) as string
      } catch {
        return text
      }
    case 'jsx-attr-string':
    case 'html-attr':
    case 'html-text':
    case 'jsx-text':
      return text
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#123;/g, '{')
        .replace(/&#125;/g, '}')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    case 'yaml-scalar':
      if (opts.quote === '"') return text.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      if (opts.quote === "'") return text.replace(/''/g, "'")
      return text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replace(/''/g, "'") : text
    case 'yaml-block':
      return opts.blockIndent
        ? text.split('\n').map((l) => (l.startsWith(opts.blockIndent!) ? l.slice(opts.blockIndent!.length) : l)).join('\n')
        : text
    case 'md-text':
      return text.replace(/^(\s*)\\([#>*+-]|\d+[.)])/, '$1$2')
    case 'css-comment':
    case 'block-comment':
      return text.replace(/\*\\\//g, '*/')
    case 'line-comment':
    case 'plain':
      return text
  }
}
