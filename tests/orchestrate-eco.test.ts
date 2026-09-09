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

// Every command this module prints is pasted into a shell that holds none of
// the run's state, so an omitted flag is re-defaulted at that moment. A rescan
// without --from/--to rebuilt the inventory against the DEFAULT target: a run
// translated into Russian came back as if it had targeted the default, and the
// plan was overwritten on top of it. No error, exit 0, a retargeted run.
describe('emitted rescans carry the run own languages', () => {
  const runWith = (inventory: unknown | null) => {
    const out = mkdtempSync(join(tmpdir(), 'ultrai18n-lang-'))
    writeFileSync(
      join(out, 'PLAN.json'),
      JSON.stringify({ hazards: [], structural: [{ id: 'S1' }], groups: [] }),
    )
    writeFileSync(join(out, 'APPLY.json'), JSON.stringify({ write: true, ok: true }))
    if (inventory !== null) writeFileSync(join(out, 'inventory.json'), JSON.stringify(inventory))
    return { out, opts: { repo: out, out, engine: '/abs/ultrai18n.mjs' } }
  }

  it('puts --from/--to on the scan in the join and in the runbook', () => {
    const { out, opts } = runWith({ sourceLanguage: 'fr', targetLanguage: 'ru' })
    const emitted = orchestrate({ ...opts, phase: 'structural' })

    expect(emitted.join).toContain('scan --repo')
    expect(emitted.join).toContain('--from fr --to ru')
    expect(readFileSync(join(out, 'orchestration', 'RUNBOOK.md'), 'utf8')).toContain('--from fr --to ru')
  })

  it('emits only --to when the source language was never resolved', () => {
    const { opts } = runWith({ sourceLanguage: null, targetLanguage: 'ja' })
    const join_ = orchestrate({ ...opts, phase: 'structural' }).join
    expect(join_).toContain('--to ja')
    expect(join_).not.toContain('--from')
  })

  // The flags are a convenience, never a precondition: a run with no inventory
  // yet, or a corrupt one, still has to produce a usable command rather than
  // take the whole status path down.
  // `undefined` means "write no inventory file at all"; every other entry is
  // written verbatim. The distinction matters: a JSON `null` body and a missing
  // file take different branches, and spelling both as `null` made one of these
  // cases silently duplicate the other.
  for (const [label, body] of [
    ['no inventory', undefined],
    ['malformed inventory', '{not json'],
    ['a JSON null body', 'null'],
    ['an empty file', ''],
    ['non-string language fields', '{"sourceLanguage":7,"targetLanguage":{}}'],
    ['a language tag carrying a shell command', '{"targetLanguage":"ru; printf INJECTED"}'],
    ['a language tag carrying another option', '{"targetLanguage":"ru --out /elsewhere"}'],
    ['a language tag with a space', '{"targetLanguage":"ru RU"}'],
    ['a blank language tag', '{"targetLanguage":"   "}'],
  ] as const) {
    it(`emits a bare scan and does not throw with ${label}`, () => {
      const out = mkdtempSync(join(tmpdir(), 'ultrai18n-lang2-'))
      writeFileSync(join(out, 'PLAN.json'), JSON.stringify({ hazards: [], structural: [{ id: 'S1' }], groups: [] }))
      writeFileSync(join(out, 'APPLY.json'), JSON.stringify({ write: true, ok: true }))
      if (body !== undefined) writeFileSync(join(out, 'inventory.json'), body)

      const emitted = orchestrate({ repo: out, out, engine: '/abs/ultrai18n.mjs', phase: 'structural' })
      expect(emitted.join).toContain('scan --repo')
      expect(emitted.join).not.toContain('--from')
      expect(emitted.join).not.toContain('--to')
      // The printed string is pasted into a shell, so nothing that would become
      // a second command or a second option may survive into it.
      expect(emitted.join).not.toContain('INJECTED')
      expect(emitted.join).not.toContain(';')
      expect(emitted.join).not.toContain('/elsewhere')
    })
  }

  it('accepts a real BCP-47 tag with a region subtag', () => {
    const { opts } = runWith({ sourceLanguage: 'pt-BR', targetLanguage: 'zh-Hant' })
    expect(orchestrate({ ...opts, phase: 'structural' }).join).toContain('--from pt-BR --to zh-Hant')
  })

  // `scan --to ru_RU` is accepted and stored, so a hyphen-only guard would drop
  // a tag the run really was scanned with — and hand back a rescan that quietly
  // reverts to the default, which is the exact failure this change exists to fix.
  it('accepts the POSIX underscore spelling that scan itself stores', () => {
    const { opts } = runWith({ sourceLanguage: 'fr_FR', targetLanguage: 'ru_RU' })
    expect(orchestrate({ ...opts, phase: 'structural' }).join).toContain('--from fr_FR --to ru_RU')
  })
})

// `orchestrate --list` is what you run to find out what state a run is in, so
// it is the one path that must survive a corrupt artefact. A malformed
// PLAN.json used to throw out of `phaseStatuses`, hiding every phase's state
// behind one bad file at exactly the moment someone is diagnosing the run.
describe('phaseStatuses survives every artefact it reads being corrupt', () => {
  const FILES = ['PLAN.json', 'dialects.todo.json', 'PLURALS.todo.json', 'VERIFY.todo.json', 'APPLY.json'] as const
  const BODIES = ['{not json', 'null', '[]', '', '{"residual":"abc","families":{"length":2},"groups":{},"pairs":7}'] as const
  for (const [file, body] of FILES.flatMap((f) => BODIES.map((b) => [f, b] as const))) {
    it(`does not throw on a ${body === '' ? 'empty' : body.slice(0, 14)} ${file}`, () => {
      const out = mkdtempSync(join(tmpdir(), 'ultrai18n-corrupt2-'))
      writeFileSync(join(out, file), body)
      const s = phaseStatuses(out)
      expect(s).toHaveLength(6)
      // Nothing is ready off a file that could not be read: an unreadable
      // artefact is not evidence that the work behind it is done.
      expect(s.every((p) => p.ready === false)).toBe(true)
    })
  }
})

// `review` used to be ready on the file EXISTING. Every other phase is ready on
// having work, and an empty worklist does not fan out to nothing: the batch
// labels are floored at one, so it dispatched a single agent with no work.
describe('review is ready on having pairs, not on having a file', () => {
  const runWithVerify = (body: string) => {
    const out = mkdtempSync(join(tmpdir(), 'ultrai18n-review-'))
    writeFileSync(join(out, 'VERIFY.todo.json'), body)
    return phaseStatuses(out).find((p) => p.name === 'review')!
  }

  it('is ready with pairs', () => {
    const s = runWithVerify(JSON.stringify({ pairs: [{ id: 'p1' }, { id: 'p2' }] }))
    expect(s.ready).toBe(true)
    expect(s.items).toBe(2)
  })

  // An array of holes is length 1 and no work at all — the same defect as a
  // string with a `length`, one level down.
  it('is not ready with a pair list of holes', () => {
    const s = runWithVerify(JSON.stringify({ pairs: [null, null] }))
    expect(s.ready).toBe(false)
    expect(s.items).toBe(0)
  })

  it('is not ready with an empty pair list, and says so', () => {
    const s = runWithVerify(JSON.stringify({ pairs: [] }))
    expect(s.ready).toBe(false)
    expect(s.items).toBe(0)
    expect(s.reason).toMatch(/no claim\/citation pair/)
  })

  it('still names the producing command when the worklist is absent', () => {
    const out = mkdtempSync(join(tmpdir(), 'ultrai18n-review2-'))
    const s = phaseStatuses(out).find((p) => p.name === 'review')!
    expect(s.ready).toBe(false)
    expect(s.reason).toMatch(/run `verify`/)
  })
})
