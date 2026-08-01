// What git can tell us before `apply --write` rewrites files in place.
//
// The single-writer design means one command mutates the repository, and its
// diff is indistinguishable from a human's. Git is the undo button, so the
// guard asks whether there is one — and, when there is not, says so and stops
// rather than discovering it afterwards.
//
// Only `--write` is guarded. A dry run mutates nothing, and guarding it would
// be theatre.
import { spawnSync } from 'node:child_process'

export type GitState =
  | { kind: 'clean' }
  | { kind: 'dirty'; paths: string[] }
  | { kind: 'not-a-repo' }

export function gitState(repo: string): GitState {
  const out = spawnSync('git', ['status', '--porcelain'], {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (out.status !== 0) return { kind: 'not-a-repo' }
  const paths = out.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
  return paths.length ? { kind: 'dirty', paths } : { kind: 'clean' }
}

export interface GuardOptions {
  allowDirty: boolean
  noGit: boolean
}

export type GuardResult =
  | { ok: true; state: GitState['kind']; bypassedBy: 'allow-dirty' | 'no-git' | null }
  | { ok: false; state: GitState['kind']; message: string }

/**
 * Refuse to write in place where a bad run could not be undone.
 *
 * Exit 1 rather than 2 when this fails: it is not a usage error, it is a
 * command that could not run.
 */
export function guardWorkingTree(repo: string, opts: GuardOptions): GuardResult {
  const state = gitState(repo)

  if (opts.noGit) {
    // The user has asserted git is not the safety net here, so neither check
    // applies — including the dirty one.
    return { ok: true, state: state.kind, bypassedBy: 'no-git' }
  }

  if (state.kind === 'not-a-repo') {
    return {
      ok: false,
      state: state.kind,
      message:
        `${repo} is not a git repository, so a bad run cannot be undone. ` +
        'Pass --no-git to write anyway, or --backup to keep the originals.',
    }
  }

  if (state.kind === 'dirty') {
    if (opts.allowDirty) return { ok: true, state: state.kind, bypassedBy: 'allow-dirty' }
    const shown = state.paths.slice(0, 10)
    const more = state.paths.length - shown.length
    return {
      ok: false,
      state: state.kind,
      message:
        `${state.paths.length} path(s) have uncommitted changes, and \`apply --write\` rewrites files in ` +
        `place — its diff would be indistinguishable from yours:\n` +
        shown.map((p) => `    ${p}`).join('\n') +
        (more > 0 ? `\n    … and ${more} more` : '') +
        '\nCommit or stash first, or pass --allow-dirty.',
    }
  }

  return { ok: true, state: state.kind, bypassedBy: null }
}
