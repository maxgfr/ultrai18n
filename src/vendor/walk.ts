// Vendored from @maxgfr/codeindex v2.22.0 (MIT), with four marked divergences.
// See ./README.md.
import { readdirSync, statSync, lstatSync, readFileSync, realpathSync, type Dirent } from 'node:fs'
import { join, relative, sep, extname } from 'node:path'
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
  | 'ignore-dir'

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
  /** Directory names to skip, REPLACING the default set entirely (never merging). */
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
    let rules = frame.rules
    if (useGitignore && entries.some((e) => e.name === '.gitignore')) {
      const parsed = parseGitignore(readGitignore(join(frame.dir, '.gitignore')), frame.rel)
      if (parsed.length) rules = [...rules, ...parsed]
    }
    for (const entry of entries) {
      const name = entry.name
      const abs = join(frame.dir, name)
      const rel = frame.rel ? `${frame.rel}/${name}` : name
      const isLink = entry.isSymbolicLink()
      if (entry.isDirectory() && ignoreDirs.has(name)) {
        skippedDirs.push({ rel, reason: 'ignore-dir' })
        continue
      }
      let st
      try {
        st = isLink ? statSync(abs) : lstatSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (ignoreDirs.has(name)) {
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

// .gitignore files are always UTF-8 text; the full decoder is overkill here and
// would pull a cycle between walk.ts and text.ts.
function readGitignore(abs: string): string {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}

export { relative }
