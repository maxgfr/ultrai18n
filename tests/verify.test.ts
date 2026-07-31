import { describe, it, expect } from 'vitest'
import { applyVerdicts, checkSemantic, VALID_VERDICTS, type VerifyTodo } from '../src/verify'
import { buildBaseline, loadBaseline } from '../src/init'
import type { CheckReport } from '../src/check'
import type { Inventory } from '../src/types'

const todo: VerifyTodo = {
  schemaVersion: 1,
  repo: '/repo',
  pair: 'fr→en',
  pairs: [
    {
      claimId: 'g_1', claim: 'c1', src: 'Bonjour', tgt: 'Hello', role: 'label',
      citation: 'a.ts:1', path: 'a.ts', digest: 'abc123', because: 'sampled',
      verdict: null, note: '',
    },
    {
      claimId: 'g_2', claim: 'c2', src: 'Monde', tgt: 'World', role: 'label',
      citation: 'a.ts:2', path: 'a.ts', digest: 'def456', because: 'has a placeholder',
      verdict: null, note: '',
    },
  ],
  notReviewed: { groups: 0, reason: 'none' },
}

describe('the verdict vocabulary', () => {
  it('is exactly four tokens', () => {
    // A fifth would make the fold unshareable with the rest of this family.
    expect(VALID_VERDICTS).toEqual(['supported', 'partial', 'refuted', 'unsupported'])
  })

  it('hard-errors on anything outside it, rather than coercing', () => {
    // A verdict quietly reinterpreted is a review that did not happen.
    expect(() => applyVerdicts({ todo, verdicts: [{ claimId: 'g_1', verdict: 'ok' }] })).toThrow(
      /use exactly one of/,
    )
  })

  it('hard-errors on a claim that is not in the worklist', () => {
    expect(() => applyVerdicts({ todo, verdicts: [{ claimId: 'g_99', verdict: 'supported' }] })).toThrow(
      /no such claim/,
    )
  })

  it('counts partial as support', () => {
    // It says the meaning survived and the phrasing could be better, which is
    // not a reason to block a run.
    const r = applyVerdicts({
      todo,
      verdicts: [
        { claimId: 'g_1', verdict: 'partial' },
        { claimId: 'g_2', verdict: 'supported' },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.counts.partial).toBe(1)
  })

  it('fails on refuted', () => {
    const r = applyVerdicts({
      todo,
      verdicts: [
        { claimId: 'g_1', verdict: 'refuted', note: 'inverted meaning' },
        { claimId: 'g_2', verdict: 'supported' },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toMatchObject({ claimId: 'g_1', note: 'inverted meaning' })
  })

  it('reports pairs nobody adjudicated', () => {
    const r = applyVerdicts({ todo, verdicts: [{ claimId: 'g_1', verdict: 'supported' }] })
    expect(r.counts.unadjudicated).toBe(1)
  })
})

const inv = (): Inventory => ({
  schemaVersion: 1,
  repo: '/repo',
  sourceLanguage: 'fr',
  targetLanguage: 'en',
  sites: [],
  census: [],
  advisories: [],
  limits: [],
  recallClaim: 'full',
})

describe('check --semantic fails closed', () => {
  it('refuses to pass with no review at all', () => {
    // A missing review is not an absent problem.
    expect(checkSemantic({ repo: '/repo', inventory: inv(), todo: null, result: null }).ok).toBe(false)
  })

  it('recomputes the outcome from the raw verdicts, ignoring a disagreeing summary', () => {
    const forged = {
      schemaVersion: 1 as const,
      ok: true,
      counts: { supported: 2, partial: 0, refuted: 0, unsupported: 0, unadjudicated: 0 },
      failures: [],
      verdicts: [{ ...todo.pairs[0]!, verdict: 'refuted' as const, note: 'wrong' }],
    }
    const r = checkSemantic({ repo: '/repo', inventory: inv(), todo, result: forged })
    expect(r.ok).toBe(false)
    expect(r.findings.join(' ')).toContain('recomputing from the verdicts')
  })

  it('refuses a review whose pairs match nothing in this repository', () => {
    // A stale or foreign review must not read as this run's.
    const foreign = {
      schemaVersion: 1 as const,
      ok: true,
      counts: { supported: 1, partial: 0, refuted: 0, unsupported: 0, unadjudicated: 0 },
      failures: [],
      verdicts: [{ ...todo.pairs[0]!, verdict: 'supported' as const }],
    }
    const r = checkSemantic({ repo: '/repo', inventory: inv(), todo, result: foreign })
    expect(r.ok).toBe(false)
    expect(r.findings.join(' ')).toMatch(/not in the current inventory|not actually verified/)
  })
})

describe('baseline', () => {
  const report = (): CheckReport => ({
    repo: '/repo',
    from: 'fr',
    to: 'en',
    ok: false,
    gates: [
      {
        id: 'G4',
        name: 'source-language-clear',
        ok: false,
        count: 2,
        findings: [
          { file: 'a.ts', line: 1, siteKey: 'a.ts#x', message: 'still fr' },
          { file: 'b.ts', line: 2, siteKey: 'b.ts#y', message: 'still fr' },
        ],
      },
    ],
    summary: {},
    exitCode: 1,
  })

  it('freezes today so only tomorrow blocks', () => {
    // Failing on every pre-existing finding would mean failing on day one for
    // reasons nobody intends to fix.
    const frozen = loadBaseline(buildBaseline(report()))
    expect(frozen.size).toBe(2)
  })

  it('is stable, so an unchanged repository produces an unchanged baseline', () => {
    expect(buildBaseline(report()).accepted).toEqual(buildBaseline(report()).accepted)
  })

  it('does not swallow a NEW finding', () => {
    const frozen = loadBaseline(buildBaseline(report()))
    const withNew = report()
    withNew.gates[0]!.findings.push({ file: 'c.ts', line: 3, siteKey: 'c.ts#z', message: 'still fr' })
    const survives = withNew.gates[0]!.findings.filter(
      (f) => !frozen.has(`G4\0${f.siteKey ?? ''}\0${f.file ?? ''}\0${f.kind ?? ''}\0${f.message}`),
    )
    expect(survives.map((f) => f.file)).toEqual(['c.ts'])
  })
})

describe('path segments', () => {
  it('finds a filename written in the source language', async () => {
    // The reference repository renamed reglages.png to settings.png as part of
    // its language change. A tool that treats every path as an untouchable slug
    // reports that repository as clean.
    const { scanPaths } = await import('../src/paths')
    const found = scanPaths({
      repo: '/nowhere',
      files: ['docs/images/reglages.png', 'docs/images/timer-clair.png', 'src/index.ts'],
      from: 'fr',
      to: 'en',
      identifiers: new Set(),
    })
    expect(found.map((f) => f.segment)).toEqual(['reglages', 'timer-clair'])
  })

  it('leaves ordinary structural directories alone', async () => {
    const { scanPaths } = await import('../src/paths')
    const found = scanPaths({
      repo: '/nowhere',
      files: ['src/components/Button.tsx', 'docs/images/screenshot.png'],
      from: 'fr',
      to: 'en',
      identifiers: new Set(['Button']),
    })
    expect(found).toEqual([])
  })

  it('reports rather than renames, and says how many referrers it found', async () => {
    // A rename that misses one referrer is a broken build or a dead link, and
    // no static tool can prove it found the last one.
    const { pathSites } = await import('../src/paths')
    const [site] = pathSites(
      [{ path: 'docs/reglages.png', segment: 'reglages', language: 'fr', confidence: 0.85, referrers: [{ file: 'README.md', line: 3 }] }],
      'en',
    )
    expect(site!.verdict).toBe('needs-judgment')
    expect(site!.reason).toBe('dual-use')
    expect(site!.evidence.enumOrigins).toEqual(['README.md:3'])
  })
})
