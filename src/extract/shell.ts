// Shell extraction, on the AST tier.
//
// Comments and nothing else, and that is the whole design rather than a first
// pass. A shell script's strings are arguments to programs — paths, flags,
// package names, `sed` expressions — and a reader that emitted them would hand
// a translator a wall of tokens to refuse one at a time. What a person reads in
// a shell script is the comments, and in an install script those comments are
// instructions written for a human being.
//
// Every other node is READ and judged non-textual, which is exactly the
// assertion `claimRatio` records. The grammar is codeindex's `bash.wasm`, in its
// CORE tier, already mapped from `.sh` and `.bash` by `grammarKeyForExt`.
import type { Span } from '../types'
import type { RawSite, TokenIndex } from './raw'
import { walkTree, type Node, type Tree } from '../ast/parse'
import { OffsetMap } from '../vendor/text'

export interface ShellExtractResult {
  sites: RawSite[]
  tokens: Pick<TokenIndex, 'enums' | 'compared' | 'persisted' | 'identifiers'>
  errorSpans: Span[]
  hasError: boolean
}

/**
 * Comments addressed to a tool rather than to a person.
 *
 * `#!` is the kernel's, and the rest are read by linters and formatters that
 * would break if the token were translated.
 */
const DIRECTIVE = /^#\s*(!|shellcheck\b|shfmt\b|-\*-|vim:|Editor:)/

/**
 * Ignore-file formats: comments, patterns, and nothing else.
 *
 * They share the shell's comment syntax and share nothing else with it, which
 * is why they are named here rather than routed by extension alone. `.gitignore`
 * is where a repository writes down what it is hiding, often in prose.
 */
const COMMENT_ONLY_BASENAMES = new Set([
  '.gitignore', '.dockerignore', '.npmignore', '.eslintignore', '.prettierignore',
  '.gitattributes', '.env.example', '.env.sample', '.env.template',
])

/**
 * Deliberately short.
 *
 * `.ini`, `.conf`, `.cfg` and `.properties` also use `#` comments and are NOT
 * shell: they have sections, `key = value` and their own quoting, and handing
 * one to the bash grammar buys a pile of unparseable regions in exchange for
 * the comments a sweep already surfaces. Each of those is its own decision with
 * its own corpus case, not a guess made here.
 */
const COMMENT_ONLY_EXT = new Set(['.example', '.sample', '.template'])

/** Is this a `#`-comment format the shell reader can serve? */
export function isCommentOnly(rel: string, ext: string): boolean {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  if (COMMENT_ONLY_BASENAMES.has(base)) return true
  return COMMENT_ONLY_EXT.has(ext)
}

export function extractShell(
  file: string,
  text: string,
  tree: Tree,
  map: OffsetMap,
): ShellExtractResult {
  const sites: RawSite[] = []
  const identifiers = new Set<string>()
  const errorSpans: Span[] = []
  let hasError = false
  let index = 0

  walkTree(tree.rootNode, (node) => {
    if (node.type === 'ERROR' || node.isMissing) {
      hasError = true
      errorSpans.push({ start: map.byteOf(node.startIndex), end: map.byteOf(node.endIndex) })
      return false
    }

    // Every command name and variable this script declares is repo vocabulary,
    // which is what keeps the residual sweep from reading them as prose.
    if (node.type === 'command_name' || node.type === 'variable_name') {
      identifiers.add(node.text)
      return
    }

    if (node.type !== 'comment') return undefined

    const body = node.text
    if (DIRECTIVE.test(body)) return false
    const marker = /^#+\s?/.exec(body)?.[0] ?? '#'
    const value = body.slice(marker.length).trimEnd()
    if (!/\p{L}{2,}/u.test(value)) return false

    const s = map.lineColOf(node.startIndex)
    const e = map.lineColOf(node.endIndex)
    sites.push({
      file,
      path: `#comment[${index++}]`,
      kind: 'comment',
      span: { start: map.byteOf(node.startIndex), end: map.byteOf(node.endIndex) },
      valueSpan: { start: map.byteOf(node.startIndex + marker.length), end: map.byteOf(node.endIndex) },
      raw: body,
      value,
      quote: null,
      escapes: false,
      holes: [],
      line: s.line,
      col: s.col,
      endLine: e.line,
      endCol: e.col,
      extractor: 'shell-ast',
      tier: 'ast',
      container: { isKey: false },
      prefix: marker,
      suffix: '',
      linePrefix: '',
    })
    return false
  })

  sites.sort((a, b) => a.span.start - b.span.start)
  return {
    sites,
    tokens: { enums: new Map(), compared: new Map(), persisted: new Map(), identifiers },
    errorSpans,
    hasError,
  }
}
