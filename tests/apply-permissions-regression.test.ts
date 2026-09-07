// A translated file must still be the same file.
//
// `apply` writes a temporary file and renames it over the original, which is
// what makes a write atomic — and what silently discards the original's mode.
// A tracked `task.sh` at 0755 came back 0644 and stopped being runnable: exit
// 126, from a repository whose only reported change was a comment in English.
// The inverse is worse and quieter. A 0600 file re-created under a typical
// umask lands at 0644, so the fix for a broken build is a secret readable by
// everyone on the box, and nothing in the report says so.
//
// POSIX bits only. Ownership, ACLs and extended attributes are out of scope
// here and this file claims nothing about them.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'

// Windows has no POSIX permission bits: `chmod` there moves the read-only flag
// and nothing else, so these assertions would be testing the host, not us.
const posix = process.platform !== 'win32'

let repo: string
let backupDir: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-perm-'))
  backupDir = mkdtempSync(join(tmpdir(), 'ultrai18n-perm-bak-'))
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

const modeOf = (path: string): number => statSync(path).mode & 0o7777
const octal = (mode: number): string => '0' + mode.toString(8).padStart(4, '0')

/** Scan, translate the one site matching `match`, and write it. */
async function translateAndWrite(
  rel: string,
  match: (value: string) => boolean,
  to: string,
  opts: { backup?: boolean } = {},
): Promise<ReturnType<typeof apply>> {
  const inv = await scan({ repo, from: 'fr', to: 'en' })
  const site = inv.sites.find((s) => s.file === rel && match(s.value))
  if (!site) {
    const seen = inv.sites.filter((s) => s.file === rel).map((s) => JSON.stringify(s.value)).join(', ')
    throw new Error(`no site in ${rel} matching; saw ${seen}`)
  }
  return apply({
    repo,
    inventory: inv,
    translations: [{ id: site.id, text: to }],
    write: true,
    ...(opts.backup ? { backupDir } : {}),
  })
}

describe.skipIf(!posix)('POSIX permission bits survive an apply', () => {
  it('keeps an executable script executable, and runnable', async () => {
    // The reported regression, end to end: 0755 in, 0755 out, still runs.
    const rel = 'task.sh'
    const abs = join(repo, rel)
    writeFileSync(abs, '#!/bin/sh\n# Lance la tâche de nuit\necho ok\n')
    chmodSync(abs, 0o755)

    const report = await translateAndWrite(rel, (v) => v.includes('tâche'), 'Run the nightly task')

    expect(report.files.written).toBe(1)
    expect(readFileSync(abs, 'utf8')).toContain('# Run the nightly task')
    expect(octal(modeOf(abs))).toBe(octal(0o755))

    // 126 is "found it, cannot execute it" — the shape of the original bug.
    const run = spawnSync(abs, [], { encoding: 'utf8' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('ok\n')
  })

  it('keeps a private file private, and its backup with it', async () => {
    // A 0600 file re-created under umask 022 is world-readable. So is the
    // backup, which is the copy nobody remembers to go back and delete.
    const rel = 'secrets.yml'
    const abs = join(repo, rel)
    writeFileSync(abs, '# Jeton de production\ntoken: abc\n')
    chmodSync(abs, 0o600)

    const report = await translateAndWrite(rel, (v) => v.includes('Jeton'), 'Production token', { backup: true })

    expect(report.backups).toHaveLength(1)
    expect(readFileSync(abs, 'utf8')).toContain('# Production token')
    expect(octal(modeOf(abs))).toBe(octal(0o600))
    expect(octal(modeOf(report.backups[0]!))).toBe(octal(0o600))
  })

  it('restores bits a restrictive umask would have taken', async () => {
    // Passing the mode to `writeFileSync` is not enough: it is masked by the
    // umask, so under 077 a 0644 source comes back 0600 and the file the rest
    // of the team could read yesterday is unreadable today. The intended bits
    // have to be put back explicitly.
    const rel = 'notes.md'
    const abs = join(repo, rel)
    const previous = process.umask(0o077)
    try {
      writeFileSync(abs, '# Titre\n\nBonjour tout le monde.\n')
      chmodSync(abs, 0o644)

      const report = await translateAndWrite(rel, (v) => v.includes('Bonjour'), 'Hello everyone.', { backup: true })

      expect(readFileSync(abs, 'utf8')).toContain('Hello everyone.')
      expect(octal(modeOf(abs))).toBe(octal(0o644))
      expect(octal(modeOf(report.backups[0]!))).toBe(octal(0o644))
    } finally {
      process.umask(previous)
    }
  })

  it('never leaves a stray temp file behind at any mode', async () => {
    // The temp file carries the original's bits from the moment it exists, so
    // there is no window in which the patched content is more permissive than
    // the file it replaces. All that can be asserted after the fact is that
    // nothing survived the rename.
    const rel = 'task.sh'
    const abs = join(repo, rel)
    writeFileSync(abs, '#!/bin/sh\n# Lance la tâche de nuit\necho ok\n')
    chmodSync(abs, 0o700)

    await translateAndWrite(rel, (v) => v.includes('tâche'), 'Run the nightly task')

    const { readdirSync } = await import('node:fs')
    expect(readdirSync(repo).filter((f) => f.startsWith('.ultrai18n-'))).toEqual([])
    expect(octal(modeOf(abs))).toBe(octal(0o700))
  })
})
