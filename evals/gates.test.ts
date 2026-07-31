import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scan } from '../src/scan'
import { check, type CheckReport } from '../src/check'
import { plan } from '../src/plan'
import { buildBatches, foldResults } from '../src/translate'
import { validate } from '../src/validate'
import { humanLookingRuns, merge, complement } from '../src/sweep'
import type { Inventory } from '../src/types'

const FIXTURE = join(import.meta.dirname, 'fixture')
let repo: string
let inv: Inventory
let report: CheckReport

beforeAll(async () => {
  // A git repo, because the census denominator is `git ls-files` on purpose:
  // the walker's own exclusions are the thing being audited.
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-gates-'))
  cpSync(FIXTURE, repo, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: repo })
  inv = await scan({ repo, from: 'fr', to: 'en' })
  report = check({ repo, inventory: inv })
}, 60_000)

const gate = (id: string) => report.gates.find((g) => g.id === id)!

describe('the gates', () => {
  it('accounts for every tracked path (G1)', () => {
    expect(gate('G1').ok).toBe(true)
  })

  it('fails while text is still in the source language (G4)', () => {
    const g = gate('G4')
    expect(g.ok).toBe(false)
    expect(g.findings.some((f) => f.file === 'package.json')).toBe(true)
  })

  it('reports the locale marker that still names the source language (G6)', () => {
    // The build declares French while its text is English. Neither site is
    // individually wrong; the repository is.
    const drift = gate('G6').findings.find((f) => f.kind === 'locale-drift')
    expect(drift?.file).toBe('vite.config.ts')
    expect(drift?.message).toContain('"fr"')
  })

  it('holds every gate open rather than stopping at the first failure', () => {
    // Fixing one failure should not mean discovering the next one run later.
    expect(report.gates).toHaveLength(6)
    expect(report.gates.every((g) => typeof g.count === 'number')).toBe(true)
  })

  it('exits non-zero when any gate fails', () => {
    expect(report.ok).toBe(false)
    expect(report.exitCode).toBe(1)
  })

  it('accepts an exception only with a closed-vocabulary reason and a justification (G5)', () => {
    const site = inv.sites.find((s) => s.verdict === 'translate')!
    const bad = check({
      repo,
      inventory: inv,
      exceptions: { entries: [{ siteKey: site.siteKey, reason: 'because I said so', justification: '' }] },
    })
    const g5 = bad.gates.find((g) => g.id === 'G5')!
    expect(g5.ok).toBe(false)
    expect(g5.findings.map((f) => f.message).join(' ')).toContain('closed vocabulary')
    expect(g5.findings.map((f) => f.message).join(' ')).toContain('justification')
  })

  it('voids a pinned exception once the text it pinned has changed', () => {
    // An exception must never be able to launder a later edit.
    const site = inv.sites.find((s) => s.verdict === 'translate')!
    const stale = check({
      repo,
      inventory: inv,
      exceptions: {
        entries: [
          { siteKey: site.siteKey, reason: 'proper-noun', justification: 'product name', pin: true, contentHash: 'deadbeef' },
        ],
      },
    })
    expect(stale.gates.find((g) => g.id === 'G5')!.findings[0]!.message).toContain('pinned text changed')
  })

  it('excuses a site once a valid exception covers it', () => {
    const offender = gate('G4').findings[0]!
    const excused = check({
      repo,
      inventory: inv,
      exceptions: {
        entries: [{ siteKey: offender.siteKey!, reason: 'genuinely-source-language', justification: 'a quotation' }],
      },
    })
    expect(excused.gates.find((g) => g.id === 'G4')!.count).toBe(gate('G4').count - 1)
  })

  it('reports only new findings against a frozen baseline', () => {
    // The standing-guard mode: today's state is accepted, tomorrow's regression
    // is not.
    const all = check({ repo, inventory: inv })
    const baseline = new Set(
      all.gates.flatMap((g) =>
        g.findings.map((f) => `${g.id}\0${f.siteKey ?? ''}\0${f.file ?? ''}\0${f.kind ?? ''}\0${f.message}`),
      ),
    )
    const clean = check({ repo, inventory: inv, baseline })
    expect(clean.ok).toBe(true)
  })
})

describe('the residual sweep', () => {
  it('forces human-looking text from an unhandled format into the inventory', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'ultrai18n-sweep-'))
    try {
      spawnSync('git', ['init', '-q'], { cwd: scratch })
      // An extension no extractor handles. Silently skipping it is the exact
      // failure this tool exists to prevent.
      writeFileSync(join(scratch, 'notes.rando'), 'Ceci est une phrase en français.\n')
      spawnSync('git', ['add', '-A'], { cwd: scratch })
      spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: scratch })
      const swept = await scan({ repo: scratch, from: 'fr', to: 'en' })
      const site = swept.sites.find((s) => s.file === 'notes.rando')
      expect(site?.verdict).toBe('unclassified')
      expect(site?.whyUnclaimed).toContain('no extractor')

      // And an unclassified site fails the gate until somebody looks at it.
      const r = check({ repo: scratch, inventory: swept })
      expect(r.gates.find((g) => g.id === 'G2')!.ok).toBe(false)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not mistake identifiers for prose', () => {
    const identifiers = new Set(['useState', 'formatRemaining', 'btn-primary'])
    const runs = humanLookingRuns('useState formatRemaining btn-primary a1b2c3d4e5f6 1.2.3', identifiers)
    expect(runs).toEqual([])
  })

  it('recognises a real sentence', () => {
    expect(humanLookingRuns('Ceci est une phrase.', new Set()).map((r) => r.text)).toEqual([
      'Ceci est une phrase.',
    ])
  })

  it('computes the complement of what extractors claimed', () => {
    expect(merge([{ start: 0, end: 5 }, { start: 3, end: 8 }, { start: 20, end: 25 }])).toEqual([
      { start: 0, end: 8 },
      { start: 20, end: 25 },
    ])
    expect(complement([{ start: 0, end: 8 }, { start: 20, end: 25 }], 30)).toEqual([
      { start: 8, end: 20 },
      { start: 25, end: 30 },
    ])
  })
})

describe('planning and validation', () => {
  it('makes the group the unit, so the same text cannot diverge', () => {
    const p = plan(inv)
    const shared = p.groups.find((g) => g.sites.length > 1)
    expect(shared).toBeDefined()
    // One group, one translation, every site — divergence is not representable.
    expect(shared!.sites.length).toBeGreaterThan(1)
  })

  it('refuses to plan a text that is also an identifier', () => {
    const p = plan(inv)
    expect(p.hazards.length).toBeGreaterThan(0)
    expect(p.hazards[0]!.blocked).toContain('identifier')
  })

  it('rejects a translation that drops a placeholder', () => {
    const group = { text: 'Move {0} up', max: null, role: 'label', holes: [0] } as never
    const v = validate(group, 'Monter')
    expect(v.some((x) => x.validator === 'V1' && x.severity === 'reject')).toBe(true)
  })

  it('accepts a translation that reorders a placeholder', () => {
    const group = { text: '{0} of {1} sessions', max: null, role: 'label', holes: [0, 1] } as never
    expect(validate(group, 'sessions {1} sur {0}').filter((v) => v.severity === 'reject')).toEqual([])
  })

  it('rejects an invented or duplicated placeholder', () => {
    const group = { text: 'Move {0} up', max: null, role: 'label', holes: [0] } as never
    expect(validate(group, 'Monter {0} {1}').some((v) => v.message.includes('invented'))).toBe(true)
    expect(validate(group, 'Monter {0} {0}').some((v) => v.message.includes('appears 2'))).toBe(true)
  })

  it('warns but does not reject when a translation equals its source', () => {
    // "Notifications" is the French for "Notifications". A validator that
    // rejects every cognate is one users learn to ignore.
    const group = { text: 'Notifications', max: null, role: 'label', holes: [] } as never
    expect(validate(group, 'Notifications')).toEqual([])
    const other = { text: 'Short break', max: null, role: 'label', holes: [] } as never
    const v = validate(other, 'Short break')
    expect(v).toHaveLength(1)
    expect(v[0]!.severity).toBe('warn')
  })

  it('rejects host syntax leaking out of the model', () => {
    const group = { text: 'Hello', max: null, role: 'label', holes: [] } as never
    expect(validate(group, 'Bonjour ${x}').some((v) => v.validator === 'V3')).toBe(true)
  })

  it('rejects a result computed against a stale batch', () => {
    const p = plan(inv)
    const batches = buildBatches(p.groups, {
      sourceLang: 'fr',
      targetLang: 'en',
      project: { name: 'fixture' },
    })
    expect(() =>
      foldResults([{ batchId: batches[0]!.batchId, batchDigest: 'not-the-digest', items: [] }], {
        groups: p.groups,
        batches,
      }),
    ).toThrow(/different batch/)
  })

  it('reports ids the model invented and ids it omitted', () => {
    const p = plan(inv)
    const batches = buildBatches(p.groups, {
      sourceLang: 'fr',
      targetLang: 'en',
      project: { name: 'fixture' },
    })
    const folded = foldResults([{ batchId: batches[0]!.batchId, items: [{ id: 'g_nonexistent', text: 'x' }] }], {
      groups: p.groups,
      batches: [batches[0]!],
    })
    expect(folded.unknown).toEqual(['g_nonexistent'])
    expect(folded.missing.length).toBe(batches[0]!.items.length)
  })
})
