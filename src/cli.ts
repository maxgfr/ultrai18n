import { resolve } from 'node:path'
import { VERSION } from './version'
import { runCensus, formatCensus } from './census'

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
  ultrai18n apply      [--write] [--out <dir>] [--json]
  ultrai18n verify     [--apply <verdicts.json>] [--max-verify <n>] [--json]
  ultrai18n check      [--from <lang>] [--to <lang>] [--semantic] [--new-only] [--json]
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

Options:
  --repo <dir>   Repository root (default: cwd)
  --out <dir>    Run directory (default: <repo>/.ultrai18n)
  --json         Machine-readable output on stdout; human lines go to stderr
  --to <lang>    Target language (default: en)

Exit codes:
  0  ok
  1  a gate failed, or the command could not run
  2  usage error, or an orchestrate phase is not ready
`

const COMMANDS = new Set([
  'scan', 'census', 'sites', 'catalog', 'lang', 'adjudicate', 'plan', 'translate',
  'apply', 'verify', 'check', 'sync', 'glossary', 'orchestrate', 'init', 'version',
])

const VALUE_FLAGS = new Set([
  'repo', 'out', 'from', 'to', 'verdict', 'surface', 'file', 'explain', 'ecosystem',
  'rule', 'value', 'batch', 'mode', 'backend', 'translator', 'apply', 'max-verify',
  'catalog', 'source-locale', 'phase', 'sample-rate', 'translator-timeout', 'config',
])

const BOOL_FLAGS = new Set([
  'json', 'dup', 'test', 'write', 'semantic', 'new-only', 'seed', 'list', 'eco',
  'ci', 'hook', 'baseline', 'quiet', 'no-sweep', 'allow-dirty', 'no-git', 'backup',
  'strict', 'help',
])

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
  scan: 'the extractors (ts-ast, json, yaml) are not built yet',
  sites: 'requires `scan`',
  catalog: 'the surface catalog is not built yet',
  lang: 'the language detector is not built yet',
  adjudicate: 'requires `scan`',
  plan: 'requires `scan`',
  translate: 'requires `plan`',
  apply: 'requires `translate`',
  verify: 'requires `apply`',
  check: 'requires `scan` — run `census` for gate G1 alone',
  sync: 'requires the catalog extractors',
  glossary: 'requires `plan`',
  orchestrate: 'requires `plan`',
  init: 'requires `check`',
}

function main(): void {
  const p = parseArgs(process.argv.slice(2))

  if (p.flags.help || (!p.command && p.positional.length === 0)) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  if (!p.command) usage(`unknown command: ${p.positional[0]}`)

  const repo = resolve(String(p.flags.repo ?? process.cwd()))
  const json = p.flags.json === true

  switch (p.command) {
    case 'version':
      process.stdout.write(`${VERSION}\n`)
      return

    case 'census': {
      const result = runCensus(repo)
      if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      } else {
        process.stdout.write(formatCensus(result, repo) + '\n')
      }
      if (!result.ok) process.exit(1)
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

main()
