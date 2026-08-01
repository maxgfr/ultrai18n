// The `dialects` command: list, explain, check, and hand the residual to an agent.
//
// This is the half of the plural design a model participates in, and the shape
// of that participation is the point. The model does NOT decide, per site,
// which keys are a family — that answer could not be cached, could not be
// re-run, and would cost per key rather than per library. It writes a
// DECLARATION: a data row saying how this repository spells a plural, which the
// engine then executes deterministically and validates.
//
// One thing does widen, and it should be said rather than smoothed over. The
// dialectician's worklist carries residual VALUES and sibling values, because an
// arrangement is not recognisable from a path alone. So "the model only ever
// sees `{id, text}`" stops being true of every agent in this pipeline. It never
// opens a file, the sample is bounded and deterministic, and the translator's
// contract is untouched — but the claim is now narrower than it was, and
// pretending otherwise would be the kind of quiet overstatement this tool exists
// to refuse.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isBundleFile, readProjectDialects } from './scan'
import { detectFamilies, DIALECTS, mergeDialects, ordered, type PluralDialect } from './plural'
import { checkDialects, type DialectProblem } from './plural/dialect/check'
import { evidenceFor, gatherEvidence, type Fact, type RepoEvidence } from './plural/dialect/evidence'
import type { Inventory, Site } from './types'
import type { Suspicion } from './plural/suspect'

/** How many residual sites the worklist carries. Bounded, so the artifact is. */
const SAMPLE = 40

export interface DialectsView {
  id: string
  title: string
  docs: string
  primitive: string
  precedence: number
  shape: string
  cldr: boolean
  declaredBy: 'shipped' | 'project'
  /** Whether this repository's evidence admits it. */
  active: boolean
  /** The manifest lines supporting it. */
  cites: Fact[]
  /** How many families it claimed here. */
  families: number
}

export function viewDialects(repo: string, inventory: Inventory, dialectsPath?: string): DialectsView[] {
  const project = readProjectDialects(dialectsPath ?? join(repo, '.ultrai18n', 'dialects.json'))
  const catalog = mergeDialects(project)
  const evidence = gatherEvidence(repo, inventory.census.map((c) => c.file), inventory.sites)

  const claimed = new Map<string, number>()
  for (const family of inventory.plurals ?? []) {
    if (!family.dialect) continue
    claimed.set(family.dialect, (claimed.get(family.dialect) ?? 0) + 1)
  }

  return ordered(catalog).map((d) => {
    const verdict = evidenceFor(d, evidence)
    return {
      id: d.id,
      title: d.title,
      docs: d.docs,
      primitive: d.primitive,
      precedence: d.precedence,
      shape: d.shape,
      cldr: d.cldr,
      declaredBy: d.declaredBy,
      active: verdict.applies,
      cites: verdict.cites,
      families: claimed.get(d.id) ?? 0,
    }
  })
}

/** Which dialects apply to one file, and why. */
export function explainFile(
  repo: string,
  inventory: Inventory,
  file: string,
  dialectsPath?: string,
): { dialect: DialectsView; reason: string }[] {
  const bundle = isBundleFile(file)
  return viewDialects(repo, inventory, dialectsPath)
    .flatMap((view) => {
      const d = mergeDialects(readProjectDialects(dialectsPath ?? join(repo, '.ultrai18n', 'dialects.json')))
        .find((x) => x.id === view.id)!
      if (!view.active) return [{ dialect: view, reason: 'inert: its declared evidence is absent from this repository' }]
      if (d.where.bundleOnly && !bundle) return []
      if (d.where.file?.length && !d.where.file.some((g) => file.endsWith(g.replace(/^\*\*\//, '').replace(/^\*/, '')))) return []
      const cited = view.cites.map((c) => `${c.file}:${c.line}`).join(', ')
      return [
        {
          dialect: view,
          reason: cited ? `applies, cited by ${cited}` : 'applies',
        },
      ]
    })
}

export function runCheck(repo: string, inventory: Inventory, dialectsPath?: string): DialectProblem[] {
  const path = dialectsPath ?? join(repo, '.ultrai18n', 'dialects.json')
  if (!existsSync(path)) return []
  const project = readProjectDialects(path)
  if (project.length === 0) {
    return [{ dialect: '(file)', problem: `${path} declares no readable dialect — a row with a bad regex is dropped here and reported nowhere else` }]
  }
  return checkDialects({
    shipped: DIALECTS,
    project,
    sites: inventory.sites,
    detect: (dialects) =>
      detectFamilies(inventory.sites, { isBundle: isBundleFile, dialects: dialects.filter((d) => d.declaredBy === 'project') }),
  })
}

// ---------------------------------------------------------------------------

export interface DialectsTodo {
  schemaVersion: 1
  evidence: {
    dependencies: Fact[]
    imports: Fact[]
    configFiles: string[]
  }
  claimed: { dialects: string[]; families: number }
  residual: {
    id: string
    file: string
    line: number
    path: string
    value: string
    signals: string[]
    siblings: { path: string; value: string }[]
  }[]
  /** How many suspicions the sample left out, so the cap is never silent. */
  residualTotal: number
  primitives: { id: string; reads: string; parameters: string[] }[]
}

export function buildTodo(repo: string, inventory: Inventory): DialectsTodo {
  const evidence = gatherEvidence(repo, inventory.census.map((c) => c.file), inventory.sites)
  const residual = (inventory.pluralResidual ?? []) as Suspicion[]

  return {
    schemaVersion: 1,
    evidence: {
      dependencies: [...evidence.dependencies.values()],
      imports: [...evidence.imports.values()],
      configFiles: [...evidence.files].filter((f) => /i18n|locale|intl|translat/i.test(f)).slice(0, 40),
    },
    claimed: {
      dialects: [...new Set((inventory.plurals ?? []).map((f) => f.dialect).filter((d): d is string => !!d))],
      families: (inventory.plurals ?? []).length,
    },
    // Sorted by siteKey and capped, so the artifact is bounded and identical
    // across runs. An unbounded worklist on a large repository is a file nobody
    // reads and a prompt nobody can afford.
    residual: residual.slice(0, SAMPLE).map((s) => ({
      id: s.siteId,
      file: s.file,
      line: s.line,
      path: s.path,
      value: s.value,
      signals: s.signals,
      siblings: s.siblings,
    })),
    residualTotal: residual.length,
    primitives: PRIMITIVE_HELP,
  }
}

const PRIMITIVE_HELP = [
  {
    id: 'path-part',
    reads: 'One form per site, with the category read off the site anchor path.',
    parameters: [
      'split.kind: "leaf-suffix" (item_one) | "leaf-is-token" (item/one) | "path-regex"',
      'split.separators: e.g. ["_", "."] — leaf-suffix only',
      'split.re: two capture groups, base then token — path-regex only, given as a string',
      'tokens: { "<native token>": "<CLDR category>" }',
      'order: { <form count>: [<category>, ...] } — for NUMERIC tokens like msgstr[0]',
      'ordinalInfix: e.g. ["ordinal"]',
      'minForms: distinct categories needed before this is a family (default 1)',
      'selectorTemplate: how the selector reads in a report, e.g. \'quantity="{token}"\'',
    ],
  },
  {
    id: 'value-split',
    reads: 'Every form in one value, separated by a literal, categorised by position.',
    parameters: [
      'delimiters: e.g. ["||||"] — tried longest first',
      'order: { <part count>: [<category>, ...] }',
      'requiresCounting: true keeps "Save | Cancel" out',
      'trim: default true',
    ],
  },
  {
    id: 'icu',
    reads: 'Every form in one value, categorised by the ICU MessageFormat parser.',
    parameters: ['ordinals: whether selectordinal is read as ordinal (default true)'],
  },
]

export const DIALECTICIAN_CONTRACT = `# Contract: dialectician

You declare how this repository spells its plurals. You do not translate, and you
do not edit source.

\`dialects.todo.json\` gives you three things: the EVIDENCE this repository carries
— its declared dependencies, its config files, the modules it imports — the
arrangements the shipped catalog already CLAIMED, and the RESIDUAL: sites that
look like a plural to a signal knowing nothing about any library, which no
dialect claimed.

For each residual, do exactly one of:

- name the shipped dialect that should have claimed it, and say what stopped it;
- write a dialect row;
- say it is not a plural, and why.

A row you write must:

- pick one \`primitive\`: \`path-part\`, \`value-split\` or \`icu\`. If none of them can
  read the arrangement, SAY SO. A primitive is TypeScript and you cannot write one
  here — claiming otherwise produces a row that validates and reads nothing.
- carry \`docs\`: an http(s) URL to the runtime's OWN documentation of this
  arrangement. Not a blog post, not an answer site, not a plausible-looking URL
  you have not read. A row without a citation is a hunch, and \`dialects --check\`
  rejects one. The engine has no network and cannot verify the page exists, so
  this is a promise a human will check in the diff.
- set \`cldr: false\` unless the arrangement's selectors ARE CLDR categories.
  Positional schemes and gettext indices are not, and claiming otherwise makes the
  engine report rendering bugs that do not exist.
- claim at least one residual IN THIS REPOSITORY, and change nothing that already
  works. A row that claims nothing here is speculation about somebody else's
  repository; a row that re-reads an existing family differently is rejected
  unless it names what it \`overrides\`.

Write the rows to \`.ultrai18n/dialects.json\` as
\`{ "schemaVersion": 1, "dialects": [ ... ] }\`, then stop. Regexes are strings.

**Do not edit any other file.**
`

export function writeTodo(out: string, todo: DialectsTodo): { todo: string; contract: string } {
  mkdirSync(join(out, 'agents'), { recursive: true })
  const todoPath = join(out, 'dialects.todo.json')
  const contractPath = join(out, 'agents', 'dialectician.md')
  writeFileSync(todoPath, JSON.stringify(todo, null, 2) + '\n')
  writeFileSync(contractPath, DIALECTICIAN_CONTRACT)
  return { todo: todoPath, contract: contractPath }
}

export function formatDialects(views: DialectsView[]): string {
  const lines: string[] = []
  lines.push(`ultrai18n dialects — ${views.length} row(s), ${views.filter((v) => v.active).length} active`)
  lines.push('')
  for (const v of views) {
    const mark = v.active ? ' ' : '·'
    lines.push(
      `${mark} ${String(v.precedence).padStart(3)} ${v.id.padEnd(26)} ${v.primitive.padEnd(12)} ` +
        `${v.families ? `${v.families} famil${v.families === 1 ? 'y' : 'ies'}` : '—'}` +
        `${v.declaredBy === 'project' ? '  [project]' : ''}` +
        `${v.cldr ? '' : '  [not CLDR]'}`,
    )
    if (v.cites.length) lines.push(`      evidence: ${v.cites.map((c) => `${c.name} (${c.file}:${c.line})`).join(', ')}`)
    if (!v.active) lines.push('      inert: its declared evidence is absent')
  }
  lines.push('')
  lines.push('· = inert in this repository')
  return lines.join('\n')
}

export function formatTodo(todo: DialectsTodo, paths: { todo: string; contract: string }): string {
  const lines: string[] = []
  lines.push(
    `ultrai18n dialects --propose — ${todo.residual.length} of ${todo.residualTotal} unclaimed site(s), ` +
      `${todo.claimed.families} family(ies) already claimed`,
  )
  if (todo.residualTotal > todo.residual.length) {
    // Never a silent cap: a worklist that quietly drops half its findings reads
    // as "that is all of them".
    lines.push(`  sampled ${todo.residual.length}, capped at ${SAMPLE} — ${todo.residualTotal - todo.residual.length} not shown`)
  }
  lines.push('')
  if (todo.residualTotal === 0) {
    lines.push('  Nothing is unclaimed. There is no dialect to declare.')
    return lines.join('\n')
  }
  for (const r of todo.residual.slice(0, 8)) {
    lines.push(`  ${r.file}:${r.line}  [${r.signals.join(', ')}]`)
    lines.push(`      ${r.path} = ${JSON.stringify(r.value.slice(0, 70))}`)
  }
  if (todo.residual.length > 8) lines.push(`  … and ${todo.residual.length - 8} more in the worklist`)
  lines.push('')
  lines.push(`  wrote ${paths.todo}`)
  lines.push(`  wrote ${paths.contract}`)
  lines.push('')
  lines.push('  Dispatch one agent following that contract, then run `dialects --check`.')
  return lines.join('\n')
}

export function formatProblems(problems: DialectProblem[]): string {
  if (problems.length === 0) return 'ultrai18n dialects --check  ok'
  const lines = [`ultrai18n dialects --check  ${problems.length} problem(s)`, '']
  for (const p of problems) lines.push(`  ${p.dialect}\n      ${p.problem}`)
  return lines.join('\n')
}

export type { Site }
