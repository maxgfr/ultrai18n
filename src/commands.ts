// Command implementations and the run directory they share.
//
// Every artifact is a file on disk with a stable shape. That is not
// bookkeeping: it is what lets the pipeline be driven by a person, by a shell
// script, by an agent, or by all three in turn — and what makes `--backend
// manual` a first-class path rather than a fallback.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Inventory, Site } from './types'
import { plan as buildPlan, type Group, type Plan } from './plan'
import {
  keyForCategory, scanIcu, serializeArgument, splice, type PluralFamily,
} from './plural'
import { scanFluentPattern, serializeSelect } from './plural/fluent'
import {
  buildBatches, foldResults, runCliBackend, runApiBackend, parseResult, TRANSLATOR_CONTRACT,
  type Batch, type BatchResult,
} from './translate'
import { apply, type ApplyReport, type Insertion, type Translation } from './apply'
import { guardWorkingTree } from './git'
import { readAdjudications } from './adjudicate'
import { resolveProvider, type ProviderOverrides, type ResolvedProvider } from './provider'

export interface RunDir {
  root: string
  inventory: string
  plan: string
  batches: string
  results: string
  translations: string
  glossary: string
  applyReport: string
  exceptions: string
  backup: string
}

export function runDir(out: string): RunDir {
  return {
    root: out,
    inventory: join(out, 'inventory.json'),
    plan: join(out, 'PLAN.json'),
    batches: join(out, 'batches'),
    results: join(out, 'results'),
    translations: join(out, 'TRANSLATIONS.json'),
    glossary: join(out, 'glossary.md'),
    applyReport: join(out, 'APPLY.json'),
    exceptions: join(out, 'exceptions.json'),
    // Inside the run directory, which the walker already ignores by name, so a
    // kept original never becomes a site on the next scan.
    backup: join(out, 'backup'),
  }
}

export function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${path} — run the step that produces it first`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// glossary — human-owned, never overwritten
// ---------------------------------------------------------------------------

const GEN_OPEN = '<!-- ul:gen key=proposals -->'
const GEN_CLOSE = '<!-- /ul:gen key=proposals -->'

export interface GlossaryEntry {
  text: string
  pin: boolean
}

/**
 * Read the human-authored term store.
 *
 * The table between the human fences is authoritative and survives every
 * regeneration byte for byte. A tool that rewrites the file its user curates
 * gets curated once and then abandoned.
 */
export function readGlossary(path: string): Map<string, GlossaryEntry> {
  const out = new Map<string, GlossaryEntry>()
  if (!existsSync(path)) return out
  const text = readFileSync(path, 'utf8')
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const [, src, tgt, pin] = cells
    if (!src || !tgt || src === 'source' || /^-+$/.test(src)) continue
    out.set(src, { text: tgt, pin: /^(yes|y|true|x)$/i.test(pin ?? '') })
  }
  return out
}

export function writeGlossary(path: string, existing: string | null, proposals: Group[]): string {
  const rows = proposals
    .slice(0, 20)
    .map((g) => `| ${g.text.replace(/\|/g, '\\|')} |  |  | ${g.role} |`)
    .join('\n')
  const generated = [
    GEN_OPEN,
    '',
    '_Proposals: the most frequent untranslated terms. Fill a target to pin one, then move the row above._',
    '',
    '| source | target | pin | role |',
    '|---|---|---|---|',
    rows,
    '',
    GEN_CLOSE,
  ].join('\n')

  if (existing && existing.includes(GEN_OPEN) && existing.includes(GEN_CLOSE)) {
    const before = existing.slice(0, existing.indexOf(GEN_OPEN))
    const after = existing.slice(existing.indexOf(GEN_CLOSE) + GEN_CLOSE.length)
    return before + generated + after
  }

  return [
    '# Glossary',
    '',
    'Everything between the human markers is yours. It is never rewritten, and it',
    'wins over the translation memory and over any model.',
    '',
    '<!-- ul:human key=terms -->',
    '',
    '| source | target | pin | note |',
    '|---|---|---|---|',
    '',
    '<!-- /ul:human key=terms -->',
    '',
    generated,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

export function cmdPlan(out: string, mode: Plan['mode']): { plan: Plan; batches: Batch[] } {
  const dirs = runDir(out)
  const inventory = readJson<Inventory>(dirs.inventory, 'inventory.json')
  const glossary = readGlossary(dirs.glossary)

  const p = buildPlan(inventory, {
    mode,
    glossary: new Map([...glossary].map(([k, v]) => [k, v.text])),
    // Rulings an adjudicator folded in. Absent on a first run, which is why a
    // hazard is a hazard until somebody answers it.
    adjudications: readAdjudications(join(out, 'adjudications.json')),
  })
  writeJson(dirs.plan, p)

  const batches = buildBatches(p.groups, {
    sourceLang: p.sourceLang,
    targetLang: p.targetLang,
    project: { name: projectName(inventory.repo) },
    glossary,
  })

  mkdirSync(dirs.batches, { recursive: true })
  for (const batch of batches) {
    writeJson(join(dirs.batches, `${batch.batchId}.batch.json`), batch)
  }

  mkdirSync(join(out, 'agents'), { recursive: true })
  writeFileSync(join(out, 'agents', 'translator.md'), TRANSLATOR_CONTRACT)

  const existing = existsSync(dirs.glossary) ? readFileSync(dirs.glossary, 'utf8') : null
  writeFileSync(dirs.glossary, writeGlossary(dirs.glossary, existing, p.groups.filter((g) => g.status === 'pending')))

  return { plan: p, batches }
}

function projectName(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? 'project'
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------

export interface TranslateOptions {
  out: string
  backend: 'subagent' | 'cli' | 'api' | 'manual'
  translator?: string
  repo: string
  timeoutMs?: number
}

export interface TranslateOutcome {
  backend: string
  batches: number
  wrote: string[]
  /** Set when the engine cannot itself invoke the backend and hands over instead. */
  handoff?: string
}

export interface ApiConfig {
  endpoint?: string
  model?: string
  keyEnv?: string
  headers?: Record<string, string>
}

export async function cmdTranslateApi(
  opts: TranslateOptions & {
    /** Already resolved, so the caller can show it before spending anything. */
    resolved?: ResolvedProvider
    provider?: ProviderOverrides
    configPath?: string
  },
): Promise<TranslateOutcome & { provider: ResolvedProvider }> {
  const provider = opts.resolved ?? resolveProvider(opts.repo, opts.provider ?? {}, opts.configPath)
  const dirs = runDir(opts.out)
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const batches = readBatches(dirs.batches)
  mkdirSync(dirs.results, { recursive: true })
  const wrote: string[] = []
  const failed: string[] = []
  for (const batch of batches) {
    try {
      const result = await runApiBackend(batch, {
        provider,
        sourceLang: p.sourceLang,
        targetLang: p.targetLang,
        contract: TRANSLATOR_CONTRACT,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
      const path = join(dirs.results, `${batch.batchId}.result.json`)
      writeJson(path, result)
      wrote.push(path)
    } catch (err) {
      failed.push(`${batch.batchId}: ${(err as Error).message}`)
    }
  }
  if (failed.length) {
    writeJson(join(opts.out, 'FAILED.json'), { failed })
    throw new Error(`${failed.length} of ${batches.length} batches failed — see FAILED.json; re-run to retry only those`)
  }
  return { backend: 'api', batches: batches.length, wrote, provider }
}

export function cmdTranslate(opts: TranslateOptions): TranslateOutcome {
  const dirs = runDir(opts.out)
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const batches = readBatches(dirs.batches)

  if (batches.length === 0) {
    return { backend: opts.backend, batches: 0, wrote: [], handoff: 'nothing to translate' }
  }

  if (opts.backend === 'cli') {
    if (!opts.translator) throw new Error("--backend cli needs --translator '<command>'")
    mkdirSync(dirs.results, { recursive: true })
    const wrote: string[] = []
    const failed: string[] = []
    for (const batch of batches) {
      try {
        const result = runCliBackend(batch, {
          command: opts.translator,
          cwd: opts.repo,
          sourceLang: p.sourceLang,
          targetLang: p.targetLang,
          ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        })
        const path = join(dirs.results, `${batch.batchId}.result.json`)
        writeJson(path, result)
        wrote.push(path)
      } catch (err) {
        // A failed batch is not a failed run: the others are still good, and
        // re-running sends only what is still missing.
        failed.push(`${batch.batchId}: ${(err as Error).message}`)
      }
    }
    if (failed.length) {
      writeJson(join(opts.out, 'FAILED.json'), { failed })
      throw new Error(`${failed.length} of ${batches.length} batches failed — see FAILED.json; re-run to retry only those`)
    }
    return { backend: 'cli', batches: batches.length, wrote }
  }

  // subagent and manual both stop here, and for the same honest reason: the
  // engine cannot dispatch a Claude Code subagent, and it will not pretend to.
  // The artifacts are complete and usable either way.
  return {
    backend: opts.backend,
    batches: batches.length,
    wrote: [],
    handoff:
      opts.backend === 'subagent'
        ? `${batches.length} batch(es) written. Dispatch one agent per batch following ${join(opts.out, 'agents/translator.md')}, then write each answer to ${dirs.results}/<id>.result.json and run \`translate --apply\`.`
        : `${batches.length} batch(es) written to ${dirs.batches}. Fill ${dirs.results}/<id>.result.json, then run \`translate --apply\`.`,
  }
}

export function readBatches(dir: string): Batch[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.batch.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Batch)
}

export function readResults(dir: string): BatchResult[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8')
      const parsed = parseResult(raw, f.replace(/\..*$/, ''))
      if (!parsed) throw new Error(`${join(dir, f)} is not a valid batch result`)
      return parsed
    })
}

/** Fold results into TRANSLATIONS.json, expanding one group into its sites. */
export function cmdTranslateApply(out: string): {
  accepted: number
  rejected: number
  refused: number
  missing: number
  translations: Translation[]
  insertions: Insertion[]
  structural: number
} {
  const dirs = runDir(out)
  const inventory = readJson<Inventory>(dirs.inventory, 'inventory.json')
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const batches = readBatches(dirs.batches)
  const results = readResults(dirs.results)
  const glossary = readGlossary(dirs.glossary)

  const report = foldResults(results, { groups: p.groups, glossary, batches })

  const byGroup = new Map(p.groups.map((g) => [g.id, g]))
  const families = new Map(
    ((inventory.plurals ?? []) as PluralFamily[]).map((f) => [f.id, f]),
  )
  const bySiteId = new Map(inventory.sites.map((s) => [s.id, s]))

  const translations: Translation[] = []
  const insertions: Insertion[] = []
  const structural: StructuralTodo[] = []

  for (const accepted of report.accepted) {
    const group = byGroup.get(accepted.groupId)
    if (!group) continue

    if (group.plural && accepted.forms) {
      const family = families.get(group.plural.familyId)
      if (!family) continue
      const written = writeFamily(family, accepted.forms, bySiteId)
      translations.push(...written.translations)
      insertions.push(...written.insertions)
      if (written.todo) structural.push(written.todo)
      continue
    }

    // One translation, every site it belongs to — including the test
    // assertions that mirror it, so CI never sees a half-translated state.
    for (const id of [...group.sites, ...group.mirrors]) {
      translations.push({ id, text: accepted.text })
    }
  }
  // Groups already known from the glossary or memory never went to a model.
  for (const group of p.groups) {
    if (group.status !== 'memo' || !group.memo) continue
    for (const id of [...group.sites, ...group.mirrors]) {
      translations.push({ id, text: group.memo.text })
    }
  }

  writeJson(dirs.translations, { schemaVersion: 1, translations, insertions, report })
  if (structural.length) writeJson(join(out, 'PLURALS.todo.json'), { schemaVersion: 1, families: structural })

  return {
    accepted: report.accepted.length,
    rejected: report.rejected.length,
    refused: report.refused.length,
    missing: report.missing.length,
    translations,
    insertions,
    structural: structural.length,
  }
}

/** A family whose forms are translated and whose write is a code edit. */
export interface StructuralTodo {
  familyId: string
  file: string
  anchor: string
  shape: string
  why: string
  count: string | null
  forms: Record<string, string>
  targetCategories: string[]
}

/**
 * Turn a family's translated forms into writes.
 *
 * Three outcomes, and which one applies is decided by the shape, not by the
 * translation:
 *
 *  - `replace` — every form lives inside one value. Rebuild that value whole,
 *    which is how an ICU family can go from two branches to four without
 *    anything special happening.
 *  - `insert`  — each form is its own key. Forms that exist are rewritten in
 *    place; forms the target needs and the file has never had become new
 *    siblings.
 *  - `code-edit` — the forms are correct and cannot be written from here. They
 *    go to a worklist WITH their translations, because the person or agent
 *    making that edit should not have to translate it again.
 */
function writeFamily(
  family: PluralFamily,
  forms: Record<string, string>,
  bySiteId: Map<string, Site>,
): { translations: Translation[]; insertions: Insertion[]; todo?: StructuralTodo } {
  const target = family.targetRequired ?? family.sourceCategories

  if (family.writeMode === 'code-edit') {
    return {
      translations: [],
      insertions: [],
      todo: {
        familyId: family.id,
        file: family.file,
        anchor: family.anchor,
        shape: family.shape,
        why: family.blocked ?? 'this family cannot be written by byte offset',
        count: family.count,
        forms,
        targetCategories: [...target],
      },
    }
  }

  if (family.writeMode === 'replace') {
    const siteId = family.sites[0]
    const site = siteId ? bySiteId.get(siteId) : undefined
    if (!site) return { translations: [], insertions: [] }
    // The join is the FALLBACK, not the default. A grammar-backed family that
    // reaches it gets its branches flattened into a `|`-separated string — for
    // Fluent that means a valid select expression overwritten with
    // `One unread message | { $count } unread messages`, which is not a
    // degraded rendering but a corrupted file. Every `replace` primitive needs
    // a serializer here before its row ships.
    const rebuilt =
      family.primitive === 'icu'
        ? rebuildIcu(site.value, family, forms, target)
        : family.primitive === 'fluent'
          ? rebuildFluent(site.value, family, forms, target)
          : [...target].map((c) => forms[c] ?? '').join(family.join ?? ' | ')
    return rebuilt === null
      ? { translations: [], insertions: [] }
      : { translations: [{ id: site.id, text: rebuilt }], insertions: [] }
  }

  // insert
  const byCategory = new Map(family.forms.map((f) => [f.category, f]))
  const translations: Translation[] = []
  const insertions: Insertion[] = []
  const anchor = family.insertAfterSiteId
  let order = 0
  for (const category of target) {
    const text = forms[category]
    if (text === undefined) continue
    const existing = byCategory.get(category)
    if (existing) {
      translations.push({ id: existing.siteId, text })
      continue
    }
    const key = keyForCategory(family, category)
    if (!anchor || !key) continue
    insertions.push({ afterSiteId: anchor, key, text, order: order++ })
  }
  return { translations, insertions }
}

/** Rebuild an ICU message with the target's branches in place of the source's. */
function rebuildIcu(
  value: string,
  family: PluralFamily,
  forms: Record<string, string>,
  target: readonly string[],
): string | null {
  const scan = scanIcu(value)
  if (!scan.ok) return null
  const at = /@(\d+)$/.exec(family.base)
  const argument = at
    ? scan.arguments.find((a) => a.start === Number(at[1]))
    : scan.arguments.find((a) => a.type !== 'select')
  if (!argument) return null

  const bodies: Record<string, string> = {}
  for (const branch of argument.branches) {
    // `=0` and friends are exact matches the engine never asked anyone to
    // rewrite; they ride through unchanged.
    if (branch.selector.startsWith('=')) bodies[branch.selector] = branch.body
  }
  for (const category of target) {
    if (forms[category] !== undefined) bodies[category] = forms[category]!
  }

  return splice(value, [
    { start: argument.start, end: argument.end, text: serializeArgument(argument, bodies, [...target]) },
  ])
}

/**
 * Rebuild a Fluent select with the target's variants in place of the source's.
 *
 * The Fluent twin of `rebuildIcu`, and the reason `fluent.select-expression`
 * may declare `write: replace` at all: en→ru turns two variants into four
 * inside one value, and the only alternative to a serializer is a delimiter
 * join that would destroy the syntax.
 */
function rebuildFluent(
  value: string,
  family: PluralFamily,
  forms: Record<string, string>,
  target: readonly string[],
): string | null {
  const scan = scanFluentPattern(value)
  if (!scan.ok) return null
  const at = /@(\d+)$/.exec(family.base)
  const select = at
    ? scan.selects.find((s) => s.start === Number(at[1]))
    : scan.selects.find((s) => s.selectorKind !== 'reference')
  if (!select) return null

  const bodies: Record<string, string> = {}
  // Numeric variant keys are exact matches nobody was asked to rewrite.
  for (const variant of select.variants) {
    if (variant.kind === 'number') bodies[variant.key] = variant.body
  }
  for (const category of target) {
    if (forms[category] !== undefined) bodies[category] = forms[category]!
  }

  const exactKeys = select.variants.filter((v) => v.kind === 'number').map((v) => v.key)
  const rebuilt = serializeSelect(select, bodies, [...exactKeys, ...target])
  return value.slice(0, select.start) + rebuilt + value.slice(select.end)
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface ApplyFlags {
  write: boolean
  recover: boolean
  backup?: boolean
  allowDirty?: boolean
  noGit?: boolean
}

export function cmdApply(repo: string, out: string, flags: ApplyFlags) {
  const { write, recover } = flags
  const dirs = runDir(out)
  const inventory = readJson<Inventory>(dirs.inventory, 'inventory.json')
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const { translations, insertions = [] } = readJson<{
    translations: Translation[]
    insertions?: Insertion[]
  }>(dirs.translations, 'TRANSLATIONS.json')

  const groups = p.groups
    .filter((g) => g.status === 'pending' || g.status === 'memo')
    .map((g) => [...g.sites, ...g.mirrors])

  // Only `--write` is guarded: a dry run mutates nothing, and guarding it would
  // be theatre. When the guard refuses, nothing is written and the caller
  // reports it as a command that could not run.
  let vcs: ApplyReport['vcs']
  if (write) {
    const guard = guardWorkingTree(repo, {
      allowDirty: flags.allowDirty === true,
      noGit: flags.noGit === true,
    })
    if (!guard.ok) throw new Error(guard.message)
    vcs = { state: guard.state, bypassedBy: guard.bypassedBy }
  }

  const report = apply({
    repo, inventory, translations, insertions, write, recover, groups,
    ...(flags.backup ? { backupDir: dirs.backup } : {}),
    ...(vcs ? { vcs } : {}),
  })
  writeJson(dirs.applyReport, report)
  return report
}
