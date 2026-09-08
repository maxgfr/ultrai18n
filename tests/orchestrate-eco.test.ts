// `--eco` is the sequential low-token path. It shipped parsed, typed, forwarded
// — and unread: `orchestrate()` wrote the fan-out workflow whatever the flag
// said, so asking for the cheap path silently got the expensive one.
//
// The positive control alone would not have caught it: RUNBOOK.md is written in
// both modes, so "eco writes a runbook" passes against the broken code. What
// separates the two modes is the ABSENCE of the workflow script, which is why
// the assertions below are about a file that must not exist and a `launch`
// string that must not name it.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestrate, phaseStatuses } from '../src/orchestrate'

/** A run directory whose PLAN.json makes exactly the `adjudicate` phase ready. */
function readyRun(): { out: string; opts: { repo: string; out: string; engine: string } } {
  const out = mkdtempSync(join(tmpdir(), 'ultrai18n-eco-'))
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(out, 'PLAN.json'),
    JSON.stringify({ hazards: [{ id: 'H1' }, { id: 'H2' }], structural: [], groups: [] }),
  )
  return { out, opts: { repo: out, out, engine: '/abs/ultrai18n.mjs' } }
}

describe('orchestrate --eco', () => {
  it('emits the workflow script by default, and launches it', () => {
    const { out, opts } = readyRun()
    const emitted = orchestrate({ ...opts, phase: 'adjudicate' })
    const workflow = join(out, 'orchestration', 'adjudicate.workflow.mjs')

    expect(existsSync(workflow)).toBe(true)
    expect(emitted.files).toContain(workflow)
    expect(emitted.launch).toContain('Workflow({')
  })

  it('writes no workflow script under --eco, and launches the runbook instead', () => {
    const { out, opts } = readyRun()
    const emitted = orchestrate({ ...opts, phase: 'adjudicate', eco: true })
    const workflow = join(out, 'orchestration', 'adjudicate.workflow.mjs')
    const runbook = join(out, 'orchestration', 'RUNBOOK.md')

    expect(existsSync(workflow)).toBe(false)
    expect(emitted.files).not.toContain(workflow)
    expect(emitted.launch).not.toContain('Workflow({')
    expect(emitted.launch).toContain(runbook)

    // The contract and the runbook are the eco deliverable, so both still ship.
    expect(existsSync(runbook)).toBe(true)
    expect(existsSync(join(out, 'orchestration', 'agents', 'adjudicator.md'))).toBe(true)
  })

  it('removes a stale workflow left by an earlier non-eco emission', () => {
    const { out, opts } = readyRun()
    orchestrate({ ...opts, phase: 'adjudicate' })
    const workflow = join(out, 'orchestration', 'adjudicate.workflow.mjs')
    expect(existsSync(workflow)).toBe(true)

    orchestrate({ ...opts, phase: 'adjudicate', eco: true })

    // Left in place it would be launched by a host that globs the directory —
    // the exact fan-out the flag was used to avoid, from a previous run's state.
    expect(existsSync(workflow)).toBe(false)
  })

  // The join command is the same fold in both modes: eco changes who plays the
  // roles, never what reduces their output.
  it('keeps the join command identical in both modes', () => {
    const a = readyRun()
    const b = readyRun()
    // replaceAll, not replace: the join command names the run directory more
    // than once, and a first-occurrence swap leaves the two strings differing
    // by a path that was never what the assertion is about.
    expect(orchestrate({ ...a.opts, phase: 'adjudicate', eco: true }).join.replaceAll(a.out, 'RUN')).toBe(
      orchestrate({ ...b.opts, phase: 'adjudicate' }).join.replaceAll(b.out, 'RUN'),
    )
  })
})

// `apply` writes APPLY.json whether or not it wrote anything — guarding a dry
// run would be theatre. So the phases that EDIT FILES cannot gate on the report
// existing; they have to read what it says. Previewing an apply used to open
// both of them, which is the one moment they must stay shut.
describe('phases that edit files gate on a real apply, not a previewed one', () => {
  it('stays closed after a dry-run apply and opens after a written one', () => {
    const out = mkdtempSync(join(tmpdir(), 'ultrai18n-apply-'))
    writeFileSync(
      join(out, 'PLAN.json'),
      JSON.stringify({ hazards: [], structural: [{ id: 'S1' }], groups: [] }),
    )
    writeFileSync(join(out, 'PLURALS.todo.json'), JSON.stringify({ families: [{ key: 'cart' }] }))

    const gated = () => {
      const s = phaseStatuses(out)
      return {
        plural: s.find((p) => p.name === 'plural')!.ready,
        structural: s.find((p) => p.name === 'structural')!.ready,
      }
    }

    writeFileSync(join(out, 'APPLY.json'), JSON.stringify({ write: false, ok: true }))
    expect(gated()).toEqual({ plural: false, structural: false })

    writeFileSync(join(out, 'APPLY.json'), JSON.stringify({ write: true, ok: true }))
    expect(gated()).toEqual({ plural: true, structural: true })
  })
})

// A corrupt report must read as "not applied" and must not take the status
// command down with it: `orchestrate --list` is what you run to find out what
// state a run is in, so one unreadable artefact hiding every other phase's
// state is the worst possible failure mode for it.
describe('a corrupt apply report reads as not-applied, and never throws', () => {
  for (const [label, body] of [
    ['malformed', '{not json'],
    ['empty', ''],
    ['null', 'null'],
    ['no write field', '{"ok":true}'],
  ] as const) {
    it(`survives a ${label} APPLY.json`, () => {
      const out = mkdtempSync(join(tmpdir(), 'ultrai18n-corrupt-'))
      writeFileSync(join(out, 'PLAN.json'), JSON.stringify({ hazards: [], structural: [{ id: 'S1' }], groups: [] }))
      writeFileSync(join(out, 'APPLY.json'), body)

      const s = phaseStatuses(out)
      expect(s.find((p) => p.name === 'structural')!.ready).toBe(false)
    })
  }
})

// `translate` reports its items in BATCHES — phaseStatuses already divided the
// pending groups by the batch size. Chunking that a second time emitted one
// agent for every eight batches, so batch 001 onward was never dispatched and
// the run looked complete.
describe('the workflow dispatches one agent per batch', () => {
  it('emits every batch for a translate fan-out', () => {
    const out = mkdtempSync(join(tmpdir(), 'ultrai18n-batches-'))
    mkdirSync(join(out, 'batches'), { recursive: true })
    // 16 pending groups = 2 batches of 8.
    writeFileSync(
      join(out, 'PLAN.json'),
      JSON.stringify({
        hazards: [],
        structural: [],
        groups: Array.from({ length: 16 }, (_, i) => ({ id: `g${i}`, status: 'pending' })),
      }),
    )
    expect(phaseStatuses(out).find((p) => p.name === 'translate')!.items).toBe(2)

    orchestrate({ repo: out, out, engine: '/abs/ultrai18n.mjs', phase: 'translate' })
    const script = readFileSync(join(out, 'orchestration', 'translate.workflow.mjs'), 'utf8')
    expect(script).toContain('const ITEMS = ["000","001"]')
  })
})

// A worklist that EXISTS and is empty is not a worklist that is missing. When
// `reason` was left unset for those cases the caller fell back to "its worklist
// does not exist", sending the reader to look for a file sitting right there.
describe('an empty worklist says it is empty, not that it is missing', () => {
  it('names the real reason for adjudicate and translate', () => {
    const out = mkdtempSync(join(tmpdir(), 'ultrai18n-reason-'))
    mkdirSync(join(out, 'batches'), { recursive: true })
    writeFileSync(
      join(out, 'PLAN.json'),
      JSON.stringify({ hazards: [], structural: [], groups: [{ id: 'g0', status: 'done' }] }),
    )

    const s = phaseStatuses(out)
    const reason = (n: string) => s.find((p) => p.name === n)!.reason ?? ''

    expect(s.find((p) => p.name === 'adjudicate')!.ready).toBe(false)
    expect(reason('adjudicate')).toMatch(/no open hazard/)
    expect(reason('adjudicate')).not.toMatch(/does not exist/)

    expect(s.find((p) => p.name === 'translate')!.ready).toBe(false)
    expect(reason('translate')).toMatch(/no pending group/)
    // Deliberately not "already translated": a plan of purely structural groups
    // reaches the same branch with nothing translated at all.
    expect(reason('translate')).not.toMatch(/already translated/)
  })
})
