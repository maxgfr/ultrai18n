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
import { walkTree, ancestorOfType, type Node, type Tree } from '../ast/parse'
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

/** For the ancestor lookup that recovers a JSX attribute's context. */
const JSX_ATTRIBUTE = new Set(['jsx_attribute'])

export interface TsExtractResult {
  sites: RawSite[]
  /** Contributions to the repo-wide cross-reference indexes. */
  tokens: Pick<TokenIndex, 'enums' | 'compared' | 'persisted' | 'identifiers'>
  /**
   * Byte spans the grammar could not parse.
   *
   * The visitor below reaches every node in the tree, so what it did NOT look
   * at is exactly the regions tree-sitter failed on. Reporting them turns the
   * AST tier's coverage from an assertion into a measurement — and lets the
   * residual sweep run over precisely those regions, so a grammar that breaks
   * down on unfamiliar syntax produces `unclassified` sites instead of silence.
   */
  errorSpans: Span[]
  hasError: boolean
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
  const identifierHits: { name: string; at: number }[] = []
  const errorSpans: Span[] = []
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
    // A region the grammar gave up on. Recorded and still descended into: an
    // ERROR node often contains perfectly good children, and claiming the whole
    // span as unreadable would throw away sites that are right there.
    if (node.type === 'ERROR' || node.isMissing) {
      errorSpans.push(byteSpan(node, map))
      if (node.isMissing) return false
    }

    switch (node.type) {
      case 'identifier':
      case 'type_identifier':
      case 'property_identifier':
        // Byte offset, to match errorSpans — startIndex is a UTF-16 index.
        identifierHits.push({ name: node.text, at: map.byteOf(node.startIndex) })
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
        // `attr` is not cosmetic: `syntaxFor` reads it, and a JSX attribute
        // escapes its value as entities rather than with backslashes.
        const kind = container.attrName !== undefined ? 'attr' : 'string-literal'
        push(node, kind, decoded.value, null, decoded.quote, [], container, decoded.escapes)
        return false
      }

      case 'template_string': {
        // The whole literal is one site, backticks included. A per-fragment site
        // could never produce "Monter {0}" from "Move {0} up": translating moves
        // the hole and can delete a static chunk outright, which is a rewrite of
        // the span, not a substitution within it.
        const { value, holes, escapes } = decodeTemplate(node, map)
        const container = classifyStringContainer(node)
        const kind = container.attrName !== undefined ? 'attr' : 'template'
        push(node, kind, value, null, '`', holes, container, escapes)
        return false
      }

      case 'jsx_attribute': {
        // Register the name and DESCEND. This used to run its own walk over the
        // value looking for a string or a template, then prune the outer one —
        // so everything else inside `onAdopt={…}` was unreachable by the main
        // visitor. A three-line comment vanished, and, far worse, so did
        // `empty={<p>Aucun projet pour le moment</p>}`: a rendered JSX label
        // inside an attribute expression, in a file reporting a claimRatio of
        // 1.0. `sites --audit` found the comment on a real repository; the JSX
        // text was underneath it.
        //
        // The attribute's own context is recovered by ancestor lookup instead,
        // exactly as `enclosingElement` already recovers the element — so one
        // visitor handles every node type once, and a construct nobody thought
        // of is handled by whichever case owns it rather than by this list.
        identifiers.add(node.child(0)?.text ?? '')
        return true
      }

      default:
        return true
    }
  })

  // An "identifier" the grammar only produced while recovering from a parse
  // error is not evidence that the repository declares that name. Keeping them
  // would be quietly self-defeating: the residual sweep treats a declared name
  // as code, so a sentence sitting in an unparseable region would register its
  // own words as identifiers and then suppress itself for containing them.
  for (const hit of identifierHits) {
    if (errorSpans.some((s) => hit.at >= s.start && hit.at < s.end)) continue
    identifiers.add(hit.name)
  }

  sites.sort((a, b) => a.span.start - b.span.start)
  return {
    sites,
    tokens: { enums, compared, persisted, identifiers },
    errorSpans,
    hasError: tree.rootNode.hasError || errorSpans.length > 0,
  }
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

  // Inside a JSX attribute, whether directly (`title="…"`) or through an
  // expression (`title={cond ? "…" : "…"}`). Recovered from the ancestors so
  // the attribute branch does not have to walk the value itself and prune
  // everything it does not recognise.
  const attribute = ancestorOfType(node, JSX_ATTRIBUTE)
  if (attribute) {
    container.attrName = attribute.child(0)?.text ?? ''
    container.element = enclosingElement(node)
  }

  if (!parent) return container

  // `import x from 'here'` / `export … from 'here'` / `require('here')`
  if (parent.type === 'import_statement' || parent.type === 'export_statement') {
    container.moduleSpecifier = true
    return container
  }

  // An object key. Not interesting in itself, but emitting it proves the
  // extractor LOOKED at this span rather than stopping — which is what makes
  // the census's claimRatio a real measurement.
  //
  // Compared by id, never by reference: `child(0)` allocates a fresh wrapper
  // every call, so `===` is false even for the node it just returned. The
  // reference form silently left every quoted key in every TypeScript file
  // unflagged, and the cascade then handed `'Content-Type'` to the language
  // detector — where a key that happens to read like prose comes back
  // `translate` and the object's contract is rewritten.
  if (parent.type === 'pair' && parent.child(0)?.id === node.id) container.isKey = true

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

  const branch = enclosingBranch(node)
  if (branch) container.branchGroup = branch

  // The value side of `enum Channel { Email = 'email' }`.
  //
  // A declared enum is not the `as const` case above: there is nothing to
  // disambiguate, because the author wrote `enum`. Leaving it unflagged meant
  // only brevity protected it — `'email'` survived as `short-string`, while a
  // member spelled `'invitation envoyée'` reads as copy and gets translated,
  // which invalidates every value already persisted under it.
  if (parent.type === 'enum_assignment' && parent.child(0)?.id !== node.id) {
    container.enumMember = true
  }

  // `` css`…` ``, `` gql`…` ``, `` styled.div`…` `` — the tag decides what the
  // template holds, and without it a stylesheet reads as a paragraph of words.
  //
  // Two node shapes, because the grammars disagree: some model a tagged
  // template as its own node, and the shipped TSX grammar models it as a
  // `call_expression` whose template is a DIRECT child. The direct-child part
  // is what separates a tag from an ordinary argument, which always sits
  // inside an `arguments` node.
  const tagged =
    parent.type === 'tagged_template_expression' ||
    (parent.type === 'call_expression' && parent.child(0)?.id !== node.id)
  if (tagged && node.type === 'template_string') {
    const tag = parent.child(0)
    if (tag) container.tag = tag.text
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
  if (container.enumMember || inAsConstArray(node)) addToken(index.enums, value, at)
  if (container.compared) addToken(index.compared, value, at)
  if (container.persisted) addToken(index.persisted, value, at)
}

/**
 * A member of an `as const` array — recorded as an enum ORIGIN, never verdicted
 * as one.
 *
 * `['active', 'done'] as const` is an enum and `['Oui', 'Non'] as const` is
 * copy, and nothing structural tells them apart. So this feeds the
 * cross-reference index only: if the same text is also rendered somewhere, the
 * dual-use hazard fires and a person decides. Setting `enumMember` here instead
 * would silently protect every `as const` label array — and would run before
 * the calendar-vocabulary check, which is exactly the case that needs it least.
 */
/**
 * A function boundary, for the branch walk.
 *
 * A callback written inside a `switch` arm is not another arm of that switch —
 * `case 'a': return items.map(i => 'Label')` shares nothing editorially with
 * `case 'b'`'s return value — so the walk stops rather than grouping them.
 */
const FUNCTION_LIKE = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
])

/**
 * The nearest branching construct holding this literal, as an anchor.
 *
 * Bounded at the enclosing function or module so a `switch` five frames up in
 * an unrelated outer scope never groups anything. Returns the construct's own
 * anchor, which is stable across insertions for the same reason every other
 * anchor is: it counts named siblings, never lines.
 */
function enclosingBranch(node: Node): string | undefined {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === 'switch_statement' || cur.type === 'ternary_expression') {
      return anchorPath(cur)
    }
    if (FUNCTION_LIKE.has(cur.type) || cur.type === 'class_declaration' || cur.type === 'program') {
      return undefined
    }
  }
  return undefined
}

function inAsConstArray(node: Node): boolean {
  const array = node.parent
  if (!array || array.type !== 'array') return false
  let cur: Node | null = array.parent
  while (cur && (cur.type === 'as_expression' || cur.type === 'satisfies_expression')) {
    if (/\bas\s+const\b/.test(cur.text.slice(array.text.length))) return true
    cur = cur.parent
  }
  return false
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
    if (segment) {
      segments.push(segment)
    } else if (child && segments.length === 0 && ORDINAL_CONTAINERS.has(cur.type)) {
      // Nothing below this point had a name, so the node is anonymous within an
      // ordered container and its POSITION in that container is the only thing
      // that identifies it. Three comments in one function body, three members
      // of a union, two import specifiers — each of those used to collapse onto
      // the same path, and a shared path is a shared site id, which `apply`
      // resolves with a Map. One translation would land on another's bytes.
      //
      // The guard on `segments.length` is what keeps this from churning every
      // existing anchor: an ordinal is emitted INSTEAD of a missing name, never
      // in addition to one, so `WEEKDAY/[0]` and `default/…/manifest/name` are
      // untouched.
      segments.push(
        `[${cur.type === 'union_type' ? unionOrdinal(cur, child) : namedOrdinal(cur, child)}]`,
      )
    }
    child = cur
    cur = cur.parent
  }
  return segments.reverse().join('/') || 'root'
}

/**
 * Nodes whose children are an ordered list with no names of their own.
 *
 * `array` is absent because its own case already returns the ordinal directly.
 */
const ORDINAL_CONTAINERS = new Set([
  'program',
  'statement_block',
  'union_type',
  'class_body',
  'arguments',
  'object',
])

/**
 * Position of a member within the WHOLE union, not within one link of it.
 *
 * `'a' | 'b' | 'c'` parses left-associatively as `union(union(a, b), c)`, so
 * each link has exactly two named children and counting inside one link gives
 * `[0] [1]` and then `[1]` again. Flattening first is the difference between an
 * anchor that identifies a member and one that identifies two.
 */
function unionOrdinal(union: Node, child: Node): number {
  let top = union
  while (top.parent?.type === 'union_type') top = top.parent
  const members: Node[] = []
  const collect = (n: Node): void => {
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i)!
      if (!c.isNamed) continue
      if (c.type === 'union_type') collect(c)
      else members.push(c)
    }
  }
  collect(top)
  const index = members.findIndex(
    (m) => child.startIndex >= m.startIndex && child.endIndex <= m.endIndex,
  )
  return index === -1 ? 0 : index
}

/** Position of `child` among its parent's named children. */
function namedOrdinal(parent: Node, child: Node): number {
  let index = 0
  for (let i = 0; i < parent.childCount; i++) {
    const c = parent.child(i)!
    if (!c.isNamed) continue
    if (c.id === child.id) return index
    index++
  }
  return index
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
    // A type's name is as good an anchor as a function's, and without it every
    // member of `type Status = 'a' | 'b'` anchors at the file root.
    case 'type_alias_declaration':
    case 'interface_declaration':
    case 'enum_declaration':
      return node.childForFieldName?.('name')?.text ?? null
    case 'export_statement':
      return node.text.startsWith('export default') ? 'default' : null
    // `enum Channel { Email = 'email' }`. Without this both members anchor at
    // `Channel` and collide into `Channel` + `Channel~2` — and a `~n` suffix is
    // the documented last resort, not the normal way to address an enum.
    case 'enum_assignment':
      return node.childForFieldName?.('name')?.text ?? node.child(0)?.text ?? null
    // The branching constructs, named rather than numbered.
    //
    // Every arm of a `switch` and both sides of a ternary used to collapse onto
    // the anchor of the statement holding them: four strings, one path, three
    // `~n` collisions. A collision is REPORTED as a defect, and these are not
    // one — they are four addressable positions nobody had spelled out. The
    // ordinal branch in `anchorPath` cannot do this, because it fires only when
    // nothing below had a name, so a second anonymous container never gets one.
    case 'switch_case':
    case 'switch_default': {
      const value = node.childForFieldName?.('value')
      if (!value) return 'case[default]'
      // The selector, not the body: `case 'sync':` is `case[sync]` whichever
      // statements follow it.
      if (child && child.id === value.id) return null
      return `case[${value.type === 'string' ? decodeString(value).value : value.text}]`
    }
    case 'ternary_expression': {
      if (!child) return null
      const consequence = node.childForFieldName?.('consequence')
      const alternative = node.childForFieldName?.('alternative')
      if (consequence && child.id === consequence.id) return '?then'
      if (alternative && child.id === alternative.id) return '?else'
      return null
    }
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
