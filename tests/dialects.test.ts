// The loop that lets a model teach the engine an arrangement it has never seen.
//
// engine  → "2 sites smell like a plural, nothing claims them"
// model   → .ultrai18n/dialects.json
// engine  → validates, then finds 2 families citing that row
//
// The model writes a DECLARATION, not an answer. That is what makes the result
// cacheable, re-runnable and checkable — and what keeps the cost proportional to
// the number of libraries rather than the number of keys.
//
// The four rejection tests are the load-bearing half. A validator that accepts
// anything shaped like JSON turns "the model handles plurals" into "the model
// is trusted", which is the posture this whole tool exists to replace.
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitAll, emptyRepo, removeRepo } from '../evals/isolate'
import { scan } from '../src/scan'
import { check } from '../src/check'
import { buildTodo, runCheck, viewDialects } from '../src/dialects'
import type { Inventory } from '../src/types'

// A hand-rolled scheme no shipped dialect reads: `_sg` and `_pl` are not CLDR
// categories and not any runtime's spelling of them. Chosen deliberately over a
// real library's arrangement, because the moment one of those ships as a row the
// fixture stops testing what it was written to test.
const BUNDLE = 'src/locales/en/common.json'
const CATALOG = JSON.stringify(
  {
    cart: { item_sg: '{n} article', item_pl: '{n} articles' },
    inbox: { message_sg: '{n} message', message_pl: '{n} messages' },
  },
  null,
  2,
)

const HOUSE_STYLE = {
  id: 'house.sg-pl-suffix',
  ecosystem: 'in-house',
  title: 'Hand-rolled _sg / _pl key suffix',
  docs: 'https://example.com/handbook/i18n#plurals',
  primitive: 'path-part',
  precedence: 60,
  where: { bundleOnly: true },
  evidence: { mode: 'declared', dependency: ['house-i18n'] },
  read: {
    primitive: 'path-part',
    split: { kind: 'leaf-suffix', separators: ['_'] },
    tokens: { sg: 'one', pl: 'other' },
    minForms: 2,
  },
  write: { mode: 'insert', keyTemplate: '{base}{sep}{category}', insertableWhen: { file: ['**/*.json'] } },
  cldr: true,
  shape: 'key-suffix',
  declaredBy: 'project',
}

async function repoWith(
  dialects: unknown[] | null,
  opts: { dependency?: boolean } = {},
): Promise<{ repo: string; inventory: Inventory }> {
  const repo = emptyRepo('dialects')
  mkdirSync(join(repo, BUNDLE, '..'), { recursive: true })
  writeFileSync(join(repo, BUNDLE), CATALOG)
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'shop',
      dependencies: opts.dependency === false ? {} : { 'house-i18n': '^1.0.0' },
    }),
  )
  commitAll(repo)
  if (dialects) {
    mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
    writeFileSync(join(repo, '.ultrai18n', 'dialects.json'), JSON.stringify({ schemaVersion: 1, dialects }))
  }
  return { repo, inventory: await scan({ repo, from: 'en', to: 'ru' }) }
}

describe('before anything is declared', () => {
  it('reports the unclaimed sites and fails G7', async () => {
    const { repo, inventory } = await repoWith(null)
    try {
      expect(inventory.plurals).toHaveLength(0)
      // Four, not two: `sibling-suffix-pair` flags BOTH members of each pair,
      // because either one alone is the site somebody has to look at.
      expect(inventory.pluralResidual).toHaveLength(4)
      expect(check({ repo, inventory }).gates.find((g) => g.id === 'G7')!.ok).toBe(false)
    } finally {
      removeRepo(repo)
    }
  }, 60_000)

  it('hands an agent the evidence, the residual and the primitives', async () => {
    const { repo, inventory } = await repoWith(null)
    try {
      const todo = buildTodo(repo, inventory)
      expect(todo.residual).toHaveLength(4)
      expect(todo.residualTotal).toBe(4)
      // Values and siblings, because an arrangement is not recognisable from a
      // path alone — the one place this design widens what a model may see.
      expect(todo.residual[0]!.value).toContain('{n}')
      expect(todo.evidence.dependencies.map((d) => d.name)).toContain('house-i18n')
      expect(todo.primitives.map((p) => p.id)).toEqual(['path-part', 'value-split', 'icu'])
    } finally {
      removeRepo(repo)
    }
  }, 60_000)
})

describe('after a good row is declared', () => {
  it('validates, claims the sites, and closes G7', async () => {
    const { repo, inventory } = await repoWith([HOUSE_STYLE])
    try {
      expect(runCheck(repo, inventory)).toEqual([])
      expect(inventory.plurals).toHaveLength(2)
      expect(inventory.plurals.every((f) => f.dialect === 'house.sg-pl-suffix')).toBe(true)
      expect(inventory.pluralResidual).toHaveLength(0)
      expect(check({ repo, inventory }).gates.find((g) => g.id === 'G7')!.ok).toBe(true)
    } finally {
      removeRepo(repo)
    }
  }, 60_000)

  it('honours the row\'s own write mode', async () => {
    // Both were once read from a table of SHIPPED dialects, where a project row
    // does not appear — so a declared arrangement silently fell through to
    // `code-edit`, and a delimited one would have been rejoined with vue-i18n's
    // ` | ` regardless of what it declared.
    const { repo, inventory } = await repoWith([HOUSE_STYLE])
    try {
      expect(inventory.plurals[0]!.writeMode).toBe('insert')
      expect(inventory.plurals[0]!.keyTemplate).toBe('item_{category}')
    } finally {
      removeRepo(repo)
    }
  }, 60_000)

  it('asks the target for the categories ITS locale selects', async () => {
    // The row declares `cldr: true`, so Russian's four categories are what the
    // translator must return — two forms in, four out, which no
    // one-string-in-one-string-out pipeline can express.
    const { repo, inventory } = await repoWith([HOUSE_STYLE])
    try {
      expect(inventory.plurals[0]!.targetRequired).toEqual(['one', 'few', 'many', 'other'])
      expect(inventory.plurals[0]!.missing).toEqual([])
    } finally {
      removeRepo(repo)
    }
  }, 60_000)

  it('goes inert when the dependency it named is gone', async () => {
    const { repo, inventory } = await repoWith([HOUSE_STYLE], { dependency: false })
    try {
      const view = viewDialects(repo, inventory).find((v) => v.id === 'house.sg-pl-suffix')!
      expect(view.active).toBe(false)
      expect(inventory.plurals).toHaveLength(0)
    } finally {
      removeRepo(repo)
    }
  }, 60_000)

  it('cites the manifest line that supports it', async () => {
    const { repo, inventory } = await repoWith([HOUSE_STYLE])
    try {
      const view = viewDialects(repo, inventory).find((v) => v.id === 'house.sg-pl-suffix')!
      expect(view.cites[0]).toMatchObject({ name: 'house-i18n', file: 'package.json' })
      expect(view.families).toBe(2)
    } finally {
      removeRepo(repo)
    }
  }, 60_000)
})

describe('rows the check refuses', () => {
  const reject = async (over: Record<string, unknown>, match: RegExp): Promise<void> => {
    const { repo, inventory } = await repoWith([{ ...HOUSE_STYLE, ...over }])
    try {
      const problems = runCheck(repo, inventory)
      expect(problems.map((p) => p.problem).join('\n')).toMatch(match)
    } finally {
      removeRepo(repo)
    }
  }

  it('rejects a row that cites nothing', async () => {
    await reject({ docs: '' }, /a row without a citation is a hunch/)
    await reject({ docs: 'see the polyglot readme' }, /docs.*URL/)
  }, 60_000)

  it('rejects a row that claims nothing in this repository', async () => {
    await reject(
      { read: { ...HOUSE_STYLE.read, tokens: { nope: 'one', nada: 'other' } } },
      /claims nothing in this repository/,
    )
  }, 60_000)

  it('rejects a positional scheme claiming CLDR governs it', async () => {
    await reject(
      {
        cldr: true,
        primitive: 'value-split',
        read: { primitive: 'value-split', delimiters: ['~'], order: { 2: ['one', 'other'] } },
      },
      /`cldr` cannot be true for a scheme whose selectors are positions/,
    )
  }, 60_000)

  it('rejects a row that silently re-reads a family that already worked', async () => {
    // The check that actually protects a working repository. The claim test
    // alone is satisfied by a row that steals `item_one`/`item_other` from the
    // i18next dialect and reads them wrongly; only diffing the two detection
    // runs catches it.
    const repo = emptyRepo('dialects-regress')
    try {
      mkdirSync(join(repo, BUNDLE, '..'), { recursive: true })
      writeFileSync(
        join(repo, BUNDLE),
        JSON.stringify({ cart: { item_one: '{{count}} item', item_other: '{{count}} items' } }, null, 2),
      )
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ dependencies: { 'house-i18n': '^1' } }))
      commitAll(repo)
      mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
      writeFileSync(
        join(repo, '.ultrai18n', 'dialects.json'),
        JSON.stringify({
          schemaVersion: 1,
          dialects: [
            {
              ...HOUSE_STYLE,
              id: 'rogue.key-suffix',
              precedence: 5,
              overrides: ['i18next.key-suffix'],
              primitive: 'path-part',
              read: {
                primitive: 'path-part',
                split: { kind: 'leaf-suffix', separators: ['_'] },
                // `one` deliberately mapped to `two`: the family still exists,
                // with the same anchor, and reads differently.
                tokens: { one: 'two', other: 'other' },
              },
              write: { mode: 'code-edit' },
              cldr: true,
            },
          ],
        }),
      )
      const inventory = await scan({ repo, from: 'en', to: 'ru' })
      const problems = runCheck(repo, inventory)
      expect(problems.map((p) => p.problem).join('\n')).toMatch(/used to read \[one,other\] and now reads/)
    } finally {
      removeRepo(repo)
    }
  }, 60_000)

  it('rejects a row that preempts a shipped one without saying so', async () => {
    await reject({ precedence: 5 }, /preempts a shipped dialect/)
  }, 60_000)

  it('rejects a regex that could not be trusted to terminate', async () => {
    // A pattern a model wrote is attacker-adjacent input. Length and nested
    // quantifiers are the cheap guards; the row is dropped and reported rather
    // than compiled.
    const { repo, inventory } = await repoWith([
      {
        ...HOUSE_STYLE,
        primitive: 'path-part',
        read: { primitive: 'path-part', split: { kind: 'path-regex', re: '(.*)+(x)' }, tokens: { one: 'one' } },
      },
    ])
    try {
      expect(runCheck(repo, inventory).map((p) => p.problem).join('\n')).toMatch(/declares no readable dialect/)
    } finally {
      removeRepo(repo)
    }
  }, 60_000)
})
