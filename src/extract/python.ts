// Python extraction, on the AST tier.
//
// This is the reader the TODO budgeted "a real module" for, and it is not one:
// codeindex already ships `python.wasm` in its CORE grammar tier and
// `grammarKeyForExt` already maps `.py` to it, so the tier this engine reaches
// for TypeScript reaches Python by adding a visitor and shipping 458 KB of
// grammar. A hand-written lexer would have been more code AND a weaker claim —
// no key-versus-value, no comparison detection, no docstring that is a
// docstring rather than a string that happens to come first.
//
// Docstrings are the reason this matters more than the site count suggests. A
// module, a class and a function each open with one, they are prose written for
// people, and no regex can tell one from an expression statement that happens
// to be a string.
import type { Hole, Span } from '../types'
import type { Container, RawSite, TokenIndex } from './raw'
import { addToken } from './raw'
import { walkTree, type Node, type Tree } from '../ast/parse'
import { OffsetMap } from '../vendor/text'

export interface PythonExtractResult {
  sites: RawSite[]
  tokens: Pick<TokenIndex, 'enums' | 'compared' | 'persisted' | 'identifiers'>
  /** Byte spans the grammar could not parse, so the sweep can cover exactly those. */
  errorSpans: Span[]
  hasError: boolean
}

/**
 * Comments addressed to a tool rather than to a person.
 *
 * The same judgement `extract/dockerfile.ts` makes about `# syntax=`: a
 * directive is not prose, and translating one breaks the tool that reads it.
 */
const DIRECTIVE = /^#\s*(type:|noqa|pylint:|mypy:|flake8:|pragma:|ruff:|isort:|fmt:|coding[:=]|-\*-|!)/

/** Calls whose string argument is a key in persistent storage, not copy. */
const PERSIST_CALLEES = new Set(['getenv', 'environ', 'get', 'set', 'setex', 'hget', 'hset', 'cache_key'])

/** Calls whose string argument is compared or looked up, never displayed. */
const MEMBERSHIP_CALLEES = new Set(['startswith', 'endswith', 'count', 'index', 'find'])

const TEST_FILE = /(^|\/)(tests?|conftest)\.py$|(^|\/)tests?\//

/** Where a docstring is allowed to be: the body of one of these. */
const DOCSTRING_HOSTS = new Set(['module', 'function_definition', 'class_definition'])

export function extractPython(
  file: string,
  text: string,
  tree: Tree,
  map: OffsetMap,
): PythonExtractResult {
  const sites: RawSite[] = []
  const enums = new Map<string, string[]>()
  const compared = new Map<string, string[]>()
  const persisted = new Map<string, string[]>()
  const identifiers = new Set<string>()
  const errorSpans: Span[] = []
  const inTest = TEST_FILE.test(file)
  let hasError = false

  const push = (
    node: Node,
    kind: RawSite['kind'],
    value: string,
    valueNode: Node | null,
    quote: string | null,
    holes: Hole[],
    container: Container,
    escapes: boolean,
    prefix?: string,
    suffix?: string,
  ): void => {
    const span = byteSpan(node, map)
    const valueSpan = valueNode ? byteSpan(valueNode, map) : span
    const s = map.lineColOf(node.startIndex)
    const e = map.lineColOf(node.endIndex)
    sites.push({
      file,
      path: anchorPath(node),
      kind,
      span,
      valueSpan,
      raw: text.slice(node.startIndex, node.endIndex),
      value,
      quote,
      escapes,
      holes,
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'python-ast',
      tier: 'ast',
      container,
      ...(prefix !== undefined ? { prefix, suffix: suffix ?? '', linePrefix: '' } : {}),
    })
  }

  walkTree(tree.rootNode, (node) => {
    if (node.type === 'ERROR' || node.isMissing) {
      hasError = true
      errorSpans.push(byteSpan(node, map))
      return false
    }

    if (node.type === 'identifier') {
      identifiers.add(node.text)
      return
    }

    if (node.type === 'comment') {
      const body = node.text
      if (DIRECTIVE.test(body)) return false
      const marker = /^#+\s?/.exec(body)?.[0] ?? '#'
      const value = body.slice(marker.length).trimEnd()
      if (!/\p{L}{2,}/u.test(value)) return false
      push(node, 'comment', value, null, null, [], { isKey: false }, false, marker, '')
      return false
    }

    if (node.type === 'string') {
      emitString(node)
      // Claimed whole: an f-string's interpolations are holes in ONE site, and
      // descending would emit each fragment as a site of its own.
      return false
    }
    return undefined
  })

  function emitString(node: Node): void {
    const content = namedChildrenOfType(node, 'string_content')
    const start = node.child(0)
    const end = node.child(node.childCount - 1)
    const opener = start?.type === 'string_start' ? start.text : ''
    // The prefix letters are part of the syntax and not of the delimiter: `f"`,
    // `rb'''`. What decides how a translation is escaped is the QUOTE.
    const quoteMatch = /("""|'''|"|')$/.exec(opener)
    const quote = quoteMatch?.[1] ?? null
    if (!quote) return

    const interpolations = namedChildrenOfType(node, 'interpolation')
    const container = containerFor(node)

    // An f-string is a template: every interpolation becomes `{n}` in the value
    // and a hole the translation must keep.
    const holes: Hole[] = interpolations.map((n, index) => ({
      index,
      span: byteSpan(n, map),
      expr: n.text.replace(/^\{|\}$/g, ''),
    }))

    const from = start?.type === 'string_start' ? start.endIndex : node.startIndex
    const to = end?.type === 'string_end' ? end.startIndex : node.endIndex
    if (to < from) return

    const raw = text.slice(from, to)
    let value = ''
    let cursor = from
    for (const n of interpolations) {
      value += decode(text.slice(cursor, n.startIndex), quote, opener)
      value += `{${interpolations.indexOf(n)}}`
      cursor = n.endIndex
    }
    value += decode(text.slice(cursor, to), quote, opener)
    if (!/\p{L}{2,}/u.test(value)) return

    // The content node is what the patcher rewrites. With interpolations there
    // are several, so the span from the opener to the closer is the only one
    // that covers the whole value.
    const valueNode = content.length === 1 && interpolations.length === 0 ? content[0]! : null
    const docstring = interpolations.length === 0 && isDocstring(node)
    // A docstring is a comment for classification and a STRING for escaping.
    // Both facts travel: the kind drives the surface, the quote drives the
    // escaper, and confusing the two would fold a multi-line docstring onto one
    // line the way a line comment must be folded.
    if (docstring) container.docstring = true
    const kind: RawSite['kind'] = interpolations.length > 0 ? 'template' : docstring ? 'comment' : 'string-literal'

    if (valueNode) {
      push(node, kind, value, valueNode, quote, holes, container, /\\/.test(raw))
      return
    }
    // No single content node: address the interior by offset from the
    // delimiters, which is what `apply` reconstructs a span from anyway.
    const s = map.lineColOf(node.startIndex)
    const e = map.lineColOf(node.endIndex)
    sites.push({
      file,
      path: anchorPath(node),
      kind,
      span: byteSpan(node, map),
      valueSpan: { start: map.byteOf(from), end: map.byteOf(to) },
      raw: text.slice(node.startIndex, node.endIndex),
      value,
      quote,
      escapes: /\\/.test(raw),
      holes,
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'python-ast',
      tier: 'ast',
      container,
    })
  }

  /**
   * Is this string the docstring of the construct it opens?
   *
   * A docstring is not a string that happens to come first: it is the first
   * STATEMENT of a module, class or function body, and it is prose written for
   * a person. Getting this right is the whole reason the reader is on the AST
   * tier — position in a body is not something a lexer can see.
   */
  function isDocstring(node: Node): boolean {
    const statement = node.parent
    if (statement?.type !== 'expression_statement') return false
    if (statement.namedChildCount !== 1) return false
    const body = statement.parent
    if (!body) return false
    const host = body.type === 'block' ? body.parent : body
    if (!host || !DOCSTRING_HOSTS.has(host.type)) return false
    return firstNamedChild(body) === statement.id
  }

  function containerFor(node: Node): Container {
    const container: Container = { isKey: false }
    const symbol = enclosingSymbol(node)
    if (symbol) container.enclosingSymbol = symbol
    if (inTest) container.inTest = true

    const parent = node.parent
    const value = node.text

    // A dictionary key is an identifier position, exactly as a JSON key is.
    if (parent?.type === 'pair' && parent.child(0)?.id === node.id) container.isKey = true

    // `import`, `from x import y` — a module specifier is never copy.
    if (ancestorOfType(node, new Set(['import_statement', 'import_from_statement', 'future_import_statement']))) {
      container.moduleSpecifier = true
    }

    // Compared, not rendered: the strongest single signal a string is a token.
    if (parent?.type === 'comparison_operator') {
      container.compared = true
      addToken(compared, value, `${file}#${anchorPath(node)}`)
    }

    const call = ancestorOfType(node, new Set(['call']))
    const callee = call ? calleeName(call) : null
    if (callee) {
      container.callee = callee
      const leaf = callee.split('.').pop() ?? callee
      if (MEMBERSHIP_CALLEES.has(leaf)) container.compared = true
      if (PERSIST_CALLEES.has(leaf)) {
        container.persisted = true
        addToken(persisted, value, `${file}#${anchorPath(node)}`)
      }
    }

    // An Enum subclass' assigned values are enum members repo-wide, which is
    // what makes the dual-use hazard fire on a text that is also a label.
    const cls = ancestorOfType(node, new Set(['class_definition']))
    if (cls && /\b(Enum|StrEnum|IntEnum|TextChoices|Choices)\b/.test(superclasses(cls))) {
      container.enumMember = true
      addToken(enums, value, `${file}#${anchorPath(node)}`)
    }

    const comment = nearestComment(node)
    if (comment) container.nearestComment = comment
    return container
  }

  function nearestComment(node: Node): string | null {
    let cur: Node | null = node
    while (cur && !cur.previousNamedSibling) cur = cur.parent
    const prev = cur?.previousNamedSibling
    return prev?.type === 'comment' ? prev.text.replace(/^#+\s?/, '').trim() : null
  }

  return { sites, tokens: { enums, compared, persisted, identifiers }, errorSpans, hasError }
}

// ---------------------------------------------------------------------------

/**
 * A structural anchor: the named constructs enclosing this node, then an
 * ordinal where nothing had a name.
 *
 * The same contract `extract/ts.ts` states — the path may never be the value,
 * because an identity derived from content cannot survive the operation this
 * tool performs on content — and the same failure if it collides: a shared
 * anchor is a shared site id, and `apply` resolves one through a Map.
 */
export function anchorPath(node: Node): string {
  const segments: string[] = []
  let cur: Node | null = node
  let child: Node | null = null

  while (cur) {
    const named = nameOf(cur)
    if (named) segments.push(named)
    else if (child && segments.length === 0 && ORDINAL_CONTAINERS.has(cur.type)) {
      segments.push(`[${ordinalOf(cur, child)}]`)
    }
    child = cur
    cur = cur.parent
  }
  return segments.reverse().join('/') || 'root'
}

const ORDINAL_CONTAINERS = new Set(['module', 'block', 'list', 'tuple', 'set', 'argument_list', 'dictionary'])

function nameOf(node: Node): string | null {
  switch (node.type) {
    case 'function_definition':
    case 'class_definition':
      return node.childForFieldName('name')?.text ?? null
    case 'assignment': {
      const left = node.childForFieldName('left')
      return left?.type === 'identifier' ? left.text : null
    }
    case 'pair': {
      const key = node.child(0)
      return key?.type === 'string' ? stringLiteralText(key) : null
    }
    case 'keyword_argument':
      return node.childForFieldName('name')?.text ?? null
    default:
      return null
  }
}

function ordinalOf(container: Node, child: Node): number {
  let n = 0
  for (let i = 0; i < container.namedChildCount; i++) {
    const c = container.namedChild(i)
    if (!c) continue
    if (c.id === child.id) return n
    n++
  }
  return n
}

function stringLiteralText(node: Node): string | null {
  const content = namedChildrenOfType(node, 'string_content')[0]
  return content ? content.text : null
}

function superclasses(cls: Node): string {
  return cls.childForFieldName('superclasses')?.text ?? ''
}

function calleeName(call: Node): string | null {
  const fn = call.childForFieldName('function')
  if (!fn) return null
  return fn.type === 'identifier' || fn.type === 'attribute' ? fn.text : null
}

function enclosingSymbol(node: Node): string | null {
  let cur: Node | null = node.parent
  while (cur) {
    const named = nameOf(cur)
    if (named) return named
    cur = cur.parent
  }
  return null
}

function ancestorOfType(node: Node, types: Set<string>): Node | null {
  let cur: Node | null = node.parent
  while (cur) {
    if (types.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}

function firstNamedChild(body: Node): number | null {
  return body.namedChild(0)?.id ?? null
}

function namedChildrenOfType(node: Node, type: string): Node[] {
  const out: Node[] = []
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (c && c.type === type) out.push(c)
  }
  return out
}

function byteSpan(node: Node, map: OffsetMap): Span {
  return { start: map.byteOf(node.startIndex), end: map.byteOf(node.endIndex) }
}

/**
 * Resolve Python's escapes, unless the literal is raw.
 *
 * An `r''` string has no escape mechanism at all — `r'\n'` is a backslash and
 * an `n` — so decoding one would report a value the file does not contain, and
 * `apply`'s round-trip check would refuse the write.
 */
function decode(raw: string, quote: string, opener: string): string {
  if (/r/i.test(opener.slice(0, opener.length - quote.length))) return raw
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, seq: string) => {
    if (seq.startsWith('u{')) return String.fromCodePoint(parseInt(seq.slice(2, -1), 16))
    if (seq[0] === 'u') return String.fromCharCode(parseInt(seq.slice(1), 16))
    if (seq[0] === 'x') return String.fromCharCode(parseInt(seq.slice(1), 16))
    switch (seq) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '0': return '\0'
      case '\n': return ''
      default: return seq
    }
  })
}
