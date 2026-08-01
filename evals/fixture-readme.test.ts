// The fixture's shape table, held to the fixture.
//
// It used to be a hand-written table sitting next to a test asserting the same
// facts: two places to be wrong, and only one of them fails when they disagree.
// Now the derived columns are generated and this test is what makes a stale
// table red — no committed artifact, no extra CI step, because `pnpm test`
// already runs the evals.
//
// Regenerate with `pnpm gen:evals`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { isolatedRepo, removeRepo } from './isolate'
import { readProves, renderShapeTable, shapeRows, spliceGenerated } from './shapes-table'
import type { Inventory } from '../src/types'

const FIXTURE = join(import.meta.dirname, 'fixture-i18n')
const README = join(FIXTURE, 'README.md')

let repo: string
let inv: Inventory

beforeAll(async () => {
  repo = isolatedRepo(FIXTURE, 'readme')
  // `ru` matches what `plurals.test.ts` scans with, so the `target needs`
  // column means the same thing in both places.
  inv = await scan({ repo, from: 'auto', to: 'ru' })
}, 60_000)

afterAll(() => removeRepo(repo))

describe('the generated shape table', () => {
  it('matches the fixture, or the README is stale', () => {
    const readme = readFileSync(README, 'utf8')
    const next = spliceGenerated(readme, renderShapeTable(shapeRows(inv, readProves(readme))))
    if (process.env.ULTRAI18N_WRITE) writeFileSync(README, next)
    expect(next).toBe(readme)
  })

  it('leaves the human region byte-identical', () => {
    // The `proves` column is the one thing a machine cannot derive: it is the
    // reason a row is in the fixture at all.
    const readme = readFileSync(README, 'utf8')
    const human = readme.slice(readme.indexOf('<!-- ul:human key=proves -->'))
    const next = spliceGenerated(readme, renderShapeTable(shapeRows(inv, readProves(readme))))
    expect(next.slice(next.indexOf('<!-- ul:human key=proves -->'))).toBe(human)
  })

  it('gives every family a human reason, so a new shape cannot land undocumented', () => {
    const proves = readProves(readFileSync(README, 'utf8'))
    const undocumented = shapeRows(inv, proves).filter((r) => !r.proves)
    expect(undocumented.map((r) => r.anchor)).toEqual([])
  })
})
