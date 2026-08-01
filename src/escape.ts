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
  | 'po-string'
  | 'toml-basic'
  | 'toml-literal'
  | 'ftl-pattern'
  | 'dockerfile-value'
  /**
   * A Python triple-quoted string — a docstring, chiefly.
   *
   * Its own syntax rather than a parameter on the single-quoted one: a real
   * newline is legal inside it and must survive, which is the opposite of what
   * `js-double` does, and the only sequence that can terminate it early is the
   * closing delimiter itself.
   */
  | 'py-triple'
  | 'sql-string'
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
    case 'po':
      return site.kind === 'comment' ? 'line-comment' : 'po-string'
    case 'toml':
      if (site.kind === 'comment') return 'line-comment'
      // A TOML literal string has no escape mechanism AT ALL, not even for its
      // own delimiter, so the two quote styles are genuinely different syntaxes
      // rather than one with a parameter.
      return site.quote === "'" ? 'toml-literal' : 'toml-basic'
    case 'ftl':
      return site.kind === 'comment' ? 'line-comment' : 'ftl-pattern'
    case 'dockerfile':
      return site.kind === 'comment' ? 'line-comment' : 'dockerfile-value'
    case 'python-ast':
      // A docstring arrives as `comment`, but it is a STRING and a newline
      // inside it is legal — so it must not go to `line-comment`, which folds
      // newlines to spaces. The quote is what decides, exactly as it does for
      // TypeScript.
      if (site.quote === '"""' || site.quote === "'''") return 'py-triple'
      if (site.kind === 'comment') return 'line-comment'
      return site.quote === '"' ? 'js-double' : 'js-single'
    case 'shell-ast':
      return 'line-comment'
    case 'sql':
      if (site.kind === 'comment') return site.raw.startsWith('/*') ? 'block-comment' : 'line-comment'
      return 'sql-string'
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
  /**
   * Whether the site begins its own line.
   *
   * Only meaningful for Markdown, and it decides whether a leading `*` or `-`
   * needs escaping at all. A block construct can only start at the start of a
   * block, so text sitting inside a table cell or after other prose cannot
   * begin one — and escaping it there inserts a backslash the reader sees.
   * Defaults to true, which is the cautious reading when nobody said.
   */
  atLineStart?: boolean
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
      // Escaping every `*` would turn prose into a thicket of backslashes, and
      // escaping one mid-line — in a table cell, say — turns `**bold**` into a
      // visible `\**bold**`, which is the same class of damage in miniature.
      return opts.atLineStart === false ? text : text.replace(/^(\s*)([#>*+-]|\d+[.)])/, '$1\\$2')
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
    case 'po-string':
      // C-style, as gettext defines it. `\n` matters: a PO string is written on
      // one line and a real newline would end the string.
      return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    case 'toml-basic':
      return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
    case 'toml-literal':
      // Nothing is escapable here, so nothing is escaped. A value containing an
      // apostrophe CANNOT be written into a literal string, and `unescapeFor`
      // models that truncation so `apply`'s round-trip check refuses the write
      // instead of silently cutting the sentence short.
      return text
    case 'ftl-pattern':
      // `{` opens a placeable. Fluent's own literal-brace form is `{"{"}`.
      return text.replace(/\{/g, '{"{"}')
    case 'dockerfile-value':
      return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')
    case 'py-triple': {
      // A real newline is legal here and must survive — a docstring is written
      // across lines, and folding it would reformat the file. The only sequence
      // that can end the string early is the delimiter itself, and a trailing
      // quote would fuse with the closing one.
      const delimiter = opts.quote === "'''" ? "'''" : '"""'
      const q = delimiter[0]!
      return text
        .replace(/\\/g, '\\\\')
        .split(delimiter)
        .join(`\\${q}\\${q}\\${q}`)
        .replace(new RegExp(`\\${q}$`), `\\${q}`)
    }
    case 'sql-string':
      // Standard SQL has exactly one escape and it is doubling the quote. There
      // is no backslash mechanism, so introducing one would write a backslash.
      return text.replace(/'/g, "''").replace(/\r?\n/g, ' ')
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
    // Six of these used to hold a COPY OF THE ESCAPER rather than its inverse,
    // and the round-trip corpus in `tests/apply.test.ts` covered exactly the
    // eight syntaxes that were right — so `apply`'s self-check, the thing that
    // turns an escaper bug into a loud refusal, was comparing escape(escape(x))
    // against x for every format below. It passed on text with nothing to
    // escape, which is most text, and would have refused a correct write on any
    // comment containing a backslash.
    case 'line-comment':
      // Folding a newline to a space is LOSSY and the inverse is identity, on
      // purpose. Re-reading returns the folded text, which no longer equals the
      // intended translation, so `apply` refuses — which is right: a newline
      // cannot be written into a line comment at all.
      return text
    case 'po-string':
      return text
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        .replace(/\\(["\\])/g, '$1')
    case 'toml-basic':
      return text
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
        .replace(/\\(["\\])/g, '$1')
    case 'toml-literal':
      // Nothing is escapable here, so nothing is escaped. A value containing an
      // apostrophe CANNOT be written into a literal string, and this models
      // that truncation so `apply`'s round-trip check refuses the write instead
      // of silently cutting the sentence short.
      return text
    case 'ftl-pattern':
      return text.replace(/\{"\{"\}/g, '{')
    case 'dockerfile-value':
      return text.replace(/\\(["\\])/g, '$1')
    case 'py-triple': {
      const q = opts.quote === "'''" ? "'" : '"'
      return text.split(`\\${q}\\${q}\\${q}`).join(q.repeat(3)).replace(/\\([\\"'])/g, '$1')
    }
    case 'sql-string':
      return text.replace(/''/g, "'")
    case 'plain':
      return text
  }
}
