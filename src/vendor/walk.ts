// Vendored from @maxgfr/codeindex v2.28.6 (MIT), with four marked divergences.
// See ./README.md.
import {
  readdirSync,
  statSync,
  lstatSync,
  readFileSync,
  realpathSync,
  existsSync,
  type Dirent,
} from 'node:fs'
import { join, relative, resolve, sep, extname } from 'node:path'
import { parseGitignore, isIgnored, type IgnoreRule } from './ignore'

// Directories that never carry signal and would bloat the walk (dependencies,
// build output, VCS internals, caches).
export const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.pnpm', 'bower_components', 'vendor', 'dist', 'build', 'out',
  'target', '.next', '.nuxt', '.svelte-kit', '.turbo', 'coverage', '__pycache__', '.venv',
  'venv', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.vscode', '.cache',
  'tmp', '.ultraindex', '.codeindex', '.ultrai18n', 'Pods', 'DerivedData', '.terraform',
  'elm-stuff', '.dart_tool',
])

// The VCS entry that marks a repository root: a directory for a normal clone,
// a "gitdir: <path>" FILE for a linked worktree or a submodule.
const GIT_ENTRY = '.git'

function isIgnoredDirectory(name: string, ignoreDirs: Set<string>): boolean {
  // `.git` is structural, not a preference: VCS internals (objects, packs,
  // hooks) never carry signal, so it stays ignored even when a caller-supplied
  // `ignoreDirs` replaces the default set without listing it.
  // A process killed during an atomic symbolic edit can leave the
  // `.codeindex-edit-*` directory beside the source. It holds a copy of that
  // source and must never become a duplicate phantom file in the next walk,
  // even when the consumer repo has no matching .gitignore rule.
  return name === GIT_ENTRY || ignoreDirs.has(name) || name.startsWith('.codeindex-edit-')
}

// A gitfile's mandatory opening bytes. Git's parser (read_gitfile_gently)
// compares the first 8 bytes against exactly this: `gitdir:` without the space,
// leading whitespace, or the line appearing anywhere but the start are all
// rejected as "invalid gitfile format".
const GITFILE_PREFIX = 'gitdir: '
// A real gitfile is one short line. The cap keeps a file that merely CARRIES
// the name `.git` — a stray archive, a truncated dump — from being read whole
// just to discover it is not a gitfile.
const MAX_GITFILE_BYTES = 4096

// The git directory a `.git` entry in `dir` points at, or undefined when there
// is none, or when the entry is not a repository marker.
//
// Validity is checked rather than assumed: a boundary that triggered on the
// NAME alone would let a file named `.git` holding anything else — a truncated
// write, an unrelated file carrying the name, a dangling symlink — silently
// drop its whole subtree. Silent truncation is the one failure this walk does
// not allow, and here it would take a subtree out of the census denominator.
//
// A DIRECTORY named `.git` is the git dir. A FILE is a marker only when it
// opens with `gitdir: ` (above); the rest, trailing line ending trimmed, is the
// path. Symlinks are followed — git supports a symlinked `.git`, and a link's
// dirent is neither file nor directory, so its target decides.
//
// DELIBERATE DEVIATION (upstream's, kept): git additionally requires the TARGET
// to look like a repository (HEAD, objects/, refs/) and reports "not a git
// repository" when it does not. This walk stops at a well-formed marker
// whatever its target — a stale gitfile left by a pruned or moved worktree
// still sits on a full checkout, and walking it would duplicate the parent's
// sources, exactly what the boundary exists to prevent.
//
// The returned dir is the COMMON one where relevant: a linked worktree's git
// dir points at the shared common dir via its `commondir` file, and that is
// where git keeps `info/` for every worktree.
function gitDirOf(dir: string, entries: readonly Dirent[]): string | undefined {
  const marker = entries.find((e) => e.name === GIT_ENTRY)
  if (!marker) return undefined
  const path = join(dir, GIT_ENTRY)
  try {
    if (marker.isDirectory()) return path // a plain clone — decided on the dirent, no syscall
    const st = statSync(path) // a file, or a symlink resolved through its target
    if (st.isDirectory()) return path
    if (!st.isFile() || st.size > MAX_GITFILE_BYTES) return undefined
    const content = readFileSync(path, 'utf8')
    if (!content.startsWith(GITFILE_PREFIX)) return undefined // not a gitfile — not a marker
    // Only the line ending is stripped, never trailing spaces or tabs: git
    // trims exactly `\n` and `\r`, so a git directory whose name ENDS in a
    // space is reachable through a gitfile. Trimming whitespace here resolves
    // such a repo to the wrong directory, and its `info/exclude` is then never
    // found.
    const target = content.slice(GITFILE_PREFIX.length).replace(/[\r\n]+$/, '')
    if (!target) return undefined
    const gitDir = resolve(dir, target)
    const common = join(gitDir, 'commondir')
    return existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir
  } catch {
    return undefined
  }
}

// This checkout's `info/exclude` — git's per-clone, never-committed ignore file.
// The census reconciles against `git ls-files`, so an ignore file git honours
// and this walk did not is a path reported as present-but-unread for a reason
// that does not exist. Returns '' when absent or unreadable.
function readInfoExclude(gitDir: string | undefined): string {
  if (!gitDir) return ''
  try {
    const exclude = join(gitDir, 'info', 'exclude')
    return existsSync(exclude) ? readGitignore(exclude) : ''
  } catch {
    return ''
  }
}

// Lockfiles: huge, machine-generated, and pure noise.
export const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'composer.lock', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'go.sum',
  'flake.lock', 'packages.lock.json', 'podfile.lock', 'mix.lock',
])

// ULTRAI18N delta #1: `.svg` is NOT here. Upstream skips SVG because it holds no
// code symbols; it does hold <title>, <desc> and <text>, which are user-visible
// copy. Leaving it in BINARY_EXT means the walker never lists the file and no
// extractor ever gets the chance to look.
export const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns', '.pdf', '.zip',
  '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.class', '.so', '.dylib',
  '.dll', '.exe', '.bin', '.o', '.a', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3',
  '.mp4', '.mov', '.avi', '.webm', '.wav', '.flac', '.ogg', '.lock', '.min.js', '.map',
])

/**
 * The subset of skipped files that a human can nonetheless read text in.
 *
 * This distinction is the whole point of the `unscannable` census bucket. A
 * `.woff` carries no message for a user; a screenshot carries the entire UI.
 * Reporting both as "skipped: binary" tells the user nothing, and reporting
 * neither is how five translated-app-with-English-screenshots ship.
 */
export const TEXT_BEARING_BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.icns',
  '.pdf', '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.flac', '.ogg',
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.ods', '.odp',
  '.sqlite', '.sqlite3', '.db',
])

export type SkipReason =
  | 'binary-ext'
  | 'lockfile'
  | 'over-max-bytes'
  | 'gitignored'
  | 'minified'
  | 'symlink-outside-root'
  /**
   * A symlink whose target does not exist.
   *
   * ULTRAI18N delta: `statSync` FOLLOWS a link, so a dangling one throws and
   * the path used to be dropped by the catch before it reached any skip list.
   * If git tracks it — and git does track a broken symlink, storing the target
   * as a blob — the census then reported `unaccounted` and G1 failed with
   * nothing anybody could act on. A named reason is the difference between a
   * gate that reports a bug in the repository and one that reports a bug in
   * this walker.
   */
  | 'broken-symlink'
  | 'ignore-dir'
  /**
   * A subdirectory that is itself a repository — a linked worktree, a vendored
   * clone, a submodule.
   *
   * ULTRAI18N delta #2 applied to the boundary upstream added: upstream stops
   * at the boundary and bumps its anonymous `excluded` counter. A number cannot
   * be reconciled against `git ls-files`, and a submodule IS tracked (as a
   * gitlink at the directory's own path). Named here, and recorded in
   * `skippedDirs` rather than `skipped`, so the census can attribute both that
   * gitlink and anything tracked underneath it.
   */
  | 'nested-repo'

export interface Skipped {
  rel: string
  reason: SkipReason
  /** Set for `binary-ext` when the extension is one a human can read text in. */
  textBearing?: boolean
  size?: number
}

export interface WalkOptions {
  maxFileBytes?: number // skip files larger than this (default 1 MiB)
  maxFiles?: number // hard cap on walked files (default: none)
  gitignore?: boolean
  /**
   * Directory names to skip, REPLACING the default set entirely (never merging)
   * — except `.git`, which is skipped whatever the list says.
   */
  ignoreDirs?: string[]
  // ULTRAI18N delta #4 — census mode. Upstream drops these silently, which is
  // right for an index and wrong for an accountability report: the census must
  // be able to say "this path exists, here is why it was not read".
  includeLockfiles?: boolean
  includeBinary?: boolean
  includeOversize?: boolean
}

export interface WalkedFile {
  rel: string // path relative to root, posix-style
  abs: string
  size: number
  ext: string
  mtimeMs: number
}

export interface WalkResult {
  files: WalkedFile[]
  capped: boolean
  // ULTRAI18N delta #2: named paths with reasons, not an anonymous counter. The
  // census reconciles `git ls-files` against this, and a number cannot be
  // reconciled against anything.
  skipped: Skipped[]
  /**
   * Directories the walk refused to descend into, so the census can attribute a
   * tracked file underneath one (a repo may well track `dist/` or `vendor/`).
   * Without this, such a file is simply unaccounted for and G1 fails with no
   * explanation of why.
   */
  skippedDirs: Skipped[]
}

// Recursively list files under `root`, applying ignore rules. Pure filesystem
// walk — no git dependency, so it works on any directory.
export function walk(root: string, opts: WalkOptions = {}): WalkResult {
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024
  const maxFiles = opts.maxFiles ?? Infinity
  const useGitignore = opts.gitignore !== false
  const ignoreDirs = opts.ignoreDirs ? new Set(opts.ignoreDirs) : IGNORE_DIRS
  const out: WalkedFile[] = []
  const skipped: Skipped[] = []
  const skippedDirs: Skipped[] = []
  let capped = false

  // Containment root for the symlink-escape guard: a symlinked file or
  // directory whose real path leaves the repo must not be walked.
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return { files: out, capped, skipped, skippedDirs }
  }
  const contained = (real: string): boolean => real === rootReal || real.startsWith(rootReal + sep)

  const stack: { dir: string; rel: string; rules: readonly IgnoreRule[] }[] = [
    { dir: root, rel: '', rules: [] },
  ]
  const seenDirs = new Set<string>()
  walking: while (stack.length) {
    const frame = stack.pop()!
    // Cycle guard: a directory symlink pointing at an ancestor would otherwise
    // make walk() loop, flooding the result with phantom duplicates.
    let real: string
    try {
      real = realpathSync(frame.dir)
    } catch {
      continue
    }
    if (seenDirs.has(real)) continue
    seenDirs.add(real)
    if (!contained(real)) continue
    let entries: Dirent[]
    try {
      // Sorted so the walk order — and therefore which files survive a cap —
      // is identical across filesystems and machines.
      entries = readdirSync(frame.dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )
    } catch {
      continue
    }
    // Resolved at most once per directory, and only when a `.git` entry is
    // actually listed — so an ordinary directory costs one name comparison.
    const gitDir = entries.some((e) => e.name === GIT_ENTRY)
      ? gitDirOf(frame.dir, entries)
      : undefined
    // Nested-repository boundary: a subdirectory that IS another repo — a
    // linked worktree under .claude/worktrees/, a vendored clone, a submodule.
    // Its files belong to THAT repo, and walking them here produced thousands
    // of phantom duplicates of the same sources; git itself never lists them.
    // Structural: independent of the gitignore layer.
    if (frame.rel && gitDir) {
      skippedDirs.push({ rel: frame.rel, reason: 'nested-repo' })
      continue
    }
    let rules = frame.rules
    if (useGitignore && !frame.rel) {
      // `.git/info/exclude` sits BEFORE every .gitignore in git's own
      // precedence (a .gitignore rule can still negate it — later rules win).
      const parsed = parseGitignore(readInfoExclude(gitDir), '')
      if (parsed.length) rules = [...rules, ...parsed]
    }
    if (useGitignore && entries.some((e) => e.name === '.gitignore')) {
      const parsed = parseGitignore(readGitignore(join(frame.dir, '.gitignore')), frame.rel)
      if (parsed.length) rules = [...rules, ...parsed]
    }
    for (const entry of entries) {
      const name = entry.name
      const abs = join(frame.dir, name)
      const rel = frame.rel ? `${frame.rel}/${name}` : name
      const isLink = entry.isSymbolicLink()
      // The root's own `.git` entry, whatever its type: the directory is VCS
      // internals, the gitfile of a linked worktree or submodule is a one-line
      // pointer — neither is source, and git lists neither. Not recorded: no
      // tracked path ever sits under it, so there is nothing to attribute.
      if (name === GIT_ENTRY) continue
      if (entry.isDirectory() && isIgnoredDirectory(name, ignoreDirs)) {
        skippedDirs.push({ rel, reason: 'ignore-dir' })
        continue
      }
      let st
      try {
        st = isLink ? statSync(abs) : lstatSync(abs)
      } catch {
        // A dangling symlink: `statSync` follows, finds nothing, and throws.
        // It is named rather than dropped, because git tracks a broken symlink
        // like any other path and an unnamed one fails G1 as `unaccounted`
        // with no reason a reader can act on.
        //
        // The non-link branch stays a bare `continue`: that is a file deleted
        // between `readdir` and `lstat`, which genuinely is unaccountable, and
        // `unaccounted` is the honest report for it.
        if (isLink) skipped.push({ rel, reason: 'broken-symlink' })
        continue
      }
      if (st.isDirectory()) {
        if (isIgnoredDirectory(name, ignoreDirs)) {
          skippedDirs.push({ rel, reason: 'ignore-dir' })
          continue
        }
        // An in-repo DIRECTORY symlink is skipped entirely: its target is walked
        // under its canonical name, and letting both paths race through the
        // cycle guard would yield filesystem-order-dependent results.
        if (isLink) continue
        if (useGitignore && rules.length && isIgnored(rules, rel, true)) {
          skippedDirs.push({ rel, reason: 'gitignored' })
          continue
        }
        stack.push({ dir: abs, rel, rules })
        continue
      }
      if (!st.isFile()) continue

      const ext = extname(name).toLowerCase()
      const isBinaryExt = BINARY_EXT.has(ext)
      const isLockfile = LOCKFILES.has(name.toLowerCase())
      const isMinified = name.endsWith('.min.js') || name.endsWith('.min.css')
      const isOversize = st.size > maxFileBytes

      // Gitignore is checked first so a gitignored lockfile is reported as
      // gitignored — the reason a user can act on.
      if (useGitignore && rules.length && isIgnored(rules, rel, false)) {
        skipped.push({ rel, reason: 'gitignored', size: st.size })
        continue
      }
      if (isOversize && !opts.includeOversize) {
        skipped.push({ rel, reason: 'over-max-bytes', size: st.size })
        continue
      }
      if (isLockfile && !opts.includeLockfiles) {
        skipped.push({ rel, reason: 'lockfile', size: st.size })
        continue
      }
      if (isBinaryExt && !opts.includeBinary) {
        skipped.push({
          rel,
          reason: 'binary-ext',
          textBearing: TEXT_BEARING_BINARY_EXT.has(ext),
          size: st.size,
        })
        continue
      }
      if (isMinified) {
        skipped.push({ rel, reason: 'minified', size: st.size })
        continue
      }
      if (isLink) {
        try {
          if (!contained(realpathSync(abs))) {
            skipped.push({ rel, reason: 'symlink-outside-root' })
            continue
          }
        } catch {
          // The link resolved far enough for `statSync` to succeed but breaks
          // somewhere along the chain. Same class as the dangling case above,
          // and it gets the same name rather than a second silent drop.
          skipped.push({ rel, reason: 'broken-symlink' })
          continue
        }
      }
      if (out.length >= maxFiles) {
        capped = true
        break walking
      }
      out.push({ rel: rel.split(sep).join('/'), abs, size: st.size, ext, mtimeMs: st.mtimeMs })
    }
  }
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  skipped.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  skippedDirs.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { files: out, capped, skipped, skippedDirs }
}

// .gitignore and .git/info/exclude are always UTF-8 text; the full decoder is
// overkill here and would pull a cycle between walk.ts and text.ts. (Upstream
// calls its own readText, which lives in walk.ts there — ULTRAI18N delta #3
// lifted it out into text.ts, so this local reader stands in for it.)
function readGitignore(abs: string): string {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}

export { relative }
