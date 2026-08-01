// The hazard loop, which had no way back into the engine.
//
// The `adjudicator` contract asked for `{groupId, sites:[{siteId, verdict,
// reason}]}` and nothing parsed it, so a ruling reached the engine only by
// hand-editing `exceptions.json`. These assertions are about the REFUSALS as
// much as the happy path: a parser that accepts a half-answered hazard is worse
// than none, because it makes the gate stop meaning anything.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { scan } from '../src/scan'
import { plan } from '../src/plan'
import { EXCEPTION_REASONS } from '../src/check'
import { parseRulings, mergeExceptions, buildHazardTodo, type Adjudication } from '../src/adjudicate'
import type { Inventory } from '../src/types'

let repo: string
let inv: Inventory

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-adj-'))
  mkdirSync(join(repo, 'src'), { recursive: true })
  // The dual-use shape: one text that is a union member in one file and a
  // rendered label in another.
  writeFileSync(join(repo, 'src/status.ts'), "export type State = 'Projet archivé' | 'Projet actif'\nexport const STATES = ['Projet archivé', 'Projet actif']\n")
  writeFileSync(join(repo, 'src/ui.tsx'), 'export function Badge() {\n  return <span>Le tableau de bord principal</span>\n}\n')
  spawnSync('git', ['init', '-q'], { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  inv = await scan({ repo, from: 'fr', to: 'en' })
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

const hazardPlan = () => plan(inv, { mode: 'swap' })

describe('the worklist', () => {
  it('carries the evidence the engine refused on', () => {
    const todo = buildHazardTodo(inv, hazardPlan())
    expect(todo.hazards.length).toBeGreaterThan(0)
    const h = todo.hazards[0]!
    expect(h.blocked).toContain('identifier')
    expect(h.sites.length).toBeGreaterThan(0)
    expect(h.sites[0]).toHaveProperty('evidence')
  })
})

describe('parseRulings refuses', () => {
  const ctx = () => ({ inventory: inv, plan: hazardPlan(), validReasons: EXCEPTION_REASONS as Set<string> })

  it('a group that is not an open hazard', () => {
    const r = parseRulings([{ groupId: 'g_nope', sites: [] }], ctx())
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('not an open hazard')
  })

  it('a half-answered group', () => {
    // The whole point of the phase is that the label and the identifier get
    // DIFFERENT answers, so an unruled site is not a default — it is the half
    // of the decision nobody made.
    const g = hazardPlan().hazards[0]!
    const r = parseRulings([{ groupId: g.id, sites: [] }], ctx())
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('unruled')
  })

  it('a reason written as prose', () => {
    // `types.ts` opens by saying every vocabulary here is closed. The contract
    // used to ask for `reason` as "one line grounded in the code you read",
    // which cannot be folded into anything `check` can gate.
    const g = hazardPlan().hazards[0]!
    const r = parseRulings(
      [{ groupId: g.id, sites: g.sites.map((siteId) => ({ siteId, verdict: 'exclude', reason: 'it is stored', justification: 'x' })) }],
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('outside the closed vocabulary')
  })

  it('a ruling with no justification', () => {
    const g = hazardPlan().hazards[0]!
    const r = parseRulings(
      [{ groupId: g.id, sites: g.sites.map((siteId) => ({ siteId, verdict: 'exclude', reason: 'enum-member' })) }],
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toContain('place to hide')
  })

  it('writes nothing when any ruling in the file is bad', () => {
    // All-or-nothing: a partially applied ruling is the worst of both — some
    // sites decided, some not, and no record of which.
    const g = hazardPlan().hazards[0]!
    const r = parseRulings(
      [
        { groupId: g.id, sites: g.sites.map((siteId) => ({ siteId, verdict: 'exclude', reason: 'nonsense', justification: 'x' })) },
        { groupId: 'g_nope', sites: [] },
      ],
      ctx(),
    )
    expect(r.ok).toBe(false)
    expect(r.accepted).toHaveLength(0)
  })
})

describe('parseRulings accepts', () => {
  const good = () => {
    const p = plan(inv, { mode: 'swap' })
    const g = p.hazards[0]!
    return {
      g,
      raw: [
        {
          groupId: g.id,
          sites: [...g.sites, ...g.mirrors].map((siteId) => ({
            siteId,
            verdict: 'exclude',
            reason: 'enum-member',
            justification: 'declared as a union member in src/status.ts',
          })),
        },
      ],
    }
  }

  it('a complete ruling, and stamps the contentHash itself', () => {
    // Set by the ENGINE, never by the model: this is what makes a ruling void
    // itself when the text it was about is later rewritten.
    const { raw } = good()
    const r = parseRulings(raw, { inventory: inv, plan: hazardPlan(), validReasons: EXCEPTION_REASONS as Set<string> })
    expect(r.ok).toBe(true)
    expect(r.accepted.length).toBeGreaterThan(0)
    for (const a of r.accepted) {
      expect(a.contentHash).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('an unseparable finding, which is a claim about the code', () => {
    const g = hazardPlan().hazards[0]!
    const r = parseRulings(
      [{ groupId: g.id, unseparable: true, justification: 'the enum value IS the label; one of them has to be renamed' }],
      { inventory: inv, plan: hazardPlan(), validReasons: EXCEPTION_REASONS as Set<string> },
    )
    expect(r.ok).toBe(true)
    expect(r.blocked).toHaveLength(1)
  })
})

describe('merging into exceptions.json', () => {
  it('never clobbers an entry this run did not rule on', () => {
    const existing = {
      entries: [{ siteKey: 'other/file.ts#X', reason: 'proper-noun', justification: 'a name', contentHash: 'deadbeef' }],
    }
    const accepted: Adjudication[] = [
      {
        siteKey: 'src/status.ts#STATES/[0]', siteId: 'x', groupId: 'g', verdict: 'exclude',
        reason: 'enum-member', justification: 'y', contentHash: 'cafe0000', decidedBy: 'adjudicator',
      },
    ]
    const { merged, wrote } = mergeExceptions(existing, accepted)
    expect(wrote).toBe(1)
    expect(merged.entries.map((e) => e.siteKey)).toContain('other/file.ts#X')
    expect(merged.entries).toHaveLength(2)
  })

  it('leaves an identical entry byte-for-byte alone, so the diff stays readable', () => {
    const entry = {
      siteKey: 'a#b', reason: 'enum-member', justification: 'y', contentHash: 'cafe0000', pin: true,
      decidedBy: 'adjudicator',
    }
    const accepted: Adjudication[] = [
      { siteKey: 'a#b', siteId: 'x', groupId: 'g', verdict: 'exclude', reason: 'enum-member', justification: 'y', contentHash: 'cafe0000', decidedBy: 'adjudicator' },
    ]
    const { wrote, unchanged } = mergeExceptions({ entries: [entry] }, accepted)
    expect(wrote).toBe(0)
    expect(unchanged).toBe(1)
  })
})

describe('plan consumes the ruling', () => {
  it('unblocks a fully-ruled hazard and records who decided', () => {
    const p0 = plan(inv, { mode: 'swap' })
    const g = p0.hazards[0]!
    const byId = new Map(inv.sites.map((s) => [s.id, s]))
    const adjudications = new Map<string, Adjudication>()
    for (const id of [...g.sites, ...g.mirrors]) {
      const site = byId.get(id)!
      adjudications.set(site.siteKey, {
        siteKey: site.siteKey, siteId: id, groupId: g.id, verdict: 'exclude',
        reason: 'enum-member', justification: 'a union member', contentHash: site.contentHash,
        decidedBy: 'adjudicator',
      })
    }
    const p1 = plan(inv, { mode: 'swap', adjudications })
    expect(p1.hazards).toHaveLength(0)
    expect(p1.groups.find((x) => x.id === g.id)?.decidedBy).toBe('agent')
  })

  it('reopens the hazard when the text has changed underneath the ruling', () => {
    // A silent re-anchor is how a stale ruling launders a site nobody looked
    // at, so the group goes back to being a hazard and the plan says why. Same
    // discipline as G5's pin.
    const p0 = plan(inv, { mode: 'swap' })
    const g = p0.hazards[0]!
    const byId = new Map(inv.sites.map((s) => [s.id, s]))
    const adjudications = new Map<string, Adjudication>()
    for (const id of [...g.sites, ...g.mirrors]) {
      const site = byId.get(id)!
      adjudications.set(site.siteKey, {
        siteKey: site.siteKey, siteId: id, groupId: g.id, verdict: 'exclude',
        reason: 'enum-member', justification: 'a union member',
        contentHash: 'staleaaa', // what the text used to be
        decidedBy: 'adjudicator',
      })
    }
    const p1 = plan(inv, { mode: 'swap', adjudications })
    expect(p1.hazards).toHaveLength(1)
    expect(p1.staleAdjudications).toHaveLength(1)
    expect(p1.staleAdjudications[0]!.why).toContain('void')
  })
})
