// A fixture, copied out of this repository and given a git history of its own.
//
// Every eval needs this, and for two separate reasons that happen to have one
// remedy.
//
// The first is the census. Its denominator is `git ls-files` on purpose — the
// walker's own exclusions are the thing being audited, and asking the walker
// which files exist and then asking it whether it read them is a tautology. But
// `git ls-files` run inside `evals/fixture` answers for THIS repository, listing
// the fixture's paths as this repo tracks them. A fixture scanned in place is
// therefore measured against the outer repo's git state: its `.gitignore`, its
// staged deletions, its untracked files. That is a denominator nobody chose.
//
// The second is `.ultrai18n/`. The walker skips that directory, so a stale run
// artifact left inside a fixture is invisible to the census — and yet `scan`
// reads `.ultrai18n/plurals.json` as the plural sidecar, and `check` reads
// `exceptions.json` and `baseline.json` from the same place. A local run leaves
// state that silently changes what a later eval measures, and it leaves it
// somewhere gitignored, so nobody sees it in a diff.
//
// Copying to a tmpdir and committing there fixes both: the denominator is the
// fixture and nothing else, and the copy starts from what is tracked.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Copy a fixture to a fresh tmpdir and commit it.
 *
 * `label` only names the temp directory, so a leftover directory says which
 * eval abandoned it.
 */
export function isolatedRepo(fixture: string, label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `ultrai18n-${label}-`))
  cpSync(fixture, repo, { recursive: true })

  // `.ultrai18n/` is gitignored in this repository, so `cpSync` may still have
  // carried a local run's artifacts across. Drop them: an eval must measure the
  // fixture, never whatever was last run against it by hand.
  rmSync(join(repo, '.ultrai18n'), { recursive: true, force: true })

  git(repo, 'init', '-q')
  commitAll(repo)
  return repo
}

/**
 * A committed git repository with nothing in it.
 *
 * For the evals that plant one hostile file and scan it, rather than copying a
 * fixture. The initial commit is empty on purpose: `gitLsFiles` treats an empty
 * result as "not a git repository" and falls back to the filesystem, so a file
 * written after this call still has to be `git add`ed to enter the denominator.
 */
export function emptyRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `ultrai18n-${label}-`))
  git(repo, 'init', '-q')
  return repo
}

/** Stage and commit whatever is on disk. Pairs with `emptyRepo`. */
export function commitAll(repo: string): void {
  git(repo, 'add', '-A')
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i')
}

/** Idempotent, so an `afterAll` never fails a green run on a missing directory. */
export function removeRepo(repo: string): void {
  rmSync(repo, { recursive: true, force: true })
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd })
  // A silent git failure here produces a fixture with no history, which makes
  // the census fall back to the filesystem denominator and quietly WEAKEN the
  // recall claim the eval is about to assert. Fail loudly instead.
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr?.toString() ?? ''}`)
  }
}
