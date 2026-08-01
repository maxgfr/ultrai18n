import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { VERSION } from './version'
import { runCensus, formatCensus } from './census'
import { scan } from './scan'
import { formatScan, formatPlurals } from './report'
import { DIALECTS, ordered, pluralTier, type PluralFamily } from './plural'
import { checkCatalog, matchRules } from './catalog/match'
import { RULES } from './catalog/rules'
import { formatPlan } from './plan'
import { formatApply } from './apply'
import { cmdPlan, cmdTranslate, cmdTranslateApi, cmdTranslateApply, cmdApply, runDir, readJson } from './commands'
import { check, formatCheck, readExceptions } from './check'
import { buildVerify, applyVerdicts, checkSemantic, formatVerifyTodo, type VerifyTodo, type VerifyResult } from './verify'
import { orchestrate, phaseStatuses, type PhaseName } from './orchestrate'
import { sync, formatSync } from './sync'
import { init, loadBaseline, type Baseline } from './init'
import { writeJson } from './commands'
import type { Plan } from './plan'
import type { Inventory } from './types'
import { existsSync } from 'node:fs'
import { formatProviders, resolveProvider, type ProviderOverrides } from './provider'
import { buildTodo, explainFile, formatDialects, formatProblems, formatTodo, runCheck, viewDialects, writeTodo } from './dialects'

const HELP = `ultrai18n v${VERSION} — find every human-readable string, and prove nothing was missed

Usage:
  ultrai18n scan       [--repo <dir>] [--from auto|<lang>] [--to <lang>] [--out <dir>] [--json]
  ultrai18n census     [--repo <dir>] [--json]
  ultrai18n sites      [--verdict <v>] [--surface <glob>] [--file <glob>] [--dup] [--json]
  ultrai18n catalog    [--explain <file>] [--ecosystem <id>] [--rule <id>] [--json]
  ultrai18n lang       [--value "<text>"] [--test] [--json]
  ultrai18n adjudicate [--out <dir>] [--batch <n>]
  ultrai18n plan       [--out <dir>] [--mode audit|swap|i18n|sync] [--json]
  ultrai18n translate  [--backend <k>] [--translator '<cmd>'] [--apply "<glob>"] [--json]
                       [--provider <id>] [--model <name>] [--endpoint <url>] [--key-env <VAR>]
  ultrai18n apply      [--write] [--out <dir>] [--json]
  ultrai18n verify     [--apply <verdicts.json>] [--max-verify <n>] [--json]
  ultrai18n check      [--from <lang>] [--to <lang>] [--semantic] [--new-only] [--json]
  ultrai18n plurals    [--repo <dir>] [--out <dir>] [--json]
  ultrai18n dialects   [--explain <file>] [--check] [--propose] [--json]
  ultrai18n sync       [--catalog <glob>] [--source-locale <lang>] [--json]
  ultrai18n glossary   [--seed] [--list] [--json]
  ultrai18n orchestrate [--phase <name>] [--eco] [--list]
  ultrai18n init       [--ci] [--hook] [--baseline]
  ultrai18n version

Commands:
  census      Account for every tracked path: scanned, empty, or skipped with a
              reason. The denominator is \`git ls-files\`, not the walker, because
              the walker's own exclusions are what needs auditing. Exits 1 when
              any tracked path is unaccounted for (gate G1).

  plurals     Every plural family, with the forms its own locale selects and the
              forms it actually has. Exits 1 when one is short — that is a wrong
              string rendering today, not a missing translation.

  dialects    How this repository spells its plurals: the shipped catalog plus
              anything \`.ultrai18n/dialects.json\` declares, with the manifest
              line supporting each. \`--propose\` writes the sites no dialect
              claimed, for an agent to declare; \`--check\` validates what it
              wrote, and rejects a row that cites nothing, claims nothing, or
              re-reads a family that already worked.

Translation backend (everything is overridable; --flag beats ULTRAI18N_* env
beats .ultrai18n/config.json beats the provider preset):
  --provider     anthropic | openai | openai-compatible  (default: anthropic)
  --model        Defaults to the provider's SMALL tier — that is the whole point:
                 eight short strings and a one-page contract per batch is not
                 work a frontier model does better.
  --endpoint     Any URL. With --provider openai-compatible this reaches Ollama,
                 vLLM, LM Studio or a company gateway.
  --key-env      Name of the environment variable holding the key. A localhost
                 endpoint may have none.
  --max-tokens   Response cap (default 4096)

Options:
  --repo <dir>   Repository root (default: cwd)
  --out <dir>    Run directory (default: <repo>/.ultrai18n)
  --json         Machine-readable output on stdout; human lines go to stderr
  --to <lang>    Target language (default: en)
  --quiet        Print only each command's VERDICT line. Never changes --json
                 output, never suppresses an error, never changes an exit code.
  --strict       check: make a WEAKENED CLAIM a failure — a file read without
                 its full tier, a decision taken at low confidence, an exception
                 with no contentHash. Widens G1/G3/G5; adds no gate id.
  --backup       apply --write: keep each original under <out>/backup/ first.
                 Inside the run directory on purpose — a .bak beside the source
                 is walked by the next scan and becomes a phantom duplicate.
  --allow-dirty  apply --write: proceed although the working tree is dirty.
  --no-git       apply --write: proceed although this is not a git repository,
                 and skip the dirty check. You are asserting git is not the
                 safety net here.

There is deliberately no --no-sweep. The residual sweep is what makes G2
checkable, and a run with it disabled looks clean while proving nothing.

Exit codes:
  0  ok
  1  a gate failed, or the command could not run
  2  usage error, or an orchestrate phase is not ready
`

const COMMANDS = new Set([
  'dialects',
  'scan', 'census', 'sites', 'catalog', 'lang', 'adjudicate', 'plan', 'translate',
  'apply', 'verify', 'check', 'sync', 'plurals', 'glossary', 'orchestrate', 'init', 'version',
])

const VALUE_FLAGS = new Set([
  'repo', 'out', 'from', 'to', 'verdict', 'surface', 'file', 'explain', 'ecosystem',
  'rule', 'value', 'batch', 'mode', 'backend', 'translator', 'apply', 'max-verify',
  'catalog', 'source-locale', 'phase', 'sample-rate', 'translator-timeout', 'config',
  'provider', 'model', 'endpoint', 'key-env', 'max-tokens',
])

const BOOL_FLAGS = new Set([
  'json', 'dup', 'test', 'write', 'semantic', 'new-only', 'seed', 'list', 'eco',
  'ci', 'hook', 'baseline', 'quiet', 'allow-dirty', 'no-git', 'backup',
  'strict', 'help', 'no-ast', 'no-recover', 'propose', 'check',
])

/**
 * Flags this build deliberately does NOT accept, and why.
 *
 * Rejected with the argument rather than with `unknown flag`, because somebody
 * typing one has a reason and deserves an answer instead of a shrug.
 */
const RETIRED: Record<string, string> = {
  'no-sweep':
    'the residual sweep is what makes G2 checkable — "nothing was dropped without a recorded reason". ' +
    'A run with it disabled looks clean and proves nothing, which is worse than a run that fails.',
}

interface Parsed {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
}

function fail(msg: string): never {
  process.stderr.write(`ultrai18n: ${msg}\n`)
  process.exit(1)
}

function usage(msg: string): never {
  process.stderr.write(`ultrai18n: ${msg}\n`)
  process.exit(2)
}

export function parseArgs(argv: string[]): Parsed {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      const eq = body.indexOf('=')
      const name = eq === -1 ? body : body.slice(0, eq)
      if (VALUE_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : body.slice(eq + 1)
        if (value === undefined) usage(`--${name} needs a value`)
        flags[name] = value
      } else if (BOOL_FLAGS.has(name)) {
        flags[name] = true
      } else if (RETIRED[name]) {
        usage(`--${name} was removed: ${RETIRED[name]}`)
      } else {
        usage(`unknown flag: --${name}`)
      }
      continue
    }
    if (!command && COMMANDS.has(arg)) command = arg
    else positional.push(arg)
  }
  return { command, positional, flags }
}

/** Commands the design specifies but this build does not yet implement. */
const PENDING: Record<string, string> = {
  sites: 'requires `scan`',
  lang: 'wired into `scan`; a standalone command is not built yet',
  adjudicate: 'requires `scan`',
  glossary: 'requires `plan`',
}

async function main(): Promise<void> {
  const p = parseArgs(process.argv.slice(2))

  if (p.flags.help || (!p.command && p.positional.length === 0)) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (!p.command) usage(`unknown command: ${p.positional[0]}`)

  const repo = resolve(String(p.flags.repo ?? process.cwd()))
  const json = p.flags.json === true
  const quiet = p.flags.quiet === true

  /**
   * A human report, reduced to its verdict line when `--quiet`.
   *
   * One rule for every command rather than a per-command switch, and three
   * things it deliberately never does: it does not touch `--json` output, it
   * does not suppress an error, and it does not change an exit code. What it
   * removes is narration; what it keeps is the answer.
   */
  const say = (full: string): void => {
    const text = quiet ? (full.trimEnd().split('\n').pop() ?? '') : full
    process.stdout.write(text + '\n')
  }
  /** Progress narration. Silenced entirely by `--quiet`; errors never come here. */
  const note = (text: string): void => {
    if (!quiet) process.stderr.write(text)
  }

  switch (p.command) {
    case 'version':
      process.stdout.write(`${VERSION}\n`)
      return

    case 'census': {
      const result = runCensus(repo)
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } else {
        say(formatCensus(result, repo))
      }
      if (!result.ok) process.exitCode = 1
      return
    }

    case 'catalog': {
      const problems = checkCatalog(RULES)
      const explain = p.flags.explain
      if (typeof explain === 'string') {
        const applicable = RULES.filter((r) =>
          matchRules([r], { file: explain, path: '', value: '' }).length > 0 ||
          matchRules([r], { file: explain, path: '/description', value: '', key: 'description' }).length > 0,
        )
        const payload = applicable.map((r) => ({ id: r.id, title: r.title, docs: r.docs, notes: r.notes }))
        if (json) process.stdout.write(JSON.stringify({ file: explain, rules: payload }, null, 2) + '\n')
        else {
          process.stdout.write(`ultrai18n catalog — rules that apply to ${explain}\n\n`)
          if (payload.length === 0) process.stdout.write('  none\n')
          for (const r of payload) {
            process.stdout.write(`  ${r.id}\n    ${r.title}\n${r.docs ? `    ${r.docs}\n` : ''}`)
          }
        }
        return
      }
      if (json) process.stdout.write(JSON.stringify({ rules: RULES.length, problems }, null, 2) + '\n')
      else {
        process.stdout.write(`ultrai18n catalog: ${RULES.length} rules, ${problems.length} problem(s)\n`)
        for (const p of problems) process.stdout.write(`  ${p.rule}: ${p.problem}\n`)
      }
      if (problems.length) process.exitCode = 1
      return
    }

    case 'scan': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const inv = await scan({
        repo,
        from: p.flags.from === undefined ? 'auto' : String(p.flags.from),
        to: String(p.flags.to ?? 'en'),
        noAst: p.flags['no-ast'] === true,
      })
      mkdirSync(out, { recursive: true })
      // Sorted keys and no timestamp: an unchanged repo must produce a
      // byte-identical inventory, or "nothing changed" is unprovable.
      writeFileSync(join(out, 'inventory.json'), JSON.stringify(inv, null, 2) + '\n')
      if (json) process.stdout.write(JSON.stringify(inv, null, 2) + '\n')
      else {
        say(formatScan(inv))
        note(`\nwrote ${join(out, 'inventory.json')}\n`)
      }
      return
    }

    case 'plan': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const mode = String(p.flags.mode ?? 'swap') as 'audit' | 'swap' | 'i18n' | 'sync'
      const { plan: result, batches } = cmdPlan(out, mode)
      if (json) process.stdout.write(JSON.stringify({ ...result, batches: batches.length }, null, 2) + '\n')
      else {
        say(formatPlan(result))
        note(`\nwrote ${batches.length} batch(es) to ${runDir(out).batches}\n`)
      }
      // A hazard or an unlinked assertion is a decision the engine will not
      // make. Exiting 0 here would let a pipeline sail past it.
      if (result.hazards.length || result.unlinked.length) process.exitCode = 1
      return
    }

    case 'translate': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      if (p.flags.apply !== undefined) {
        const folded = cmdTranslateApply(out)
        if (json) process.stdout.write(JSON.stringify(folded, null, 2) + '\n')
        else {
          process.stdout.write(
            `ultrai18n translate --apply: ${folded.accepted} accepted, ${folded.rejected} rejected, ` +
              `${folded.refused} refused, ${folded.missing} missing → ${folded.translations.length} site patches\n`,
          )
        }
        if (folded.rejected || folded.missing) process.exitCode = 1
        return
      }
      const backend = String(p.flags.backend ?? (p.flags.translator ? 'cli' : 'subagent')) as
        'subagent' | 'cli' | 'api' | 'manual'
      if (backend === 'api') {
        const overrides: ProviderOverrides = {
          ...(p.flags.provider ? { provider: String(p.flags.provider) } : {}),
          ...(p.flags.model ? { model: String(p.flags.model) } : {}),
          ...(p.flags.endpoint ? { endpoint: String(p.flags.endpoint) } : {}),
          ...(p.flags['key-env'] ? { keyEnv: String(p.flags['key-env']) } : {}),
          ...(p.flags['max-tokens'] ? { maxTokens: Number(p.flags['max-tokens']) } : {}),
        }
        // Resolved and PRINTED before a single request is sent. Which model is
        // about to run, and where each setting came from, is the thing you want
        // to see before spending money — not after, and not only on success.
        const resolved = resolveProvider(repo, overrides, p.flags.config ? String(p.flags.config) : undefined)
        if (!json) note(formatProviders(resolved) + '\n\n')

        const outcome = await cmdTranslateApi({
          out, backend, repo,
          resolved,
          ...(p.flags['translator-timeout'] ? { timeoutMs: Number(p.flags['translator-timeout']) * 1000 } : {}),
        })
        if (json) process.stdout.write(JSON.stringify(outcome, null, 2) + '\n')
        else {
          process.stdout.write(`ultrai18n translate: backend api, ${outcome.batches} batch(es)\n`)
          for (const w of outcome.wrote) process.stdout.write(`  wrote ${w}\n`)
        }
        return
      }
      const outcome = cmdTranslate({
        out,
        backend,
        repo,
        ...(p.flags.translator ? { translator: String(p.flags.translator) } : {}),
        ...(p.flags['translator-timeout'] ? { timeoutMs: Number(p.flags['translator-timeout']) * 1000 } : {}),
      })
      if (json) process.stdout.write(JSON.stringify(outcome, null, 2) + '\n')
      else {
        process.stdout.write(`ultrai18n translate: backend ${outcome.backend}, ${outcome.batches} batch(es)\n`)
        if (outcome.handoff) process.stdout.write(`  ${outcome.handoff}\n`)
        for (const w of outcome.wrote) process.stdout.write(`  wrote ${w}\n`)
      }
      return
    }

    case 'apply': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const report = cmdApply(repo, out, {
        write: p.flags.write === true,
        recover: p.flags['no-recover'] !== true,
        backup: p.flags.backup === true,
        allowDirty: p.flags['allow-dirty'] === true,
        noGit: p.flags['no-git'] === true,
      })
      if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      else say(formatApply(report))
      if (!report.ok) process.exitCode = 1
      return
    }

    case 'verify': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const todoPath = join(out, 'VERIFY.todo.json')
      if (p.flags.apply !== undefined) {
        const todo = readJson<VerifyTodo>(todoPath, 'VERIFY.todo.json')
        const verdicts = readJson<{ verdicts?: unknown[] } | unknown[]>(
          resolve(String(p.flags.apply)),
          'the verdicts file',
        )
        const list = (Array.isArray(verdicts) ? verdicts : verdicts.verdicts ?? []) as never[]
        const result = applyVerdicts({ todo, verdicts: list })
        writeJson(join(out, 'VERIFY.json'), result)
        if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        else {
          process.stdout.write(
            `ultrai18n verify: ${result.ok ? '✓' : '✗'} ` +
              Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(' · ') + '\n',
          )
          for (const f of result.failures) process.stdout.write(`  ✗ ${f.claimId} (${f.citation}): ${f.note}\n`)
        }
        if (!result.ok) process.exitCode = 1
        return
      }
      const inventory = readJson<Inventory>(runDir(out).inventory, 'inventory.json')
      const planned = readJson<Plan>(runDir(out).plan, 'PLAN.json')
      const todo = buildVerify({
        repo,
        inventory,
        plan: planned,
        ...(p.flags['max-verify'] ? { maxVerify: Number(p.flags['max-verify']) } : {}),
        ...(p.flags['sample-rate'] ? { sampleRate: Number(p.flags['sample-rate']) } : {}),
      })
      writeJson(todoPath, todo)
      writeFileSync(join(out, 'VERIFY.md'), formatVerifyTodo(todo))
      if (json) process.stdout.write(JSON.stringify(todo, null, 2) + '\n')
      else {
        process.stdout.write(`ultrai18n verify: ${todo.pairs.length} pair(s) to adjudicate\n`)
        process.stdout.write(`  not reviewed: ${todo.notReviewed.groups} — ${todo.notReviewed.reason}\n`)
        note(`  wrote ${todoPath} and VERIFY.md\n`)
      }
      return
    }

    case 'orchestrate': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const engine = resolve(process.argv[1] ?? 'ultrai18n.mjs')
      if (p.flags.list) {
        const statuses = phaseStatuses(out)
        process.stdout.write(JSON.stringify(statuses, null, 2) + '\n')
        return
      }
      try {
        const emitted = orchestrate({
          repo,
          out,
          engine,
          ...(p.flags.phase ? { phase: String(p.flags.phase) as PhaseName } : {}),
          ...(p.flags.eco ? { eco: true } : {}),
        })
        if (json) process.stdout.write(JSON.stringify(emitted, null, 2) + '\n')
        else {
          process.stdout.write(`ultrai18n orchestrate: phase ${emitted.phase}\n`)
          for (const f of emitted.files) process.stdout.write(`  wrote ${f}\n`)
          if (emitted.advice) process.stdout.write(`  ${emitted.advice}\n`)
        }
        note(`\nlaunch:   ${emitted.launch}\njoin:     ${emitted.join}\n`)
      } catch (err) {
        const code = (err as Error & { exitCode?: number }).exitCode ?? 1
        process.stderr.write(`ultrai18n: ${(err as Error).message}\n`)
        process.exitCode = code
      }
      return
    }

    case 'dialects': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const inventory = readJson<Inventory>(runDir(out).inventory, 'inventory.json')

      if (p.flags.check === true) {
        const problems = runCheck(repo, inventory)
        if (json) process.stdout.write(JSON.stringify({ problems, ok: problems.length === 0 }, null, 2) + '\n')
        else say(formatProblems(problems))
        if (problems.length) process.exitCode = 1
        return
      }

      if (p.flags.propose === true) {
        const todo = buildTodo(repo, inventory)
        const paths = writeTodo(out, todo)
        if (json) process.stdout.write(JSON.stringify(todo, null, 2) + '\n')
        else say(formatTodo(todo, paths))
        // Always 0. `--propose` reports work to be done; it has not failed at
        // anything, and a non-zero exit here would stop a pipeline that is
        // running exactly as intended.
        return
      }

      const explain = p.flags.explain
      if (typeof explain === 'string') {
        const applicable = explainFile(repo, inventory, explain)
        if (json) process.stdout.write(JSON.stringify({ file: explain, dialects: applicable }, null, 2) + '\n')
        else {
          process.stdout.write(`ultrai18n dialects — what applies to ${explain}\n\n`)
          if (applicable.length === 0) process.stdout.write('  none\n')
          for (const a of applicable) {
            process.stdout.write(`  ${a.dialect.id}\n      ${a.reason}\n      ${a.dialect.docs}\n`)
          }
        }
        return
      }

      const views = viewDialects(repo, inventory)
      const problems = runCheck(repo, inventory)
      if (json) process.stdout.write(JSON.stringify({ dialects: views, problems }, null, 2) + '\n')
      else {
        say(formatDialects(views))
        if (problems.length) process.stdout.write('\n' + formatProblems(problems) + '\n')
      }
      if (problems.length) process.exitCode = 1
      return
    }

    case 'plurals': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const inventory = readJson<Inventory>(runDir(out).inventory, 'inventory.json')
      const families = (inventory.plurals ?? []) as PluralFamily[]
      const incomplete = families.filter((f) => f.missing.length || f.extra.length)
      if (json) {
        process.stdout.write(
          JSON.stringify(
            {
              repo,
              targetLanguage: inventory.targetLanguage,
              tier: pluralTier(),
              dialects: ordered(DIALECTS).map((d) => ({
                id: d.id,
                title: d.title,
                docs: d.docs,
                primitive: d.primitive,
                shape: d.shape,
                cldr: d.cldr,
              })),
              families,
              incomplete: incomplete.map((f) => f.id),
              ok: incomplete.length === 0,
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        say(formatPlurals(inventory))
      }
      if (incomplete.length) process.exitCode = 1
      return
    }

    case 'sync': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const inventory = readJson<Inventory>(runDir(out).inventory, 'inventory.json')
      const report = sync({
        repo,
        inventory,
        ...(p.flags['source-locale'] ? { sourceLocale: String(p.flags['source-locale']) } : {}),
        statePath: join(out, 'catalog-state.json'),
      })
      if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      else say(formatSync(report))
      if (!report.ok) process.exitCode = 1
      return
    }

    case 'init': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const inventory = readJson<Inventory>(runDir(out).inventory, 'inventory.json')
      const report = check({ repo, inventory, exceptions: readExceptions(join(out, 'exceptions.json')) })
      const result = init({
        repo,
        out,
        ci: p.flags.ci === true,
        hook: p.flags.hook === true,
        ...(p.flags.baseline ? { baseline: report } : {}),
      })
      if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      else {
        for (const f of result.written) process.stdout.write(`  wrote ${f}\n`)
        for (const n of result.notes) process.stdout.write(`  ${n}\n`)
        if (!result.written.length) process.stdout.write('  nothing to do — pass --ci, --hook or --baseline\n')
      }
      return
    }

    case 'check': {
      const out = resolve(String(p.flags.out ?? join(repo, '.ultrai18n')))
      const inventory = readJson<Inventory>(runDir(out).inventory, 'inventory.json')
      const exceptions = readExceptions(join(out, 'exceptions.json'))
      const baselinePath = join(out, 'baseline.json')
      const baseline = existsSync(baselinePath)
        ? loadBaseline(readJson<Baseline>(baselinePath, 'baseline.json'))
        : undefined
      const report = check({
        repo, inventory, exceptions,
        strict: p.flags.strict === true,
        ...(baseline ? { baseline } : {}),
      })

      if (p.flags.semantic) {
        const todoPath = join(out, 'VERIFY.todo.json')
        const resultPath = join(out, 'VERIFY.json')
        const semantic = checkSemantic({
          repo,
          inventory,
          todo: existsSync(todoPath) ? readJson<VerifyTodo>(todoPath, 'VERIFY.todo.json') : null,
          result: existsSync(resultPath) ? readJson<VerifyResult>(resultPath, 'VERIFY.json') : null,
        })
        if (!semantic.ok) {
          report.ok = false
          report.exitCode = 1
          report.gates.push({
            // G8, not G6. Two gates sharing an id made `fingerprint()` collide
            // across them, so baselining a coherence finding silently baselined
            // a semantic one with the same site and message, and vice versa.
            id: 'G8',
            name: 'semantic',
            ok: false,
            count: semantic.findings.length,
            findings: semantic.findings.map((message) => ({ message })),
          })
        }
      }
      if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      else say(formatCheck(report))
      process.exitCode = report.exitCode
      return
    }

    default: {
      const why = PENDING[p.command]
      // Say what is missing rather than printing an empty result. A command that
      // silently succeeds with no findings is indistinguishable from a clean
      // repo, which is the exact confusion this tool exists to remove.
      fail(`\`${p.command}\` is not implemented in this build — ${why}`)
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ultrai18n: ${(err as Error).message}\n`)
  process.exit(1)
})
