// Command implementations and the run directory they share.
//
// Every artifact is a file on disk with a stable shape. That is not
// bookkeeping: it is what lets the pipeline be driven by a person, by a shell
// script, by an agent, or by all three in turn — and what makes `--backend
// manual` a first-class path rather than a fallback.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Inventory } from './types'
import { plan as buildPlan, type Group, type Plan } from './plan'
import {
  buildBatches, foldResults, runCliBackend, runApiBackend, parseResult, TRANSLATOR_CONTRACT,
  type Batch, type BatchResult,
} from './translate'
import { apply, type Translation } from './apply'

export interface RunDir {
  root: string
  inventory: string
  plan: string
  batches: string
  results: string
  translations: string
  glossary: string
  applyReport: string
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

  const p = buildPlan(inventory, { mode, glossary: new Map([...glossary].map(([k, v]) => [k, v.text])) })
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

export async function cmdTranslateApi(opts: TranslateOptions & { api?: ApiConfig }): Promise<TranslateOutcome> {
  const dirs = runDir(opts.out)
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const batches = readBatches(dirs.batches)
  mkdirSync(dirs.results, { recursive: true })
  const wrote: string[] = []
  const failed: string[] = []
  for (const batch of batches) {
    try {
      const result = await runApiBackend(batch, {
        endpoint: opts.api?.endpoint ?? 'https://api.anthropic.com/v1/messages',
        model: opts.api?.model ?? 'claude-haiku-4-5-20251001',
        keyEnv: opts.api?.keyEnv ?? 'ANTHROPIC_API_KEY',
        headers: { 'anthropic-version': '2023-06-01', ...opts.api?.headers },
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
  return { backend: 'api', batches: batches.length, wrote }
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
} {
  const dirs = runDir(out)
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const batches = readBatches(dirs.batches)
  const results = readResults(dirs.results)
  const glossary = readGlossary(dirs.glossary)

  const report = foldResults(results, { groups: p.groups, glossary, batches })

  const byGroup = new Map(p.groups.map((g) => [g.id, g]))
  const translations: Translation[] = []
  for (const accepted of report.accepted) {
    const group = byGroup.get(accepted.groupId)
    if (!group) continue
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

  writeJson(dirs.translations, { schemaVersion: 1, translations, report })
  return {
    accepted: report.accepted.length,
    rejected: report.rejected.length,
    refused: report.refused.length,
    missing: report.missing.length,
    translations,
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function cmdApply(repo: string, out: string, write: boolean, recover: boolean) {
  const dirs = runDir(out)
  const inventory = readJson<Inventory>(dirs.inventory, 'inventory.json')
  const p = readJson<Plan>(dirs.plan, 'PLAN.json')
  const { translations } = readJson<{ translations: Translation[] }>(dirs.translations, 'TRANSLATIONS.json')

  const groups = p.groups
    .filter((g) => g.status === 'pending' || g.status === 'memo')
    .map((g) => [...g.sites, ...g.mirrors])

  const report = apply({ repo, inventory, translations, write, recover, groups })
  writeJson(dirs.applyReport, report)
  return report
}
