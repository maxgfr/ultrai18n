// The two failures the verification lifecycle had after `apply --write`.
//
// F3 — VERIFY and CHECK read the repository through the offsets of the
// inventory that was scanned BEFORE the write. Every translation whose byte
// length differs from its source moves everything after it, so the span
// recorded for a site no longer holds that site: a shorter translation makes
// `verify` quote the beginning of the next line, and `check` reports the
// pre-apply French as if it were still on disk. The documented sequence
// (scan → plan → translate → apply --write → verify → check) has no rescan in
// it, and adding one by hand overwrites the source-language inventory the plan
// was built from — a workaround that destroys the provenance.
//
// F4 — `checkSemantic` trusted `result.counts.unadjudicated`, a number in the
// same file as the verdicts it summarises. Deleting every verdict while leaving
// the counter at zero passed the gate, and so did adjudicating one pair of a
// worklist that had several. Coverage has to be RECOMPUTED against the actual
// worklist, by identity, and a site's identity is structural: `file:line` holds
// two strings as easily as one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { plan, type Plan } from '../src/plan'
import { apply } from '../src/apply'
import {
  applyVerdicts, buildVerify, checkSemantic,
  type Pair, type VerifyResult, type VerifyTodo,
} from '../src/verify'
import type { Inventory } from '../src/types'

// Everything the fixture repositories say, and what a translator returns for
// it. Lengths differ from their sources on purpose, in both directions and in
// bytes as well as characters — that difference is the whole bug.
const TABLE: Record<string, string> = {
  // Shorter, and the source carries a multi-byte `é`: the reported case.
  'Affiche des informations sur notre projet et sur son état courant.':
    'Display information about our project.',
  // Two sites on ONE line, one target shorter and one longer.
  'Ouvrir le tiroir des réglages': 'Open the drawer',
  'Fermer le tiroir des réglages': 'Close the drawer of settings and options',
  // Sits after both of those, so its offsets move twice before it is read.
  'Le tiroir garde vos préférences entre deux sessions':
    'The drawer keeps your preferences between sessions',
  // Returned unchanged — a translator may legitimately do that, and the review
  // still has to read the right bytes for it.
  'Configuration du serveur de production': 'Configuration du serveur de production',
}

const FILES: Record<string, string> = {
  'task.sh':
    '#!/bin/sh\n# Affiche des informations sur notre projet et sur son état courant.\nprintf \'ok\\n\'\n',
  'labels.ts':
    "export const open = 'Ouvrir le tiroir des réglages', close = 'Fermer le tiroir des réglages'\n" +
    "export const hint = 'Le tiroir garde vos préférences entre deux sessions'\n" +
    "export const server = 'Configuration du serveur de production'\n",
}

function makeRepo(label: string, files: Record<string, string> = FILES): string {
  const repo = mkdtempSync(join(tmpdir(), `ultrai18n-${label}-`))
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(repo, rel), body)
  spawnSync('git', ['init', '-q'], { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: repo })
  return repo
}

/** scan → plan → translate from the table → `apply --write`, with no rescan. */
async function runToWrite(repo: string): Promise<{ inventory: Inventory; planned: Plan }> {
  const inventory = await scan({ repo, from: 'fr', to: 'en' })
  const planned = plan(inventory, { mode: 'swap' })
  const translations: { id: string; text: string }[] = []
  for (const group of planned.groups) {
    if (group.status !== 'pending' && group.status !== 'memo') continue
    const text = TABLE[group.text] ?? group.text
    for (const id of [...group.sites, ...group.mirrors]) translations.push({ id, text })
  }
  const report = apply({ repo, inventory, translations, write: true })
  expect(report.sites.refused).toBe(0)
  return { inventory, planned }
}

/** The whole worklist, so a sampling decision never decides what a test proves. */
const ALL = { sampleRate: 1, maxVerify: 40 }

const pairFor = (todo: VerifyTodo, src: string): Pair => {
  const found = todo.pairs.find((p) => p.src === src)
  if (!found) throw new Error(`no pair for ${JSON.stringify(src)}; saw ${todo.pairs.map((p) => p.src).join(' | ')}`)
  return found
}

describe('verify reviews the bytes that are there now (F3)', () => {
  let repo: string
  let inventory: Inventory
  let planned: Plan
  let live: Inventory
  let todo: VerifyTodo

  beforeAll(async () => {
    repo = makeRepo('lifecycle')
    ;({ inventory, planned } = await runToWrite(repo))
    // The refresh the engine must do for itself: a scan of the repository as it
    // is now, run with the ORIGINAL pair, never written over inventory.json.
    live = await scan({ repo, from: 'fr', to: 'en' })
    todo = buildVerify({ repo, inventory, plan: planned, live, ...ALL })
  }, 120_000)

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('quotes a shorter translation exactly, not the line after it', () => {
    // The reported case. With the pre-apply offsets the recorded span is longer
    // than the text now in it, so the excerpt runs on into `printf`.
    const pair = pairFor(todo, 'Affiche des informations sur notre projet et sur son état courant.')
    expect(pair.tgt).toBe('Display information about our project.')
    expect(pair.tgt).not.toContain('printf')
    expect(pair.tgt).not.toContain('\n')
  })

  it('quotes a longer translation whole, not truncated to the old length', () => {
    const pair = pairFor(todo, 'Fermer le tiroir des réglages')
    expect(pair.tgt).toBe('Close the drawer of settings and options')
  })

  it('tells two sites on the same line apart', () => {
    // `file:line` is not an identity: this line holds two strings, and a review
    // that keys on it reviews one of them twice and the other never.
    const open = pairFor(todo, 'Ouvrir le tiroir des réglages')
    const close = pairFor(todo, 'Fermer le tiroir des réglages')
    expect(open.citation).toBe(close.citation)
    expect(open.tgt).toBe('Open the drawer')
    expect(close.tgt).toBe('Close the drawer of settings and options')
    expect(open.siteId).toBeTruthy()
    expect(open.siteId).not.toBe(close.siteId)
  })

  it('reads a site that several edits above it have moved', () => {
    const pair = pairFor(todo, 'Le tiroir garde vos préférences entre deux sessions')
    expect(pair.tgt).toBe('The drawer keeps your preferences between sessions')
  })

  it('reads a translation that came back unchanged', () => {
    const pair = pairFor(todo, 'Configuration du serveur de production')
    expect(pair.tgt).toBe('Configuration du serveur de production')
  })

  it('keeps the source text and the source pair from the plan', () => {
    // The refresh is for OFFSETS. The claim under review is still "this source
    // text became that target text", which only the pre-apply plan knows.
    expect(todo.pair).toBe('fr→en')
    expect(pairFor(todo, 'Ouvrir le tiroir des réglages').src).toBe('Ouvrir le tiroir des réglages')
    expect(inventory.sites.find((s) => s.file === 'task.sh')!.value).toContain('Affiche')
  })

  it('records deliberate zero sampling honestly and rejects malformed sampling options', () => {
    const lowRisk = { ...planned, groups: planned.groups.filter((group) =>
      group.holes.length === 0 && group.mirrors.length === 0 && group.sites.length === 1 && group.max === null) }
    expect(lowRisk.groups.length).toBeGreaterThan(0)
    const empty = buildVerify({ repo, inventory, live, plan: lowRisk, sampleRate: 0 })
    expect(empty.pairs).toEqual([])
    expect(empty.notReviewed.groups).toBe(lowRisk.groups.length)
    const result = applyVerdicts({ todo: empty, verdicts: [] })
    expect(checkSemantic({ repo, inventory, live, plan: lowRisk, todo: empty, result }).ok).toBe(true)
    for (const options of [{ sampleRate: NaN }, { sampleRate: -1 }, { maxVerify: 0 }, { maxVerify: 1.5 }]) {
      expect(() => buildVerify({ repo, inventory, live, plan: planned, ...options })).toThrow(/sample-rate/)
    }
  })

  it('refuses when a selected site is gone, rather than skipping it', async () => {
    // A site that vanished is the one case where silence is worst: the pair
    // simply does not appear, the worklist is shorter, and nothing says why.
    const gone = makeRepo('lifecycle-gone')
    try {
      const state = await runToWrite(gone)
      const rel = join(gone, 'labels.ts')
      writeFileSync(
        rel,
        readFileSync(rel, 'utf8')
          .split('\n')
          .filter((l) => !l.includes('hint'))
          .join('\n'),
      )
      const after = await scan({ repo: gone, from: 'fr', to: 'en' })
      expect(() =>
        buildVerify({ repo: gone, inventory: state.inventory, plan: state.planned, live: after, ...ALL }),
      ).toThrow(/no longer|not in the repository|removed/i)
    } finally {
      rmSync(gone, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the refresh honours the scan that produced the inventory (F3)', () => {
  let repo: string
  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('holds the source language fixed instead of re-inferring it from translated bytes', async () => {
    // `--from auto` on a repository that has just been translated infers the
    // TARGET language, which makes every gate that compares against the source
    // language vacuous. The refresh has to reuse what the original scan ran
    // with, which means the inventory has to record it.
    repo = makeRepo('lifecycle-provenance')
    const { inventory } = await runToWrite(repo)
    const { refreshInventory } = await import('../src/live')

    const naive = await scan({ repo, to: 'en' })
    expect(naive.sourceLanguage).toBe('en') // the trap

    const live = await refreshInventory(repo, inventory)
    expect(live.sourceLanguage).toBe('fr')
    expect(live.targetLanguage).toBe('en')
    // And it is a view, not a replacement: the source inventory is untouched.
    expect(inventory.sites.find((s) => s.file === 'task.sh')!.value).toContain('Affiche')
  }, 120_000)

  it('carries the options a scan ran with, and reads an inventory written without them', async () => {
    const inventory = await scan({ repo, from: 'fr', to: 'en' })
    expect(inventory.scanOptions).toMatchObject({ from: 'fr', to: 'en' })

    const { scanOptionsFor } = await import('../src/live')
    // Backwards compatibility: an inventory from an older run has no record of
    // its options, and its resolved languages are the best evidence there is.
    const legacy = { ...inventory } as Inventory
    delete (legacy as { scanOptions?: unknown }).scanOptions
    expect(scanOptionsFor(repo, legacy)).toMatchObject({ from: 'fr', to: 'en' })
  }, 120_000)

  it('retains non-default extraction options across the refresh', async () => {
    const options = {
      repo, from: 'fr', to: 'en', noAst: true,
      pluralSidecar: join(repo, 'custom-plurals.json'),
      dialectsPath: join(repo, 'custom-dialects.json'),
    }
    const inventory = await scan(options)
    const { refreshInventory, scanOptionsFor } = await import('../src/live')
    expect(scanOptionsFor(repo, inventory)).toEqual(options)
    expect((await refreshInventory(repo, inventory)).scanOptions).toEqual(inventory.scanOptions)
  })
})

// ---------------------------------------------------------------------------

describe('check --semantic recomputes coverage (F4)', () => {
  let repo: string
  let inventory: Inventory
  let live: Inventory
  let todo: VerifyTodo
  let result: VerifyResult

  const semantic = (over: Partial<VerifyResult> | null, worklist: VerifyTodo = todo) =>
    checkSemantic({
      repo,
      inventory,
      live,
      todo: worklist,
      result: over === null ? null : ({ ...result, ...over } as VerifyResult),
    })

  beforeAll(async () => {
    repo = makeRepo('semantic')
    const state = await runToWrite(repo)
    inventory = state.inventory
    live = await scan({ repo, from: 'fr', to: 'en' })
    todo = buildVerify({ repo, inventory, plan: state.planned, live, ...ALL })
    result = applyVerdicts({
      todo,
      verdicts: todo.pairs.map((p) => ({ claimId: p.claimId, citation: p.citation, verdict: 'supported' })),
    })
  }, 120_000)

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('passes a review that actually covered every pair', () => {
    expect(todo.pairs.length).toBeGreaterThan(1)
    const check = semantic({})
    expect(check.findings).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('refuses an empty ledger carrying a zero counter', () => {
    // The forgery this gate existed to catch and did not: delete the verdicts,
    // leave `unadjudicated: 0`, and the summary vouches for itself.
    const check = semantic({ verdicts: [], counts: { ...result.counts, unadjudicated: 0 } })
    expect(check.ok).toBe(false)
    expect(check.findings.join('\n')).toMatch(/never adjudicated|not adjudicated/i)
  })

  it('refuses one adjudication padded out with a duplicate of itself', () => {
    // Two rows, one pair covered. The other pair shares its LINE with the
    // covered one, so a citation-keyed count reads as complete.
    const first = todo.pairs[0]!
    const check = semantic({
      verdicts: [
        { ...first, verdict: 'supported' as const },
        { ...first, verdict: 'supported' as const },
      ],
      counts: { supported: todo.pairs.length, partial: 0, refuted: 0, unsupported: 0, unadjudicated: 0 },
    })
    expect(check.ok).toBe(false)
    expect(check.findings.join('\n')).toMatch(/twice|duplicate/i)
    expect(check.findings.join('\n')).toMatch(/never adjudicated|not adjudicated/i)
  })

  it('refuses verdicts belonging to some other worklist', () => {
    const foreign = result.verdicts.map((v) => ({ ...v, claimId: `g_${v.claimId.slice(2)}x` }))
    const check = semantic({ verdicts: foreign })
    expect(check.ok).toBe(false)
    expect(check.findings.join('\n')).toMatch(/no such (claim|pair)|not in this worklist|worklist/i)
  })

  it('refuses an edited worklist payload even when claim and site ids were retained', () => {
    const pairs = todo.pairs.map((pair) => ({ ...pair, src: `${pair.src} changed` }))
    expect(semantic({}, { ...todo, pairs }).ok).toBe(false)
  })

  it('refuses duplicate, foreign, null and incomplete input at verify --apply', () => {
    const row = { claimId: todo.pairs[0]!.claimId, verdict: 'supported' }
    expect(() => applyVerdicts({ todo, verdicts: [row, row] })).toThrow(/duplicate/)
    expect(() => applyVerdicts({ todo, verdicts: [{ ...row, citation: 'foreign:1' }] })).toThrow(/foreign/)
    expect(() => applyVerdicts({ todo, verdicts: [null] as never[] })).toThrow(/malformed/)
    expect(applyVerdicts({ todo, verdicts: [row] }).ok).toBe(false)
  })

  it('refuses malformed and duplicate worklists without a crash', () => {
    for (const pairs of [[null], [todo.pairs[0], todo.pairs[0]]]) {
      expect(semantic({}, { ...todo, pairs } as VerifyTodo).ok).toBe(false)
    }
  })

  it('refuses a new shell comment that reassigns an existing ordinal id', async () => {
    const abs = join(repo, 'task.sh')
    const before = readFileSync(abs, 'utf8')
    try {
      writeFileSync(abs, before.replace('#!/bin/sh\n', '#!/bin/sh\n# Generated; do not edit by hand.\n'))
      const after = await scan({ repo, from: 'fr', to: 'en' })
      expect(checkSemantic({ repo, inventory, live: after, todo, result }).ok).toBe(false)
      const planned = plan(inventory, { mode: 'swap' })
      expect(() => buildVerify({ repo, inventory, live: after, plan: planned, ...ALL })).toThrow(/structure changed|ambiguous/)
    } finally {
      writeFileSync(abs, before)
    }
  })

  it('reports a malformed row instead of throwing on it', () => {
    // The file is raw persisted JSON. A stack trace here is a gate that did not
    // run, reported as a crash.
    const junk = [null, 'nope', { note: 'no claim id' }, { claimId: todo.pairs[0]!.claimId, verdict: null }]
    let check!: ReturnType<typeof checkSemantic>
    expect(() => {
      check = semantic({ verdicts: junk as unknown as Pair[] })
    }).not.toThrow()
    expect(check.ok).toBe(false)
    expect(check.findings.length).toBeGreaterThan(0)
    expect(check.findings.join('\n')).not.toMatch(/at Object\.|TypeError|Cannot read/)
  })

  it('passes a run with genuinely nothing to review', () => {
    // The honest zero, which must stay distinguishable from the forged one: an
    // empty worklist and an empty ledger agree with each other.
    const empty: VerifyTodo = {
      schemaVersion: 1, repo, pair: 'fr→en', pairs: [],
      notReviewed: { groups: 0, reason: 'nothing was translated' },
    }
    const check = checkSemantic({
      repo, inventory, live, todo: empty,
      result: {
        schemaVersion: 1, ok: true,
        counts: { supported: 0, partial: 0, refuted: 0, unsupported: 0, unadjudicated: 0 },
        failures: [], verdicts: [],
      },
    })
    expect(check.findings).toEqual([])
    expect(check.ok).toBe(true)
  })

  it('refuses a pass once the reviewed bytes are reworded underneath it', async () => {
    const abs = join(repo, 'task.sh')
    const before = readFileSync(abs, 'utf8')
    try {
      writeFileSync(abs, before.replace('Display information about our project.', 'Totally different words here.'))
      const after = await scan({ repo, from: 'fr', to: 'en' })
      const check = checkSemantic({ repo, inventory, live: after, todo, result })
      expect(check.ok).toBe(false)
      expect(check.findings.join('\n')).toMatch(/no longer matches/)
    } finally {
      writeFileSync(abs, before)
    }
  }, 120_000)

  it('does not refuse a pass because an unrelated edit moved the reviewed site', async () => {
    // The false negative the stale offsets produced: nothing about the reviewed
    // excerpt changed, only its position, and the review was thrown out.
    const abs = join(repo, 'task.sh')
    const before = readFileSync(abs, 'utf8')
    try {
      writeFileSync(abs, before.replace('#!/bin/sh\n', '#!/bin/sh\n\n'))
      const after = await scan({ repo, from: 'fr', to: 'en' })
      const check = checkSemantic({ repo, inventory, live: after, todo, result })
      expect(check.findings).toEqual([])
      expect(check.ok).toBe(true)
    } finally {
      writeFileSync(abs, before)
    }
  }, 120_000)
})
