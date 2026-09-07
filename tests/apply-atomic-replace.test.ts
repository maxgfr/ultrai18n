// A write that fails must leave everything it did not finish alone.
//
// Preserving the original's mode is not licence to delete the destination
// first. `rm` then `write` turns every failure between the two into a loss:
// the backup of an earlier run — the copy the operator would reach for — is
// gone before the replacement that was meant to supersede it exists, and the
// run reports a disk error over a directory it has already emptied.
//
// The same unlink is a second hazard for the temporary file. A name that is
// already taken belongs to another writer; removing it to make room destroys
// somebody else's in-flight write.
//
// So the contract under test is narrow and absolute. Create the temp
// exclusively, set its mode through the descriptor, and rename only once the
// bytes are down. Every failure before the rename leaves the destination
// exactly as it was found.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, rmSync, existsSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'

// Windows has no POSIX permission bits, and no umask to restore them from.
const posix = process.platform !== 'win32'

/** What the mocked syscalls should do on the next run. */
const control = vi.hoisted(() => ({
  /** Fail the first call of this kind, then get out of the way. */
  failAt: null as null | 'write' | 'fchmod' | 'rename',
  /** Let the first exclusive create lose the race, as a real one can. */
  collideOnce: false,
  /** Where that lost race left somebody else's file. */
  collidedAt: null as string | null,
}))

/** The bytes the imaginary other writer put there. */
const FOREIGN = 'not ours\n'

// Wrapping the module rather than the process: these are the four calls the
// replacement is built out of, and each one has to be survivable.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const fail = (where: string): void => {
    if (control.failAt !== where) return
    // One injected failure per run, so the cleanup path can still use the disk.
    control.failAt = null
    throw Object.assign(new Error(`simulated ${where} failure`), { code: 'EIO' })
  }
  type Fn = (...args: never[]) => unknown
  const mod = {
    ...actual,
    writeFileSync: vi.fn((...args: never[]) => {
      fail('write')
      return (actual.writeFileSync as Fn)(...args)
    }),
    writeSync: vi.fn((...args: never[]) => {
      fail('write')
      return (actual.writeSync as Fn)(...args)
    }),
    fchmodSync: vi.fn((...args: never[]) => {
      fail('fchmod')
      return (actual.fchmodSync as Fn)(...args)
    }),
    chmodSync: vi.fn((...args: never[]) => {
      fail('fchmod')
      return (actual.chmodSync as Fn)(...args)
    }),
    renameSync: vi.fn((...args: never[]) => {
      fail('rename')
      return (actual.renameSync as Fn)(...args)
    }),
    openSync: vi.fn((path: never, ...rest: never[]) => {
      if (control.collideOnce) {
        control.collideOnce = false
        control.collidedAt = String(path)
        // Exactly what losing the race looks like: the name is taken, and the
        // file behind it is not ours.
        actual.writeFileSync(String(path), FOREIGN)
        throw Object.assign(new Error(`EEXIST: file already exists, open '${String(path)}'`), { code: 'EEXIST' })
      }
      return (actual.openSync as Fn)(path, ...rest)
    }),
  }
  return { ...mod, default: mod }
})

let repo: string
let backupDir: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-atomic-'))
  backupDir = mkdtempSync(join(tmpdir(), 'ultrai18n-atomic-bak-'))
})
afterEach(() => {
  control.failAt = null
  control.collideOnce = false
  control.collidedAt = null
  vi.clearAllMocks()
  rmSync(repo, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

const modeOf = (path: string): number => statSync(path).mode & 0o7777
const octal = (mode: number): string => '0' + mode.toString(8).padStart(4, '0')
const temps = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith('.ultrai18n-'))

const REL = 'secrets.yml'
const FIRST = '# Jeton de production\ntoken: abc\n'
const SECOND = '# Message de secours\ntoken: xyz\n'

/** Scan, find the one site matching, and hand back the write as a thunk. */
async function planApply(match: (value: string) => boolean, to: string): Promise<() => ReturnType<typeof apply>> {
  const inv = await scan({ repo, from: 'fr', to: 'en' })
  const site = inv.sites.find((s) => s.file === REL && match(s.value))
  if (!site) {
    const seen = inv.sites.filter((s) => s.file === REL).map((s) => JSON.stringify(s.value)).join(', ')
    throw new Error(`no site in ${REL} matching; saw ${seen}`)
  }
  return () =>
    apply({ repo, inventory: inv, translations: [{ id: site.id, text: to }], write: true, backupDir })
}

/**
 * A backup from an earlier run, and a source that has moved on since.
 *
 * The two differ so that "the backup survived" cannot be satisfied by having
 * quietly replaced it with an identical copy.
 */
async function backupFromAnEarlierRun(mode = 0o644): Promise<{ abs: string; backup: string }> {
  const abs = join(repo, REL)
  writeFileSync(abs, FIRST)
  chmodSync(abs, mode)
  ;(await planApply((v) => v.includes('Jeton'), 'Production token'))()

  writeFileSync(abs, SECOND)
  chmodSync(abs, mode)
  return { abs, backup: join(backupDir, REL) }
}

describe.skipIf(!posix)('a failed replacement destroys nothing', () => {
  it('restores exact permissions after writing bytes, before each rename', async () => {
    const abs = join(repo, REL)
    writeFileSync(abs, FIRST)
    chmodSync(abs, 0o755)
    const run = await planApply((v) => v.includes('Jeton'), 'Production token')
    vi.clearAllMocks()
    run()
    const writes = vi.mocked(fs.writeFileSync).mock.invocationCallOrder
    const modes = vi.mocked(fs.fchmodSync).mock.invocationCallOrder
    const renames = vi.mocked(fs.renameSync).mock.invocationCallOrder
    expect(modes).toHaveLength(2)
    for (let i = 0; i < modes.length; i++) {
      expect(writes[i]).toBeLessThan(modes[i]!)
      expect(modes[i]).toBeLessThan(renames[i]!)
    }
  })

  it('preserves special POSIX bits on filesystems that support them', async (ctx) => {
    const abs = join(repo, REL)
    writeFileSync(abs, FIRST)
    const mode = 0o6755
    chmodSync(abs, mode)
    if (modeOf(abs) !== mode) return ctx.skip()
    const report = (await planApply((v) => v.includes('Jeton'), 'Production token'))()
    expect(modeOf(abs)).toBe(mode)
    expect(modeOf(report.backups[0]!)).toBe(mode)
  })

  for (const where of ['write', 'fchmod', 'rename'] as const) {
    it(`keeps an earlier backup and the source when the ${where} fails`, async () => {
      const { abs, backup } = await backupFromAnEarlierRun()
      expect(readFileSync(backup, 'utf8')).toBe(FIRST)

      const run = await planApply((v) => v.includes('secours'), 'Fallback message')
      control.failAt = where

      expect(run).toThrow(/simulated/)

      // The backup that was already there is the whole point: it is either the
      // old one or the new one, never absent and never half-written.
      expect(existsSync(backup)).toBe(true)
      expect(readFileSync(backup, 'utf8')).toBe(FIRST)
      expect(octal(modeOf(backup))).toBe(octal(0o644))
      expect(readdirSync(backupDir)).toEqual([REL])

      // And the source is untouched, since the backup never completed.
      expect(readFileSync(abs, 'utf8')).toBe(SECOND)
      expect(octal(modeOf(abs))).toBe(octal(0o644))

      expect(temps(repo)).toEqual([])
      expect(temps(backupDir)).toEqual([])
    })
  }

  it('leaves a temp name that is already taken to whoever took it', async () => {
    // The old scheme derived the name from the pid, so a second run of the
    // tool in the same process — or anything that had guessed the pattern —
    // shared it. A name is not a claim; the exclusive create is.
    const abs = join(repo, REL)
    writeFileSync(abs, FIRST)
    chmodSync(abs, 0o644)
    const squatted = join(repo, `.ultrai18n-${process.pid}-0.tmp`)
    writeFileSync(squatted, FOREIGN)

    const report = (await planApply((v) => v.includes('Jeton'), 'Production token'))()

    expect(report.files.written).toBe(1)
    expect(readFileSync(abs, 'utf8')).toContain('# Production token')
    expect(existsSync(squatted)).toBe(true)
    expect(readFileSync(squatted, 'utf8')).toBe(FOREIGN)
  })

  it('steps around a temp whose name lost the race, without touching it', async () => {
    const abs = join(repo, REL)
    writeFileSync(abs, FIRST)
    chmodSync(abs, 0o644)

    control.collideOnce = true
    const report = (await planApply((v) => v.includes('Jeton'), 'Production token'))()

    // The create failed on a name somebody else owned, so the write moved to a
    // fresh one and finished.
    expect(control.collideOnce).toBe(false)
    expect(control.collidedAt).toBeTruthy()
    expect(report.files.written).toBe(1)
    expect(readFileSync(abs, 'utf8')).toContain('# Production token')

    // The file behind the taken name is exactly as its owner left it.
    expect(existsSync(control.collidedAt!)).toBe(true)
    expect(readFileSync(control.collidedAt!, 'utf8')).toBe(FOREIGN)
  })

  it('never creates the temp with bits the original does not grant', async () => {
    // A 0400 original must not pass through a writable, readable-by-more
    // intermediate on its way to being replaced. The descriptor gets the final
    // mode; the creation mode is only ever a subset of it.
    const abs = join(repo, REL)
    writeFileSync(abs, FIRST)
    chmodSync(abs, 0o400)

    const report = (await planApply((v) => v.includes('Jeton'), 'Production token'))()

    const creations = vi
      .mocked(fs.openSync)
      .mock.calls.filter(([, flags]) => String(flags).includes('w'))
    expect(creations.length).toBeGreaterThan(0)
    for (const [, , mode] of creations) {
      expect(typeof mode).toBe('number')
      expect((mode as number) & ~0o400).toBe(0)
    }

    expect(report.backups).toHaveLength(1)
    expect(octal(modeOf(abs))).toBe(octal(0o400))
    expect(octal(modeOf(report.backups[0]!))).toBe(octal(0o400))
    expect(readFileSync(abs, 'utf8')).toContain('# Production token')
  })
})
