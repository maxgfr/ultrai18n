// Tree-sitter parsing, layered on codeindex's grammar provisioning.
//
// The division is deliberate. codeindex already solves grammar management
// properly — version pinning, sha256-verified download, a shared cache, a
// documented resolution order — and reimplementing that would be pure risk for
// no gain. What codeindex does NOT give us is an extractor that keeps prose:
// its own visitor looks for declarations, its string handling drops positions
// and the original text, and its STRING_NODE regex does not match `jsx_text` at
// all. So: its parser, our visitor.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Parser, Language, type Node, type Tree } from 'web-tree-sitter'
import { ensureGrammars, grammarKeyForExt, resolveGrammarsDir } from '@maxgfr/codeindex'

export type { Node, Tree }

/** Extensions we have a grammar for AND a visitor for. */
export const AST_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
])

let initialized = false
const cache = new Map<string, Parser | null>()

export interface GrammarStatus {
  tier: 'shipped' | 'adjacent' | 'cache' | 'pulled' | 'none'
  dir: string | null
  /** Why the AST tier is unavailable, when it is. Surfaced in the census. */
  reason?: string
}

let status: GrammarStatus = { tier: 'none', dir: null }

export function grammarStatus(): GrammarStatus {
  return status
}

/**
 * Grammars shipped beside the engine.
 *
 * The four JS/TS wasm files are ~3.3 MB and they are committed, rather than
 * pulled on first use. The alternative — resolving through codeindex's shared
 * cache, and downloading ~17 MB when it misses — makes the AST tier depend on
 * network access at the moment of first use. That turns a strong guarantee
 * ("this repo is parsed properly") into a conditional one, and the difference
 * only ever shows up as a quietly weaker result on someone else's machine.
 */
function shippedGrammarsDir(): string | null {
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'grammars')
    return existsSync(join(dir, 'tsx.wasm')) ? dir : null
  } catch {
    return null
  }
}

/**
 * Prepare the grammars needed for a set of extensions.
 *
 * Degradation is explicit and reported, never silent: a repo parsed by the
 * regex tier has materially weaker container semantics (no key-vs-value, no
 * enum detection), and a user who is not told that will read the output as if
 * it had the strong guarantees.
 */
export async function prepareGrammars(exts: Iterable<string>): Promise<GrammarStatus> {
  const keys = new Set<string>()
  for (const ext of exts) {
    if (!AST_EXTENSIONS.has(ext)) continue
    const key = grammarKeyForExt(ext)
    if (key) keys.add(key)
  }
  if (keys.size === 0) {
    status = { tier: 'none', dir: null, reason: 'no AST-eligible files in this repo' }
    return status
  }

  const shipped = shippedGrammarsDir()
  if (shipped) {
    status = { tier: 'shipped', dir: shipped }
    return status
  }

  // Development, or a future language whose grammar is not shipped: fall back
  // to codeindex's provisioning, which may reach the network.
  try {
    await ensureGrammars([...keys])
    const dir = resolveGrammarsDir()
    if (!dir) {
      status = { tier: 'none', dir: null, reason: 'no grammars directory resolved' }
      return status
    }
    status = { tier: 'adjacent', dir }
    return status
  } catch (err) {
    status = {
      tier: 'none',
      dir: null,
      reason: `grammars unavailable (${(err as Error).message}) — falling back to the regex tier`,
    }
    return status
  }
}

export async function parserForExt(ext: string): Promise<Parser | null> {
  if (!AST_EXTENSIONS.has(ext)) return null
  const key = grammarKeyForExt(ext)
  if (!key) return null
  if (cache.has(key)) return cache.get(key)!

  const dir = status.dir ?? resolveGrammarsDir()
  if (!dir) {
    cache.set(key, null)
    return null
  }
  try {
    if (!initialized) {
      // web-tree-sitter loads its own runtime wasm by relative path, which is
      // wrong once the engine is a single file somewhere else entirely. Point
      // it at the copy sitting beside the grammars.
      await Parser.init({
        locateFile: (name: string) => join(dir, name),
      })
      initialized = true
    }
    const language = await Language.load(join(dir, `${key}.wasm`))
    const parser = new Parser()
    parser.setLanguage(language)
    cache.set(key, parser)
    return parser
  } catch {
    cache.set(key, null)
    return null
  }
}

/**
 * Depth-first walk in source order.
 *
 * `enter` returning false prunes the subtree — used to stop descending into a
 * node the visitor has already claimed whole, such as a template literal whose
 * fragments must NOT become separate sites.
 */
export function walkTree(node: Node, enter: (n: Node) => boolean | void): void {
  const stack: Node[] = [node]
  while (stack.length) {
    const n = stack.pop()!
    if (enter(n) === false) continue
    for (let i = n.childCount - 1; i >= 0; i--) {
      const child = n.child(i)
      if (child) stack.push(child)
    }
  }
}

/** Nearest ancestor of any of the given types, or null. */
export function ancestorOfType(node: Node, types: Set<string>): Node | null {
  let cur = node.parent
  while (cur) {
    if (types.has(cur.type)) return cur
    cur = cur.parent
  }
  return null
}
