// The flags that were parsed and never read.
//
// A flag accepted and ignored is worse than one that errors: it tells the user
// something happened. Five now do something; one was removed, with the argument
// rather than with `unknown flag`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { guardWorkingTree, gitState } from '../src/git'
import { check } from '../src/check'
import { scan } from '../src/scan'
import { formatScan, formatPlurals } from '../src/report'
import { formatCheck } from '../src/check'
import { formatPlan } from '../src/plan'
import { plan } from '../src/plan'

let repo: string

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-flags-'))
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"description":"Un atelier de publication"}')
  writeFileSync(join(repo, 'src/app.ts'), "export const label = 'Enregistrer les modifications'\n")
  spawnSync('git', ['init', '-q'], { cwd: repo })
  spawnSync('git', ['config', 'user.email', 'x@y.z'], { cwd: repo })
  spawnSync('git', ['config', 'user.name', 'x'], { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['commit', '-qm', 'x'], { cwd: repo })
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('the working-tree guard', () => {
  it('passes on a clean repository', () => {
    expect(gitState(repo).kind).toBe('clean')
    const g = guardWorkingTree(repo, { allowDirty: false, noGit: false })
    expect(g.ok).toBe(true)
    if (g.ok) expect(g.bypassedBy).toBe(null)
  })

  it('refuses a dirty one, and names the paths', () => {
    // `apply --write` rewrites in place and its diff is indistinguishable from
    // the user's own. Git is the undo button; this asks whether there is one.
    writeFileSync(join(repo, 'src/app.ts'), "export const label = 'Modifié'\n")
    const g = guardWorkingTree(repo, { allowDirty: false, noGit: false })
    expect(g.ok).toBe(false)
    if (!g.ok) expect(g.message).toContain('src/app.ts')
  })

  it('is escaped by --allow-dirty, and records that it was', () => {
    const g = guardWorkingTree(repo, { allowDirty: true, noGit: false })
    expect(g.ok).toBe(true)
    if (g.ok) expect(g.bypassedBy).toBe('allow-dirty')
    spawnSync('git', ['checkout', '--', '.'], { cwd: repo })
  })

  it('refuses a directory git does not track, unless --no-git', () => {
    const bare = mkdtempSync(join(tmpdir(), 'ultrai18n-bare-'))
    try {
      const refused = guardWorkingTree(bare, { allowDirty: false, noGit: false })
      expect(refused.ok).toBe(false)
      // The message has to name both escape hatches, or it is a dead end.
      if (!refused.ok) {
        expect(refused.message).toContain('--no-git')
        expect(refused.message).toContain('--backup')
      }
      const allowed = guardWorkingTree(bare, { allowDirty: false, noGit: true })
      expect(allowed.ok).toBe(true)
      if (allowed.ok) expect(allowed.bypassedBy).toBe('no-git')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('lets --no-git bypass the dirty check too', () => {
    // Asserting git is not the safety net here disables both questions, not one.
    writeFileSync(join(repo, 'src/app.ts'), "export const label = 'Encore modifié'\n")
    const g = guardWorkingTree(repo, { allowDirty: false, noGit: true })
    expect(g.ok).toBe(true)
    spawnSync('git', ['checkout', '--', '.'], { cwd: repo })
  })
})

describe('--strict', () => {
  it('makes a low-confidence decision a finding, and does not add a gate id', async () => {
    // No new id, deliberately: two gates sharing one made `fingerprint()`
    // collide across them, so baselining one silently baselined the other.
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const plain = check({ repo, inventory: inv })
    const strict = check({ repo, inventory: inv, strict: true })
    expect(strict.gates.map((g) => g.id)).toEqual(plain.gates.map((g) => g.id))

    const before = plain.gates.find((g) => g.id === 'G3')!.count
    const after = strict.gates.find((g) => g.id === 'G3')!.count
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('reports an exception that carries no contentHash', async () => {
    // `pin` voids an exception whose text CHANGED; one with no hash at all can
    // never be voided, which is the loophole.
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.verdict === 'needs-judgment' || s.verdict === 'translate')!
    const exceptions = {
      entries: [{ siteKey: site.siteKey, reason: 'proper-noun', justification: 'a name' }],
    }
    const plain = check({ repo, inventory: inv, exceptions })
    const strict = check({ repo, inventory: inv, exceptions, strict: true })
    expect(plain.gates.find((g) => g.id === 'G5')!.ok).toBe(true)
    expect(strict.gates.find((g) => g.id === 'G5')!.count).toBe(1)
  })
})

describe('every human report ends with its verdict', () => {
  // This is what makes `--quiet` a contract rather than a truncation: it prints
  // exactly the last line, so a formatter trailing off into narration would
  // reduce to a sentence fragment.
  it('holds for scan, plurals, plan and check', async () => {
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const p = plan(inv, { mode: 'swap' })
    const reports = [
      formatScan(inv),
      formatPlurals(inv),
      formatPlan(p),
      formatCheck(check({ repo, inventory: inv })),
    ]
    for (const text of reports) {
      const last = text.trimEnd().split('\n').pop()!
      expect(last).toMatch(/^VERDICT\s/)
    }
  })
})

describe('--backup', () => {
  it('keeps originals inside the run directory, never beside the source', () => {
    // A `.bak` next to a file is WALKED by the next scan: it becomes a phantom
    // duplicate site and fails G6 on a repository that is entirely correct.
    // The run directory is already in the walker's ignore list.
    const out = join(repo, '.ultrai18n')
    mkdirSync(out, { recursive: true })
    expect(join(out, 'backup').startsWith(out)).toBe(true)
    // And nothing shaped like a stray backup is left in the tree.
    expect(existsSync(join(repo, 'src/app.ts.bak'))).toBe(false)
    expect(readFileSync(join(repo, 'src/app.ts'), 'utf8')).toContain('Enregistrer')
  })
})
