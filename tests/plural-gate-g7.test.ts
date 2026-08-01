// G7 — every plural-shaped site is claimed by some dialect.
//
// The gate that makes "the model handles plurals" a loop that TERMINATES. The
// engine names what it could not account for, a dialect is declared, the list
// shrinks; when it is empty the gate passes and there is nothing left to guess
// about.
//
// Its semantic twin is G2, not G6, and the distinction is the point of the test
// below that checks them apart: G6's `plural-incomplete` means "your repository
// has a rendering bug", G7 means "my engine does not understand your
// repository". Those are the user's problem and the tool's problem.
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitAll, emptyRepo, removeRepo } from '../evals/isolate'
import { scan } from '../src/scan'
import { check } from '../src/check'
import type { CheckReport } from '../src/check'

async function run(files: Record<string, string>, exceptions?: unknown): Promise<CheckReport> {
  const repo = emptyRepo('g7')
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true })
      writeFileSync(join(repo, rel), body)
    }
    commitAll(repo)
    const inventory = await scan({ repo, from: 'en', to: 'ru' })
    return check({
      repo,
      inventory,
      ...(exceptions ? { exceptions: exceptions as never } : {}),
    })
  } finally {
    removeRepo(repo)
  }
}

const gate = (r: CheckReport, id: string) => r.gates.find((g) => g.id === id)!

describe('G7', () => {
  it('fails on an arrangement no dialect reads', async () => {
    const report = await run({
      'src/locales/en.json': JSON.stringify({ cart: { items: '%{n} item |||| %{n} items' } }, null, 2),
    })
    const g7 = gate(report, 'G7')
    expect(g7.ok).toBe(false)
    expect(g7.findings[0]!.kind).toBe('plural-unclaimed')
    expect(g7.findings[0]!.message).toContain('delimited-counting')
  }, 60_000)

  it('passes when every plural-shaped site belongs to a family', async () => {
    const report = await run({
      'src/locales/en/common.json': JSON.stringify(
        { cart: { item_one: '{{count}} item', item_other: '{{count}} items' } },
        null,
        2,
      ),
    })
    expect(gate(report, 'G7').ok).toBe(true)
  }, 60_000)

  it('passes on a repository with no plurals in it at all', async () => {
    const report = await run({ 'src/app.ts': 'export const title = "Dashboard"\n' })
    expect(gate(report, 'G7').ok).toBe(true)
  }, 60_000)

  it('separates "your repository is broken" from "my engine does not understand it"', async () => {
    // A Russian bundle short of `few` and `many` is a live rendering bug — G6.
    // A Polyglot string nothing reads is a limit of the engine — G7. One run,
    // two gates, and `check --json` can tell a user which is which.
    const report = await run({
      'src/locales/ru/common.json': JSON.stringify(
        { cart: { item_one: '{{count}} штука', item_other: '{{count}} штук' }, box: { n: '%{n} a |||| %{n} ab' } },
        null,
        2,
      ),
    })
    const g6 = gate(report, 'G6')
    const g7 = gate(report, 'G7')
    expect(g6.findings.some((f) => f.kind === 'plural-incomplete')).toBe(true)
    expect(g7.findings.every((f) => f.kind === 'plural-unclaimed')).toBe(true)
    expect(g6.findings.some((f) => f.kind === 'plural-unclaimed')).toBe(false)
  }, 60_000)

  it('is excused by an exception, like every other gate', async () => {
    const files = {
      'src/locales/en.json': JSON.stringify({ cart: { items: '%{n} item |||| %{n} items' } }, null, 2),
    }
    const open = await run(files)
    const siteKey = gate(open, 'G7').findings[0]!.siteKey!

    const closed = await run(files, {
      entries: [
        {
          siteKey,
          reason: 'not-a-plural',
          justification: 'a two-option menu that happens to carry a number',
        },
      ],
    })
    expect(gate(closed, 'G7').ok).toBe(true)
    // And the exception itself has to be valid, or G5 would have caught it.
    expect(gate(closed, 'G5').ok).toBe(true)
  }, 60_000)

  it('runs alongside every other gate rather than short-circuiting one', async () => {
    const report = await run({
      'src/locales/en.json': JSON.stringify({ cart: { items: '%{n} item |||| %{n} items' } }, null, 2),
    })
    expect(report.gates.map((g) => g.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'])
  }, 60_000)
})
