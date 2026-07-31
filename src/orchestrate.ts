// orchestrate: a code generator, not a dispatcher.
//
// It reads what is on disk, decides which phase is ready, and writes the
// scripts and contracts to run it. The engine cannot spawn agents and does not
// pretend to; what it can do is make the hand-off exact, so the same run is
// reproducible whether a workflow tool, a person, or a shell loop drives it.
//
// One rule governs the whole thing and it is not stylistic: `apply` is the sole
// writer and runs exactly once, after the join. One group's translation lands
// in several files and two groups share a file, so a fan-out of writers would
// have the second rename silently drop the first — and the atomic-group
// guarantee with it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSLATOR_CONTRACT } from './translate'

export type PhaseName = 'adjudicate' | 'translate' | 'review' | 'plural' | 'structural'

export interface PhaseStatus {
  name: PhaseName
  ready: boolean
  /** When not ready, the command that produces what is missing. */
  reason?: string
  worklist: string
  items: number
  writes: boolean
}

export interface OrchestrateOptions {
  repo: string
  out: string
  engine: string
  phase?: PhaseName
  list?: boolean
  eco?: boolean
}

const BATCH_SIZE = 8
const SMALL_WORKLIST = 3

export function phaseStatuses(out: string): PhaseStatus[] {
  const planPath = join(out, 'PLAN.json')
  const plan = existsSync(planPath) ? (JSON.parse(readOr(planPath, '{}')) as {
    hazards?: unknown[]
    structural?: unknown[]
    groups?: { status: string }[]
  }) : null

  const batches = existsSync(join(out, 'batches'))
  const todo = existsSync(join(out, 'VERIFY.todo.json'))
  const applied = existsSync(join(out, 'APPLY.json'))

  const pluralPath = join(out, 'PLURALS.todo.json')
  const pluralTodo = existsSync(pluralPath)
    ? ((JSON.parse(readOr(pluralPath, '{"families":[]}')) as { families?: unknown[] }).families ?? []).length
    : 0

  const pending = plan?.groups?.filter((g) => g.status === 'pending').length ?? 0
  const hazards = plan?.hazards?.length ?? 0
  const structural = plan?.structural?.length ?? 0

  return [
    {
      name: 'adjudicate',
      ready: !!plan && hazards > 0,
      ...(plan ? {} : { reason: `no plan yet — run: ${'`plan`'}` }),
      worklist: planPath,
      items: hazards,
      writes: false,
    },
    {
      name: 'translate',
      // Blocked, not merely unready: a hazard reaching a batch is the failure
      // the hazard rule exists to prevent.
      ready: !!plan && batches && hazards === 0 && pending > 0,
      ...(hazards > 0
        ? { reason: `${hazards} open hazard(s) — adjudicate them first` }
        : !batches
          ? { reason: 'no batches yet — run `plan`' }
          : {}),
      worklist: join(out, 'batches'),
      items: Math.ceil(pending / BATCH_SIZE),
      writes: false,
    },
    {
      name: 'review',
      ready: todo,
      ...(todo ? {} : { reason: 'no review worklist — run `verify` after `apply --write`' }),
      worklist: join(out, 'VERIFY.todo.json'),
      items: todo ? (JSON.parse(readOr(join(out, 'VERIFY.todo.json'), '{"pairs":[]}')) as { pairs: unknown[] }).pairs.length : 0,
      writes: false,
    },
    {
      name: 'plural',
      // After `apply --write`, for the same reason `structural` is: this phase
      // edits files, and `apply` is the sole writer until it has finished.
      ready: pluralTodo > 0 && applied,
      ...(pluralTodo === 0
        ? { reason: 'no plural family in this run needs a code edit' }
        : !applied
          ? { reason: 'plural code edits run after `apply --write`, never alongside it' }
          : {}),
      worklist: join(out, 'PLURALS.todo.json'),
      items: pluralTodo,
      writes: true,
    },
    {
      name: 'structural',
      ready: structural > 0 && applied,
      ...(structural === 0
        ? { reason: 'nothing structural in this plan' }
        : !applied
          ? { reason: 'structural edits run after `apply --write`, never alongside it' }
          : {}),
      worklist: planPath,
      items: structural,
      writes: true,
    },
  ]
}

export interface Emitted {
  phase: PhaseName
  files: string[]
  launch: string
  join: string
  advice?: string
}

export function orchestrate(opts: OrchestrateOptions): Emitted {
  const statuses = phaseStatuses(opts.out)
  const phase = opts.phase ?? statuses.find((s) => s.ready)?.name
  if (!phase) throw new Error('no phase is ready — run `scan` and `plan` first')

  const status = statuses.find((s) => s.name === phase)!
  if (!status.ready) {
    const err = new Error(`phase "${phase}" is not ready — ${status.reason ?? 'its worklist does not exist'}`)
    ;(err as Error & { exitCode?: number }).exitCode = 2
    throw err
  }

  const dir = join(opts.out, 'orchestration')
  const agents = join(dir, 'agents')
  mkdirSync(agents, { recursive: true })
  const files: string[] = []

  const contract = CONTRACTS[phase]
  const contractPath = join(agents, `${contract.role}.md`)
  writeFileSync(contractPath, contract.body)
  files.push(contractPath)

  const workflowPath = join(dir, `${phase}.workflow.mjs`)
  writeFileSync(workflowPath, workflowScript(phase, opts, status, contract.role))
  files.push(workflowPath)

  const runbookPath = join(dir, 'RUNBOOK.md')
  writeFileSync(runbookPath, runbook(statuses, opts))
  files.push(runbookPath)

  return {
    phase,
    files,
    launch: `Workflow({ scriptPath: ${JSON.stringify(workflowPath)} })`,
    join: JOINS[phase](opts),
    ...(status.items < SMALL_WORKLIST
      ? { advice: `only ${status.items} item(s) — the sequential path in RUNBOOK.md is cheaper than a fan-out` }
      : {}),
  }
}

const CONTRACTS: Record<PhaseName, { role: string; body: string }> = {
  translate: { role: 'translator', body: TRANSLATOR_CONTRACT },
  adjudicate: {
    role: 'adjudicator',
    body: `# Contract: adjudicator

You resolve hazards: texts that are both displayed copy and an identifier.

For each hazard in the worklist, read the sites it names and rule **per site**,
not per string. Both readings are usually correct — the label should be
translated and the identifier must not be — and the point is to say which site
is which.

Return \`{groupId, sites: [{siteId, verdict, reason}]}\` where verdict is
\`translate\` or \`exclude\` and reason is one line grounded in the code you read.

If the two roles cannot be separated without renaming something, say so: that
is a real finding about the code, not a failure to decide.

**Return your ruling. Do not edit any file.**
`,
  },
  review: {
    role: 'reviewer',
    body: `# Contract: reviewer

You adjudicate translations that have ALREADY been written to the repository.

For each pair, read the cited file at the cited line and judge what is actually
there — not what was intended. Escaping mistakes and wrong-span writes are in
scope precisely because they only exist on disk.

Use exactly one of: \`supported\`, \`partial\`, \`refuted\`, \`unsupported\`.

- \`supported\` — correct, idiomatic, complete; placeholders and host syntax intact
- \`partial\` — the meaning survives but the phrasing is off; counts as support
- \`refuted\` — wrong: mistranslated, inverted, off-glossary, or broken syntax
- \`unsupported\` — not judgeable from the citation, which usually means the
  citation itself is wrong

When unsure, choose the harsher verdict. A false pass is worse than a false fail.

**Return \`{claimId, citation, verdict, note}\`. Do not edit any file.**
`,
  },
  plural: {
    role: 'pluralist',
    body: `# Contract: pluralist

You complete plural families whose forms are already translated and cannot be
written by byte offset — a rule baked into an expression, or a resource format
the engine does not edit.

Each entry in \`PLURALS.todo.json\` gives you \`forms\` (already translated, keyed
by CLDR category), \`targetCategories\` (exactly the forms the target locale
selects), \`file\`, \`anchor\`, and \`count\` where an annotation named the counting
expression.

**Do not translate anything.** The words are decided. Your job is the code:

- Make the call site select among \`targetCategories\` by the count, using the
  platform's own plural API — \`Intl.PluralRules\`, the i18n runtime already in
  the repository, the framework's plural helper. Do not hand-roll \`n > 1\`.
- The number of forms is not the number the source had. English has two and
  Russian has four; a target with one form is complete with one.
- Where the old code built a word out of a conditional suffix, the whole phrase
  becomes one message per form. A suffix cannot express agreement in a language
  that inflects more than the noun.

Edit **only the one file named in your prompt**. This phase runs after
\`apply --write\`, never alongside it.

Return \`{familyId, file, note}\` describing what you changed and why.
`,
  },
  structural: {
    role: 'structuralist',
    body: `# Contract: structuralist

You handle the sites the engine refused, because they need a code edit rather
than a translated string — a plural or agreement rule baked into an expression.

The target language may need a different NUMBER of agreement sites than the
source. French agrees the adjective as well as the noun, so an English
\`\${n > 1 ? 's' : ''}\` becomes two conditionals, not one.

Edit **only the one file named in your prompt**. This is the single place in
this pipeline where an agent writes, and it runs after \`apply --write\`, never
alongside it.

Return \`{siteId, file, note}\` describing what you changed and why.
`,
  },
}

const JOINS: Record<PhaseName, (o: OrchestrateOptions) => string> = {
  adjudicate: (o) => `node ${o.engine} plan --repo ${o.repo} --out ${o.out}`,
  translate: (o) => `node ${o.engine} translate --repo ${o.repo} --out ${o.out} --apply results`,
  review: (o) => `node ${o.engine} verify --repo ${o.repo} --out ${o.out} --apply verdicts.json`,
  plural: (o) => `node ${o.engine} scan --repo ${o.repo} --out ${o.out} && node ${o.engine} plurals --repo ${o.repo} --out ${o.out}`,
  structural: (o) => `node ${o.engine} scan --repo ${o.repo} --out ${o.out} && node ${o.engine} check --repo ${o.repo} --out ${o.out}`,
}

function workflowScript(phase: PhaseName, o: OrchestrateOptions, status: PhaseStatus, role: string): string {
  return `export const meta = {
  name: 'ultrai18n-${phase}',
  description: 'ultrai18n ${phase} phase — ${status.items} item(s)',
  phases: [{ title: '${phase}' }],
}

// Constants are baked in at emit time so this script is reproducible on its
// own, without the state that produced it.
const OUT = ${JSON.stringify(o.out)}
const REPO = ${JSON.stringify(o.repo)}
const ENGINE = ${JSON.stringify(o.engine)}
const WORKLIST = ${JSON.stringify(status.worklist)}
const AGENTS = OUT + '/orchestration/agents'

// ${status.writes
    ? 'This phase WRITES, one file per agent, each owned exclusively.'
    : 'This phase RETURNS fragments. It writes nothing: the fold stays with the orchestrator, because `apply` is the sole writer and runs exactly once after the join.'}
// Do not run \`scan\` or \`plan\` while this fan-out is in flight — replanning
// re-derives group ids, and results would fold into the wrong groups.

const ITEMS = ${JSON.stringify(chunkHint(status.items))}

const results = await parallel(
  ITEMS.map((item, i) => () =>
    agent(
      'Read and follow the dispatch contract at ' + AGENTS + '/${role}.md VERBATIM.\\n' +
      'Constants: OUT=' + OUT + '  REPO=' + REPO + '  WORKLIST=' + WORKLIST + '.\\n' +
      'Your items: ' + item + '\\n' +
      'Invoke the engine only by its absolute path: node ' + ENGINE + ' <cmd> — read-only commands only.',
      { label: '${role}:' + item, phase: '${phase}' },
    ),
  ),
)

// Fold with: ${JOINS[phase](o)}
return results.filter(Boolean)
`
}

function chunkHint(items: number): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.max(1, Math.ceil(items / BATCH_SIZE)); i++) {
    out.push(String(i).padStart(3, '0'))
  }
  return out
}

function runbook(statuses: PhaseStatus[], o: OrchestrateOptions): string {
  const rows = statuses
    .map((s) => `| ${s.name} | ${s.ready ? 'ready' : 'not ready'} | ${s.items} | ${s.reason ?? ''} |`)
    .join('\n')
  return `# Runbook

Every phase can be played by hand. The fan-out is an optimisation, never a
requirement, and the sequential path produces an identical result — only the
wall-clock differs.

| phase | state | items | note |
|---|---|---|---|
${rows}

## Sequential

1. \`node ${o.engine} scan --repo ${o.repo} --out ${o.out}\`
2. \`node ${o.engine} plan --repo ${o.repo} --out ${o.out}\`
3. Resolve anything under HAZARDS. The engine will not guess these: a text that
   is both a label and an identifier has two correct readings and one of them
   destroys stored data.
4. \`node ${o.engine} translate --repo ${o.repo} --out ${o.out} --translator '<cmd>'\`
   — or fill \`${o.out}/results/<id>.result.json\` yourself.
5. \`node ${o.engine} translate --repo ${o.repo} --out ${o.out} --apply results\`
6. \`node ${o.engine} apply --repo ${o.repo} --out ${o.out}\` to see the diff, then
   add \`--write\`.
7. \`node ${o.engine} verify --repo ${o.repo} --out ${o.out}\`, adjudicate, then
   \`verify --apply verdicts.json\`.
8. Any family in \`PLURALS.todo.json\` needs a code edit: its forms are
   translated, and the call site has to select among them with the platform's
   own plural API. \`node ${o.engine} plurals --repo ${o.repo}\` lists them.
9. \`node ${o.engine} check --repo ${o.repo} --out ${o.out} --semantic\`
`
}

function readOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return fallback
  }
}
