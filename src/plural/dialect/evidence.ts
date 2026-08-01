// What the repository DECLARES about itself, gathered once and citable.
//
// Nothing in `src/` reads dependencies today. `isBundleFile` is the whole
// evidence layer, and it answers "does this path contain a locale?" — never
// "does this repository use i18next?". That gap is why `foo_one` in an unrelated
// JSON is read as an i18next plural: not because the engine decided it was, but
// because it had no way to ask.
//
// Every reader below is a LINE SCAN, not a parser, and that is defensible
// because of the direction of the error. A missed dependency yields NO evidence,
// which is a refusal to claim. It can never produce a wrong claim. A parser
// would buy correctness on malformed manifests and cost a dependency, and the
// trade is the wrong way round for something whose failure mode is silence.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Site } from '../../types'
import type { EvidenceNames, EvidenceSpec, PluralDialect } from './types'

/** A declared name, and the line that declares it. */
export interface Fact {
  name: string
  file: string
  line: number
}

export interface RepoEvidence {
  /** Declared dependencies, from every manifest found. */
  dependencies: Map<string, Fact>
  /** Repo-relative paths, for `configFile` globs. */
  files: Set<string>
  /** Module specifiers the code imports. */
  imports: Map<string, Fact>
}

export const NO_EVIDENCE: RepoEvidence = {
  dependencies: new Map(),
  files: new Set(),
  imports: new Map(),
}

export function gatherEvidence(repo: string, files: string[], sites: Site[]): RepoEvidence {
  const dependencies = new Map<string, Fact>()
  const imports = new Map<string, Fact>()

  for (const rel of files) {
    for (const fact of readManifest(repo, rel)) {
      if (!dependencies.has(fact.name)) dependencies.set(fact.name, fact)
    }
  }

  // Imports come free: `classify` already decided which sites are module
  // specifiers, so there is nothing to extract a second time.
  for (const site of sites) {
    if (site.reason !== 'module-specifier') continue
    const name = packageOf(site.value)
    if (!name || imports.has(name)) continue
    imports.set(name, { name, file: site.file, line: site.line })
  }

  return { dependencies, files: new Set(files), imports }
}

/** `@scope/pkg/sub` → `@scope/pkg`; `./relative` → null. */
function packageOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

// ---------------------------------------------------------------------------
// One reader per ecosystem. Each returns facts or nothing; none of them throws.

function readManifest(repo: string, rel: string): Fact[] {
  const base = rel.slice(rel.lastIndexOf('/') + 1)
  const abs = join(repo, rel)
  const text = read(abs)
  if (text === null) return []

  if (base === 'package.json') return fromJsonDeps(text, rel, /"(dependencies|devDependencies|peerDependencies|optionalDependencies)"/)
  if (base === 'composer.json') return fromJsonDeps(text, rel, /"(require|require-dev)"/)
  if (base === 'pyproject.toml') return fromTomlDeps(text, rel, /^\[(project|tool\.poetry\.dependencies)/)
  if (base === 'Cargo.toml') return fromTomlDeps(text, rel, /^\[(dependencies|dev-dependencies)/)
  if (base === 'pubspec.yaml') return fromYamlDeps(text, rel)
  if (base === 'Gemfile' || base.endsWith('.gemspec')) return fromLines(text, rel, /^\s*(?:gem|\w+\.add_\w*dependency)\s+['"]([^'"]+)/)
  if (base === 'go.mod') return fromGoMod(text, rel)
  if (base.endsWith('.csproj')) return fromLines(text, rel, /PackageReference\s+Include="([^"]+)"/)
  return []
}

function read(abs: string): string | null {
  if (!existsSync(abs)) return null
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/**
 * Keys of a dependency object in a JSON manifest.
 *
 * Scanned rather than parsed, so a manifest with a trailing comma still yields
 * its dependencies instead of yielding an exception. Scanned by CHARACTER rather
 * than by line, because a manifest is very often minified onto one — and a
 * line-oriented reader silently returns nothing for those, which is the failure
 * mode this whole module is built to avoid.
 */
function fromJsonDeps(text: string, file: string, section: RegExp): Fact[] {
  const out: Fact[] = []
  // Where each dependency section starts, so nesting can be tracked from there.
  const starts: number[] = []
  const anySection = new RegExp(section.source, 'g')
  for (const m of text.matchAll(anySection)) {
    const open = text.indexOf('{', m.index + m[0].length)
    if (open !== -1) starts.push(open)
  }

  for (const open of starts) {
    let depth = 0
    for (let i = open; i < text.length; i++) {
      const ch = text[i]
      if (ch === '"') {
        // Skip the string, so a brace inside a version range cannot unbalance us.
        const end = endOfString(text, i)
        if (depth === 1) {
          const name = text.slice(i + 1, end)
          const after = text.slice(end + 1, end + 3)
          if (/^\s*:/.test(after)) out.push({ name, file, line: lineOf(text, i) })
        }
        i = end
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) break
      }
    }
  }
  return out
}

function endOfString(text: string, quote: number): number {
  for (let i = quote + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return text.length
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++
  return line
}

function fromTomlDeps(text: string, file: string, section: RegExp): Fact[] {
  const out: Fact[] = []
  const lines = text.split('\n')
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\[/.test(line)) {
      inSection = section.test(line)
      continue
    }
    if (!inSection) continue
    // `foo = "1.0"` and PEP 621's `dependencies = ["foo>=1"]`, on one line or
    // spread over several.
    const key = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line)
    if (key && key[1] !== 'dependencies') out.push({ name: key[1]!, file, line: i + 1 })
    for (const m of line.matchAll(/["']([A-Za-z0-9_.-]+)\s*[<>=~!\[]/g)) {
      out.push({ name: m[1]!, file, line: i + 1 })
    }
  }
  return out
}

function fromYamlDeps(text: string, file: string): Fact[] {
  const out: Fact[] = []
  const lines = text.split('\n')
  let inSection = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^(dependencies|dev_dependencies):/.test(line)) {
      inSection = true
      continue
    }
    if (/^\S/.test(line)) inSection = false
    if (!inSection) continue
    const m = /^\s{2}([A-Za-z0-9_.-]+)\s*:/.exec(line)
    if (m) out.push({ name: m[1]!, file, line: i + 1 })
  }
  return out
}

function fromGoMod(text: string, file: string): Fact[] {
  const out: Fact[] = []
  const lines = text.split('\n')
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^require\s*\(/.test(line)) {
      inBlock = true
      continue
    }
    if (inBlock && /^\)/.test(line)) {
      inBlock = false
      continue
    }
    const m = inBlock ? /^\s*(\S+)/.exec(line) : /^require\s+(\S+)/.exec(line)
    if (m && m[1] && !m[1].startsWith('//')) out.push({ name: m[1], file, line: i + 1 })
  }
  return out
}

function fromLines(text: string, file: string, re: RegExp): Fact[] {
  const out: Fact[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]!)
    if (m?.[1]) out.push({ name: m[1], file, line: i + 1 })
  }
  return out
}

// ---------------------------------------------------------------------------

export interface EvidenceVerdict {
  /** False when a `declared` dialect's evidence is absent: the row is inert. */
  applies: boolean
  /** The facts that support it, for `dialects --explain`. */
  cites: Fact[]
}

/**
 * Does this repository's evidence admit this dialect?
 *
 * Only `declared` can answer no. `intrinsic` and `catalog` always apply — their
 * guard is the arrangement itself, or `where.bundleOnly`. What evidence buys
 * them is a CITATION and a tiebreak, not permission, because demanding a named
 * dependency for `key_one` would refuse the large hand-rolled majority that
 * arrangement exists to serve.
 */
export function evidenceFor(dialect: PluralDialect, evidence: RepoEvidence): EvidenceVerdict {
  const spec: EvidenceSpec = dialect.evidence
  if (spec.mode === 'intrinsic') return { applies: true, cites: [] }
  if (spec.mode === 'catalog') {
    return { applies: true, cites: spec.prefer ? factsFor(spec.prefer, evidence) : [] }
  }
  const cites = factsFor(spec, evidence)
  return { applies: cites.length > 0, cites }
}

function factsFor(names: EvidenceNames, evidence: RepoEvidence): Fact[] {
  const out: Fact[] = []
  for (const dep of names.dependency ?? []) {
    const fact = evidence.dependencies.get(dep)
    if (fact) out.push(fact)
  }
  for (const imported of names.importOf ?? []) {
    const fact = evidence.imports.get(imported)
    if (fact) out.push(fact)
  }
  for (const path of names.configFile ?? []) {
    if (evidence.files.has(path)) out.push({ name: path, file: path, line: 1 })
  }
  return out
}
