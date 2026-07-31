// JS / TS / JSX / TSX extraction.
//
// The five node types that matter here are exactly the ones a symbol indexer
// misses. codeindex's own string handling requires `kids.length === 0`, so
// every interpolated template is dropped, and its STRING_NODE regex does not
// match `jsx_text` at all — which means the visible text of a React component
// is invisible to it. Both are the common case in the repos this tool targets.
import type { Hole, SiteKind, Span } from '../types'
import type { Container, RawSite, TokenIndex } from './raw'
import { addToken } from './raw'
import { walkTree, type Node, type Tree } from '../ast/parse'
import { OffsetMap } from '../vendor/text'

const COMPARISON_OPERATORS = new Set(['===', '!==', '==', '!='])

/** Calls whose string argument is a key in persistent storage, not copy. */
const PERSIST_CALLEES = new Set([
  'getItem', 'setItem', 'removeItem', 'open', 'create', 'match', 'delete',
])
const PERSIST_RECEIVERS = new Set([
  'localStorage', 'sessionStorage', 'caches', 'indexedDB', 'storage', 'alarms',
])

/** Membership calls where the argument is compared, never displayed. */
const MEMBERSHIP_CALLEES = new Set(['includes', 'startsWith', 'endsWith', 'hasOwn', 'has', 'indexOf'])

const TEST_FILE = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|e2e)\//

export interface TsExtractResult {
  sites: RawSite[]
  /** Contributions to the repo-wide cross-reference indexes. */
  tokens: Pick<TokenIndex, 'enums' | 'compared' | 'persisted' | 'identifiers'>
}

export function extractTs(
  file: string,
  text: string,
  tree: Tree,
  map: OffsetMap,
): TsExtractResult {
  const sites: RawSite[] = []
  const enums = new Map<string, string[]>()
  const compared = new Map<string, string[]>()
  const persisted = new Map<string, string[]>()
  const identifiers = new Set<string>()
  const inTest = TEST_FILE.test(file)

  const push = (
    node: Node,
    kind: SiteKind,
    value: string,
    valueNode: Node | null,
    quote: string | null,
    holes: Hole[],
    container: Container,
    escapes: boolean,
  ): void => {
    const path = anchorPath(node)
    const span = byteSpan(node, map)
    const valueSpan = valueNode ? byteSpan(valueNode, map) : innerSpan(node, span, quote)
    const start = map.lineColOf(node.startIndex)
    const end = map.lineColOf(node.endIndex)
    sites.push({
      file,
      path,
      kind,
      span,
      valueSpan,
      raw: node.text,
      value,
      quote,
      escapes,
      holes,
      line: start.line,
      col: start.col,
      endLine: end.line,
      endCol: end.col,
      extractor: 'ts-ast',
      tier: 'ast',
      container: { ...container, inTest },
    })
  }

  walkTree(tree.rootNode, (node) => {
    switch (node.type) {
      case 'identifier':
      case 'type_identifier':
      case 'property_identifier':
        identifiers.add(node.text)
        return

      case 'comment': {
        const shape = commentShape(node.text)
        const path = anchorPath(node)
        const span = byteSpan(node, map)
        const start = map.lineColOf(node.startIndex)
        const end = map.lineColOf(node.endIndex)
        sites.push({
          file,
          path,
          kind: 'comment',
          span,
          valueSpan: span,
          raw: node.text,
          value: shape.body,
          quote: null,
          escapes: false,
          holes: [],
          prefix: shape.prefix,
          suffix: shape.suffix,
          linePrefix: shape.linePrefix,
          line: start.line,
          col: start.col,
          endLine: end.line,
          endCol: end.col,
          extractor: 'ts-ast',
          tier: 'ast',
          container: { isKey: false, inTest },
        })
        return false
      }

      case 'jsx_text': {
        // Whitespace between elements is layout, not copy. Trimming here rather
        // than in the classifier keeps the span honest: the site covers exactly
        // the text a translator would rewrite.
        const trimmed = trimSpan(node.text)
        if (!trimmed || !/\p{L}/u.test(trimmed.text)) return false
        const startIdx = node.startIndex + trimmed.start
        const endIdx = node.startIndex + trimmed.end
        const span: Span = { start: map.byteOf(startIdx), end: map.byteOf(endIdx) }
        const s = map.lineColOf(startIdx)
        const e = map.lineColOf(endIdx)
        sites.push({
          file,
          path: anchorPath(node),
          kind: 'jsx-text',
          span,
          valueSpan: span,
          raw: trimmed.text,
          value: trimmed.text,
          quote: null,
          escapes: false,
          holes: [],
          line: s.line,
          col: s.col,
          endLine: e.line,
          endCol: e.col,
          extractor: 'ts-ast',
          tier: 'ast',
          container: { isKey: false, element: enclosingElement(node), inTest },
        })
        return false
      }

      case 'string': {
        const container = classifyStringContainer(node)
        const decoded = decodeString(node)
        recordTokens(node, decoded.value, container, { enums, compared, persisted }, file)
        push(node, 'string-literal', decoded.value, null, decoded.quote, [], container, decoded.escapes)
        return false
      }

      case 'template_string': {
        // The whole literal is one site, backticks included. A per-fragment site
        // could never produce "Monter {0}" from "Move {0} up": translating moves
        // the hole and can delete a static chunk outright, which is a rewrite of
        // the span, not a substitution within it.
        const { value, holes, escapes } = decodeTemplate(node, map)
        const container = classifyStringContainer(node)
        push(node, 'template', value, null, '`', holes, container, escapes)
        return false
      }

      case 'jsx_attribute': {
        const nameNode = node.child(0)
        const attrName = nameNode?.text ?? ''
        identifiers.add(attrName)
        const valueNode = node.childCount > 2 ? node.child(2) : null
        if (!valueNode) return false
        const container: Container = {
          isKey: false,
          attrName,
          element: enclosingElement(node),
          enclosingSymbol: enclosingSymbolName(node) ?? undefined,
        }
        if (valueNode.type === 'string') {
          const decoded = decodeString(valueNode)
          push(valueNode, 'attr', decoded.value, null, decoded.quote, [], container, decoded.escapes)
          return false
        }
        // `title={...}` — descend so a template or string inside the expression
        // is still found, but carry the attribute name down as context.
        walkTree(valueNode, (inner) => {
          if (inner.type === 'string') {
            const decoded = decodeString(inner)
            push(inner, 'attr', decoded.value, null, decoded.quote, [], container, decoded.escapes)
            return false
          }
          if (inner.type === 'template_string') {
            const { value, holes, escapes } = decodeTemplate(inner, map)
            push(inner, 'attr', value, null, '`', holes, container, escapes)
            return false
          }
          return true
        })
        return false
      }

      default:
        return true
    }
  })

  sites.sort((a, b) => a.span.start - b.span.start)
  return { sites, tokens: { enums, compared, persisted, identifiers } }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

function decodeString(node: Node): { value: string; quote: string; escapes: boolean } {
  const quote = node.text[0] ?? "'"
  let value = ''
  let escapes = false
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!
    if (child.type === 'string_fragment') value += child.text
    else if (child.type === 'escape_sequence') {
      escapes = true
      value += decodeEscape(child.text)
    }
  }
  // A grammar that yields no fragment children (an empty string) still has a
  // correct answer: the empty string.
  return { value, quote, escapes }
}

function decodeTemplate(node: Node, map: OffsetMap): { value: string; holes: Hole[]; escapes: boolean } {
  let value = ''
  let escapes = false
  const holes: Hole[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)!
    if (child.type === 'string_fragment') value += child.text
    else if (child.type === 'escape_sequence') {
      escapes = true
      value += decodeEscape(child.text)
    } else if (child.type === 'template_substitution') {
      const index = holes.length
      const expr = child.text.slice(2, -1)
      holes.push({
        index,
        span: { start: map.byteOf(child.startIndex), end: map.byteOf(child.endIndex) },
        expr,
        ...(isGrammarHole(child) ? { grammar: true } : {}),
      })
      value += `{${index}}`
    }
  }
  return { value, holes, escapes }
}

/**
 * A hole whose branches are string literals differing only by a suffix.
 *
 * `pomodoro${n > 1 ? 's' : ''}` encodes an English plural rule inside the
 * expression. The target language may need a DIFFERENT NUMBER of agreement
 * sites — French agrees the adjective too — so no string substitution can
 * produce a correct result. Detecting it structurally lets the engine refuse
 * rather than emit something plausible and wrong.
 */
function isGrammarHole(substitution: Node): boolean {
  const expr = substitution.child(1)
  if (!expr) return false
  if (expr.type !== 'ternary_expression' && expr.type !== 'binary_expression') return false
  const literals: string[] = []
  walkTree(expr, (n) => {
    if (n.type === 'string') {
      const d = decodeString(n)
      literals.push(d.value)
      return false
    }
    return true
  })
  if (literals.length < 2) return false
  return literals.every((l) => l.length <= 3)
}

function decodeEscape(seq: string): string {
  switch (seq) {
    case '\\n': return '\n'
    case '\\t': return '\t'
    case '\\r': return '\r'
    case '\\b': return '\b'
    case '\\f': return '\f'
    case '\\v': return '\v'
    case '\\0': return '\0'
    case '\\\\': return '\\'
    case "\\'": return "'"
    case '\\"': return '"'
    case '\\`': return '`'
    default:
      if (seq.startsWith('\\u{')) return String.fromCodePoint(parseInt(seq.slice(3, -1), 16))
      if (seq.startsWith('\\u')) return String.fromCharCode(parseInt(seq.slice(2), 16))
      if (seq.startsWith('\\x')) return String.fromCharCode(parseInt(seq.slice(2), 16))
      return seq.slice(1)
  }
}

/**
 * Split a comment into its delimiters and its text.
 *
 * The delimiters go back verbatim; only the text is translated. A JSDoc block
 * keeps its per-line asterisks, because losing them turns a documented function
 * into a wall of prose the next reader has to re-format.
 */
export function commentShape(raw: string): {
  prefix: string
  suffix: string
  linePrefix: string
  body: string
} {
  if (raw.startsWith('//')) {
    const m = /^(\/\/+!?\s*)/.exec(raw)!
    return { prefix: m[1]!, suffix: '', linePrefix: '', body: raw.slice(m[1]!.length) }
  }
  if (raw.startsWith('/*')) {
    const inner = raw.replace(/^\/\*+!?/, '').replace(/\*+\/$/, '')
    const lines = inner.split('\n')
    const openMatch = /^(\/\*+!?)/.exec(raw)!
    if (lines.length === 1) {
      const lead = /^(\s*)/.exec(inner)![1]!
      const trail = /(\s*)$/.exec(inner)![1]!
      return {
        prefix: openMatch[1]! + lead,
        suffix: trail + '*/',
        linePrefix: '',
        body: inner.trim(),
      }
    }
    // Multi-line: detect the ` * ` gutter from the second line, which is where
    // it is unambiguous.
    const gutter = /^(\s*\*+ ?)/.exec(lines[1] ?? '')?.[1] ?? ''
    const body = lines
      .map((l, i) => (i === 0 ? l.trim() : l.startsWith(gutter) ? l.slice(gutter.length) : l.trim()))
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
    return {
      prefix: openMatch[1]! + '\n' + gutter,
      suffix: '\n' + gutter.replace(/\*+ ?$/, '') + '*/',
      linePrefix: gutter,
      body,
    }
  }
  return { prefix: '', suffix: '', linePrefix: '', body: raw }
}

export function stripCommentMarkers(raw: string): string {
  return raw
    .replace(/^\/\*+!?/, '')
    .replace(/\*+\/$/, '')
    .replace(/^\/\/+!?/, '')
    .replace(/^#+/, '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*+ ?/, '').trim())
    .join('\n')
    .trim()
}

function trimSpan(text: string): { text: string; start: number; end: number } | null {
  const start = text.length - text.trimStart().length
  const end = text.trimEnd().length
  if (end <= start) return null
  return { text: text.slice(start, end), start, end }
}

function byteSpan(node: Node, map: OffsetMap): Span {
  return { start: map.byteOf(node.startIndex), end: map.byteOf(node.endIndex) }
}

function innerSpan(node: Node, span: Span, quote: string | null): Span {
  if (!quote) return span
  return { start: span.start + quote.length, end: span.end - quote.length }
}

// ---------------------------------------------------------------------------
// Container semantics — what the AST tier buys that a regex tier cannot
// ---------------------------------------------------------------------------

function classifyStringContainer(node: Node): Container {
  const parent = node.parent
  const container: Container = { isKey: false }

  const symbol = enclosingSymbolName(node)
  if (symbol) container.enclosingSymbol = symbol

  if (!parent) return container

  // `import x from 'here'` / `export … from 'here'` / `require('here')`
  if (parent.type === 'import_statement' || parent.type === 'export_statement') {
    container.moduleSpecifier = true
    return container
  }

  // An object key. Not interesting in itself, but emitting it proves the
  // extractor LOOKED at this span rather than stopping — which is what makes
  // the census's claimRatio a real measurement.
  if (parent.type === 'pair' && parent.child(0) === node) container.isKey = true

  if (parent.type === 'pair') {
    const obj = parent.parent
    if (obj) container.siblingKeys = objectKeys(obj)
  }

  // Compared, not rendered.
  if (parent.type === 'binary_expression') {
    const op = parent.child(1)?.text ?? ''
    if (COMPARISON_OPERATORS.has(op)) container.compared = true
  }
  if (parent.type === 'switch_case') container.compared = true

  // A member of a type union or a schema enum.
  if (
    parent.type === 'literal_type' ||
    parent.type === 'union_type' ||
    node.parent?.parent?.type === 'union_type'
  ) {
    container.enumMember = true
  }

  const call = callContext(node)
  if (call) {
    container.callee = call.callee
    container.argIndex = call.argIndex
    if (MEMBERSHIP_CALLEES.has(call.method ?? '')) container.compared = true
    if (isPersistCall(call)) container.persisted = true
    if (/^(z|v|yup)$/.test(call.receiver ?? '') || /^(enum|literal|picklist|oneOf)$/.test(call.method ?? '')) {
      container.enumMember = true
    }
  }

  const comment = precedingComment(node)
  if (comment) container.nearestComment = comment

  return container
}

interface CallContext {
  callee: string
  receiver: string | null
  method: string | null
  argIndex: number
}

function callContext(node: Node): CallContext | null {
  let cur: Node | null = node
  let arg: Node = node
  while (cur && cur.type !== 'call_expression') {
    if (cur.parent?.type === 'arguments') arg = cur
    cur = cur.parent
    if (cur && (cur.type === 'statement_block' || cur.type === 'program')) return null
  }
  if (!cur) return null
  const fn = cur.child(0)
  if (!fn) return null
  const args = cur.childForFieldName?.('arguments') ?? null
  let argIndex = -1
  if (args) {
    let seen = 0
    for (let i = 0; i < args.childCount; i++) {
      const c = args.child(i)!
      if (!c.isNamed) continue
      if (c.id === arg.id) argIndex = seen
      seen++
    }
  }
  if (fn.type === 'member_expression') {
    return {
      callee: fn.text,
      receiver: fn.child(0)?.text ?? null,
      method: fn.child(2)?.text ?? null,
      argIndex,
    }
  }
  return { callee: fn.text, receiver: null, method: fn.text, argIndex }
}

function isPersistCall(call: CallContext): boolean {
  if (call.receiver && PERSIST_RECEIVERS.has(call.receiver.split('.').pop() ?? '')) return true
  if (call.receiver?.includes('storage') || call.receiver?.includes('alarms')) return true
  return PERSIST_CALLEES.has(call.method ?? '') && (call.receiver?.includes('Storage') ?? false)
}

function recordTokens(
  node: Node,
  value: string,
  container: Container,
  index: { enums: Map<string, string[]>; compared: Map<string, string[]>; persisted: Map<string, string[]> },
  file: string,
): void {
  const at = `${file}:${node.startPosition.row + 1}`
  if (container.enumMember) addToken(index.enums, value, at)
  if (container.compared) addToken(index.compared, value, at)
  if (container.persisted) addToken(index.persisted, value, at)
}

function objectKeys(obj: Node): string[] {
  const keys: string[] = []
  for (let i = 0; i < obj.childCount; i++) {
    const child = obj.child(i)!
    if (child.type !== 'pair') continue
    const key = child.child(0)
    if (key) keys.push(key.type === 'string' ? decodeString(key).value : key.text)
  }
  return keys
}

function precedingComment(node: Node): string | undefined {
  let cur: Node | null = node
  while (cur && !cur.previousNamedSibling && cur.parent) cur = cur.parent
  const prev = cur?.previousNamedSibling
  if (prev?.type === 'comment') return stripCommentMarkers(prev.text)
  return undefined
}

function enclosingElement(node: Node): string | undefined {
  let cur = node.parent
  while (cur) {
    if (cur.type === 'jsx_element' || cur.type === 'jsx_self_closing_element') {
      const opening = cur.type === 'jsx_element' ? cur.child(0) : cur
      const name = opening?.child(1)
      return name?.text
    }
    cur = cur.parent
  }
  return undefined
}

function enclosingSymbolName(node: Node): string | null {
  let cur: Node | null = node.parent
  while (cur) {
    switch (cur.type) {
      case 'function_declaration':
      case 'generator_function_declaration':
      case 'class_declaration':
      case 'method_definition': {
        const name = cur.childForFieldName?.('name')
        if (name) return name.text
        break
      }
      case 'variable_declarator': {
        const name = cur.child(0)
        if (name) return name.text
        break
      }
    }
    cur = cur.parent
  }
  return null
}

// ---------------------------------------------------------------------------
// Anchor paths
// ---------------------------------------------------------------------------

/**
 * A structural path to a node, containing no part of its value.
 *
 * Ordinals come from the position among NAMED siblings, never from the line, so
 * inserting a statement above does not renumber anything below it.
 */
export function anchorPath(node: Node): string {
  const segments: string[] = []
  let cur: Node | null = node
  let child: Node | null = null

  while (cur) {
    const segment = pathSegment(cur, child)
    if (segment) segments.push(segment)
    child = cur
    cur = cur.parent
  }
  return segments.reverse().join('/') || 'root'
}

function pathSegment(node: Node, child: Node | null): string | null {
  switch (node.type) {
    case 'program':
      return null
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'class_declaration':
    case 'method_definition':
      return node.childForFieldName?.('name')?.text ?? node.type
    case 'variable_declarator':
      return node.child(0)?.text ?? null
    case 'export_statement':
      return node.text.startsWith('export default') ? 'default' : null
    case 'pair': {
      const key = node.child(0)
      if (!key) return null
      return key.type === 'string' ? decodeString(key).value : key.text
    }
    case 'array': {
      if (!child) return null
      let i = 0
      for (let k = 0; k < node.childCount; k++) {
        const c = node.child(k)!
        if (!c.isNamed) continue
        if (c.id === child.id) return `[${i}]`
        i++
      }
      return null
    }
    case 'call_expression': {
      const fn = node.child(0)
      return fn ? `${fn.text}()` : null
    }
    case 'jsx_element':
    case 'jsx_self_closing_element': {
      const opening = node.type === 'jsx_element' ? node.child(0) : node
      const name = opening?.child(1)?.text ?? 'jsx'
      return `${name}${siblingOrdinal(node)}`
    }
    case 'jsx_attribute':
      return `@${node.child(0)?.text ?? 'attr'}`
    default:
      return null
  }
}

function siblingOrdinal(node: Node): string {
  const parent = node.parent
  if (!parent) return ''
  let index = 0
  let total = 0
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i)!
    if (c.type !== node.type) continue
    if (c.id === node.id) index = total
    total++
  }
  return total > 1 ? `[${index}]` : ''
}
