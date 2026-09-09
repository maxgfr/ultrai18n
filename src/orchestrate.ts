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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSLATOR_CONTRACT } from './translate'
import { DIALECTICIAN_CONTRACT } from './dialects'

export type PhaseName = 'dialect' | 'adjudicate' | 'translate' | 'review' | 'plural' | 'structural'

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
  const plan = readObject<{
    hazards?: unknown
    structural?: unknown
    groups?: unknown
  }>(planPath)

  const batches = exists(join(out, 'batches'))
  const verifyPath = join(out, 'VERIFY.todo.json')
  const verify = readObject<{ pairs?: unknown }>(verifyPath)
  const verifyPairs = countOf(verify?.pairs)
  // `apply` writes APPLY.json on a DRY RUN too — guarding the dry run would be
  // theatre, so the file's existence proves the command ran and never that it
  // wrote. `plural` and `structural` edit files and must not race `apply
  // --write`, so the gate reads the report's own `write` flag rather than the
  // presence of the report. An existence check here would open both phases the
  // moment someone previewed an apply.
  const applied = wroteFiles(join(out, 'APPLY.json'))

  const dialectPath = join(out, 'dialects.todo.json')
  const dialectTodo = countOf(readObject<{ residual?: unknown }>(dialectPath)?.residual)
  const pluralTodo = countOf(readObject<{ families?: unknown }>(join(out, 'PLURALS.todo.json'))?.families)

  const groups: unknown[] = Array.isArray(plan?.groups) ? plan.groups : []
  const pending = groups.filter(
    (g) => typeof g === 'object' && g !== null && (g as { status?: unknown }).status === 'pending',
  ).length
  const hazards = countOf(plan?.hazards)
  const structural = countOf(plan?.structural)

  return [
    {
      // First in the list on purpose: an arrangement nobody claimed is a gap in
      // what the engine UNDERSTANDS, and every later phase reasons about a
      // repository it has already misread.
      name: 'dialect',
      ready: dialectTodo > 0,
      ...(dialectTodo > 0 ? {} : { reason: 'nothing unclaimed — run `dialects --propose` after `scan`' }),
      worklist: dialectPath,
      items: dialectTodo,
      writes: true,
    },
    {
      name: 'adjudicate',
      ready: !!plan && hazards > 0,
      // A plan with no hazard is not a missing worklist. Leaving `reason` unset
      // there let the caller fall back to "its worklist does not exist", which
      // sends the reader looking for a file that is present and correct.
      ...(plan
        ? hazards === 0
          ? { reason: 'no open hazard in this plan — nothing to adjudicate' }
          : {}
        : { reason: `no plan yet — run: ${'`plan`'}` }),
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
          : pending === 0
            // Not "already translated": a plan of purely structural groups
            // reaches this branch with nothing ever having been translated.
            // The reason states what was observed, not what it implies.
            ? { reason: 'no pending group in this plan' }
            : {}),
      worklist: join(out, 'batches'),
      items: Math.ceil(pending / BATCH_SIZE),
      writes: false,
    },
    {
      name: 'review',
      // Ready means there is work, as it does for every other phase — not that
      // the file exists. An empty worklist does not fan out to nothing: the
      // batch labels are floored at one, so it dispatches a single agent with
      // no work, which is worse than not dispatching.
      ready: verifyPairs > 0,
      ...(verifyPairs > 0
        ? {}
        : verify === null
          ? { reason: 'no review worklist — run `verify` after `apply --write`' }
          : { reason: 'no claim/citation pair in the review worklist' }),
      worklist: verifyPath,
      items: verifyPairs,
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

  // `--eco` is the sequential low-token path: the RUNBOOK below is the whole
  // deliverable, so the fan-out script is not written — and a stale one from an
  // earlier non-eco emission is removed rather than left to be launched by
  // mistake. Emission stays idempotent: what is on disk after a run is exactly
  // what that run asked for.
  const workflowPath = join(dir, `${phase}.workflow.mjs`)
  if (opts.eco) {
    rmSync(workflowPath, { force: true })
  } else {
    writeFileSync(workflowPath, workflowScript(phase, opts, status, contract.role))
    files.push(workflowPath)
  }

  const runbookPath = join(dir, 'RUNBOOK.md')
  writeFileSync(runbookPath, runbook(statuses, opts))
  files.push(runbookPath)

  return {
    phase,
    files,
    launch: opts.eco
      ? `follow ${runbookPath} sequentially, playing each role yourself`
      : `Workflow({ scriptPath: ${JSON.stringify(workflowPath)} })`,
    join: JOINS[phase](opts),
    ...(status.items < SMALL_WORKLIST
      ? { advice: `only ${status.items} item(s) — the sequential path in RUNBOOK.md is cheaper than a fan-out` }
      : {}),
  }
}

/** The contract text for one phase, so a command can write it without re-stating it. */
export function contractFor(phase: PhaseName): string {
  return CONTRACTS[phase].body
}

const CONTRACTS: Record<PhaseName, { role: string; body: string }> = {
  dialect: { role: 'dialectician', body: DIALECTICIAN_CONTRACT },
  translate: { role: 'translator', body: TRANSLATOR_CONTRACT },
  adjudicate: {
    role: 'adjudicator',
    body: `# Contract: adjudicator

You resolve hazards: texts that are both displayed copy and an identifier.

For each hazard in the worklist, read the sites it names and rule **per site**,
not per string. Both readings are usually correct — the label should be
translated and the identifier must not be — and the point is to say which site
is which.

Return, for each hazard:

\`\`\`json
{ "groupId": "g_…",
  "sites": [
    { "siteId": "ul_…",
      "verdict": "translate" | "exclude",
      "reason": "<one token from the closed vocabulary below, for exclude>",
      "justification": "<one line grounded in the code you read>" }
  ] }
\`\`\`

\`reason\` and \`justification\` are two different fields on purpose. The reason is
a token \`check\` can gate on; the justification is where your prose goes. Prose
in \`reason\` is refused, and a ruling with no justification is refused — an
exception without one is a place to hide.

Rule on EVERY site in the group. A half-answered hazard is refused whole,
because the point of this phase is that the label and the identifier get
different answers; an unruled site is not a default.

Reasons for \`exclude\`: identifier · module-specifier · enum-member ·
persisted-value · api-contract · interop-format · url-or-slug · style-token ·
aria-vocabulary · test-fixture · vendored-legal · code-token ·
numeric-or-symbolic · proper-noun · escaping-fixture

If the two roles cannot be separated without renaming something, say so as data
— \`{ "groupId": "g_…", "unseparable": true, "justification": "…" }\`. That is a
real finding about the code, not a failure to decide.

**Return your ruling. Do not edit any file.** The engine stamps the
\`contentHash\`, so your ruling voids itself if the text is later rewritten.
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

Return \`{familyId, file, note}\` describing what you changed and why, and write
the collected returns to \`<out>/PLURALS.returns.json\`.

Your return is a CLAIM THAT AN EDIT WAS MADE, and it is verified. The join
re-scans and \`plurals --apply\` asserts that each family you named now has every
form its target locale selects. A family you report and did not edit fails
there; so does a family handed to you and never reported on, because silence is
not success. If a family cannot be completed, say so in the note and leave it
out of the returns rather than claiming it.
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

Return \`{siteId, file, note}\` describing what you changed and why, and write the
collected returns to \`<out>/STRUCTURAL.json\`.

Your return is a CLAIM THAT AN EDIT WAS MADE, and it is verified. \`check\` folds
that file in and fails when a site you named still carries its grammar hole. The
site id comes from the anchor rather than from the text, so it survives the edit
— which is exactly what makes the claim checkable.
`,
  },
}

const JOINS: Record<PhaseName, (o: OrchestrateOptions) => string> = {
  dialect: (o) =>
    `node ${o.engine} dialects --check --repo ${o.repo} --out ${o.out} && node ${o.engine} scan --repo ${o.repo} --out ${o.out}${languageFlags(o.out)}`,
  adjudicate: (o) => `node ${o.engine} plan --repo ${o.repo} --out ${o.out}`,
  translate: (o) => `node ${o.engine} translate --repo ${o.repo} --out ${o.out} --apply results`,
  review: (o) => `node ${o.engine} verify --repo ${o.repo} --out ${o.out} --apply verdicts.json`,
  // Re-scan, THEN verify the claims against what the re-scan sees. Re-scanning
  // and not comparing is what let a reported edit nobody made pass.
  plural: (o) =>
    `node ${o.engine} scan --repo ${o.repo} --out ${o.out}${languageFlags(o.out)} && ` +
    `node ${o.engine} plurals --repo ${o.repo} --out ${o.out} --apply ${o.out}/PLURALS.returns.json`,
  structural: (o) =>
    `node ${o.engine} scan --repo ${o.repo} --out ${o.out}${languageFlags(o.out)} && node ${o.engine} check --repo ${o.repo} --out ${o.out}`,
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

const ITEMS = ${JSON.stringify(fanOutUnits(status))}

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

/**
 * How many units this phase dispatches. `translate` is the odd one out: its
 * `items` is already a BATCH count (`phaseStatuses` divided the pending groups
 * by BATCH_SIZE), so chunking it again drops every batch after the first — 16
 * pending groups are two batches, and a second division emits one. Every other
 * phase reports raw work items and is chunked here.
 */
function fanOutUnits(status: PhaseStatus): string[] {
  return chunkHint(status.name === 'translate' ? status.items : Math.ceil(status.items / BATCH_SIZE))
}

/** One label per unit the fan-out dispatches, zero-padded so they sort. */
function chunkHint(units: number): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.max(1, units); i++) {
    out.push(String(i).padStart(3, '0'))
  }
  return out
}

/**
 * The `--from`/`--to` this run was scanned with, as flags ready to paste.
 *
 * Every command this module prints for a human to run is executed in a shell
 * that holds none of the run's state, so an omitted flag is silently
 * re-defaulted at the moment the command is pasted. A rescan without these
 * rebuilds the inventory against the DEFAULT target: a run translated into
 * Russian, rescanned bare, comes back as if it had targeted the default, and
 * the plan is overwritten on top of it. The commands run, they exit 0, and the
 * damage is a retargeted run rather than an error.
 *
 * Read through `readObject`, like every artefact this module reads: a missing,
 * unreadable or malformed inventory yields no flags rather than throwing,
 * because this is called while building the text of a status command.
 */
function languageFlags(out: string): string {
  const inv = readObject<{ sourceLanguage?: unknown; targetLanguage?: unknown }>(join(out, 'inventory.json'))
  const from = languageTag(inv?.sourceLanguage)
  const to = languageTag(inv?.targetLanguage)
  return (from ? ` --from ${from}` : '') + (to ? ` --to ${to}` : '')
}

/**
 * A value is a language tag only if it LOOKS like one.
 *
 * These flags are interpolated into a command string a human pastes into a
 * shell, so the type check is not the check that matters: `"ru; rm -rf ."` and
 * `"ru --out /elsewhere"` are both strings, and both survive a `typeof` guard
 * to become a second command or a second option at paste time. A BCP-47 tag is
 * letters, digits and separators and nothing else, so accepting exactly that
 * shape removes the class rather than escaping around it. The underscore is in
 * the separator set deliberately: `scan --to ru_RU` is accepted and stored, so
 * a hyphen-only pattern would drop a tag the run really was scanned with and
 * silently hand back a rescan that reverts to the default. An underscore is not
 * a shell metacharacter, so widening here costs nothing.
 *
 * A value outside the shape is omitted rather than escaped. `scan` stores what
 * it is given without this validation, so such a tag can genuinely be the run's
 * — dropping it degrades the printed command to the bare form the caller can
 * complete, which is the safe direction to fail in.
 */
function languageTag(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9]{1,8}([-_][A-Za-z0-9]{1,8})*$/.test(value) ? value : null
}

/**
 * Did `apply` actually WRITE, or was it a preview?
 *
 * The report is written on a dry run too — guarding a dry run would be theatre
 * — so its existence proves the command ran and never that it wrote. `plural`
 * and `structural` edit files and must not race `apply --write`, so they gate
 * on the report's own `write` flag. Every failure to establish that flag reads
 * as "not applied": an unreadable, empty, malformed or `null` report is not
 * evidence that a write happened, and it must not take `orchestrate --list`
 * down with it either — a status command that throws on a corrupt artefact
 * hides every other phase's state behind one bad file.
 */
function wroteFiles(reportPath: string): boolean {
  return readObject<{ write?: unknown }>(reportPath)?.write === true
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

1. \`node ${o.engine} scan --repo ${o.repo} --out ${o.out}${languageFlags(o.out)}\`
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

/**
 * Read a JSON object, or nothing.
 *
 * `phaseStatuses` is what `orchestrate --list` calls to report the state of a
 * run, so it is the one function that must survive a corrupt artefact: a
 * malformed PLAN.json taking the whole status path down hides every other
 * phase's state behind one bad file, at exactly the moment someone is trying to
 * find out what went wrong. Absent, unreadable, malformed, `null`, array and
 * non-object bodies all read the same way — as nothing — because none of them
 * is evidence that the phase is ready.
 */
function readObject<T>(path: string): T | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as T) : null
  } catch {
    return null
  }
}

/** `existsSync` cannot be trusted to return rather than throw under a permission model. */
function exists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * How many entries a worklist field holds.
 *
 * Only an array is a worklist, and only its non-null entries are counted. A
 * string has a `length`, so does an object that happens to carry one, and both
 * used to be counted — turning a malformed artefact into a phase that looks
 * ready with a plausible item count. `[null]` is the same defect one level
 * down: an array of holes is length 1 and no work at all.
 *
 * The filter stops there, deliberately: it does not validate what an entry
 * CONTAINS, so `["", false, 0]` still counts three. Deciding whether an entry
 * is a usable work item belongs to the phase that consumes it, and a count
 * that silently dropped malformed entries would report a worklist shorter than
 * the one the agents are handed.
 */
function countOf(value: unknown): number {
  return Array.isArray(value) ? value.filter((entry) => entry !== null && entry !== undefined).length : 0
}
