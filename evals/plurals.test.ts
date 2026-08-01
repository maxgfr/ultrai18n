// The plural eval: one already-internationalised repository, every shape once,
// each with a known-clean or known-broken outcome.
//
// The assertions are about BEHAVIOUR, never about totals. A test that pins
// "12 families" fails on every fixture edit and tells you nothing about whether
// the thing works.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolatedRepo, removeRepo } from './isolate'
import { scan } from '../src/scan'
import { plan } from '../src/plan'
import { check } from '../src/check'
import { sync } from '../src/sync'
import { cmdApply, cmdPlan, cmdTranslate, cmdTranslateApply } from '../src/commands'
import type { Inventory } from '../src/types'
import type { PluralFamily } from '../src/plural'

const FIXTURE = join(import.meta.dirname, 'fixture-i18n')

let readRepo: string
let inv: Inventory
let families: PluralFamily[]

beforeAll(async () => {
  readRepo = isolatedRepo(FIXTURE, 'plurals-read')
  inv = await scan({ repo: readRepo, from: 'auto', to: 'ru' })
  families = inv.plurals as PluralFamily[]
}, 60_000)

afterAll(() => removeRepo(readRepo))

const at = (anchor: string): PluralFamily | undefined => families.find((f) => f.anchor.endsWith(anchor))

describe('every shape is found', () => {
  it('finds one family per shape, and labels each by arrangement', () => {
    expect(at('src/locales/en/common.json#/cart/item')?.shape).toBe('key-suffix')
    expect(at('config/locales/en.yml#/en/tasks/count')?.shape).toBe('sibling-object')
    expect(at('src/locales/en/common.json#/inbox')?.shape).toBe('inline-select')
    expect(at('res/values/strings.xml#plurals[task_count]')?.shape).toBe('attr-quantity')
    expect(at('src/locales/en/common.json#/cars')?.shape).toBe('delimited')
    expect(at('src/Cart.tsx#Cart/label')?.shape).toBe('annotation')
  })

  it('reads each family in the locale its own path declares', () => {
    expect(at('src/locales/ru/common.json#/cart/item')?.locale).toBe('ru')
    expect(at('src/locales/ja/common.json#/cart/item')?.locale).toBe('ja')
  })
})

describe('completeness is measured against the family OWN locale', () => {
  it('reports a Russian family that renders the wrong string for 2, 3 and 4', () => {
    const family = at('src/locales/ru/common.json#/cart/item')!
    expect(family.ownRequired).toEqual(['one', 'few', 'many', 'other'])
    expect(family.missing).toEqual(['few', 'many'])
  })

  it('reports the same defect inside an ICU message', () => {
    expect(at('src/locales/ru/common.json#/inbox')!.missing).toEqual(['few', 'many'])
  })

  it('reports a key English will never select', () => {
    const family = at('src/locales/en/common.json#/notice')!
    expect(family.extra).toEqual(['few'])
    expect(family.missing).toEqual([])
  })

  it('does NOT report a one-form Japanese family, which is complete', () => {
    const family = at('src/locales/ja/common.json#/cart/item')!
    expect(family.sourceCategories).toEqual(['other'])
    expect(family.missing).toEqual([])
    expect(family.extra).toEqual([])
  })

  it('does not measure an ordinal family against cardinal rules', () => {
    // English cardinals have two forms and its ordinals have four; gating one
    // on the other would invent a failure at every ordinal in the repo.
    for (const anchor of ['common.json#/place', 'common.json#/invite']) {
      const family = at(anchor)!
      expect(family.ordinal).toBe(true)
      expect(family.missing).toEqual([])
      expect(family.extra).toEqual([])
    }
  })

  it('does not measure vue-i18n positional forms against CLDR', () => {
    const family = at('src/locales/en/common.json#/cars')!
    expect(family.sourceCategories).toEqual(['zero', 'one', 'other'])
    expect(family.extra).toEqual([])
    // Positional forms keep their arity: four Russian categories would produce
    // a string vue-i18n cannot index.
    expect(family.targetRequired).toEqual(family.sourceCategories)
  })
})

describe('the target decides how many forms come back', () => {
  it('asks for four Russian forms where English has two', () => {
    expect(at('src/locales/en/common.json#/cart/item')!.targetRequired).toEqual([
      'one', 'few', 'many', 'other',
    ])
  })

  it('routes each family to a write mode its format can honour', () => {
    expect(at('src/locales/en/common.json#/cart/item')!.writeMode).toBe('insert')
    expect(at('config/locales/en.yml#/en/tasks/count')!.writeMode).toBe('insert')
    expect(at('src/locales/en/common.json#/inbox')!.writeMode).toBe('replace')
    expect(at('res/values/strings.xml#plurals[task_count]')!.writeMode).toBe('code-edit')
    expect(at('src/Cart.tsx#Cart/label')!.writeMode).toBe('code-edit')
  })

  it('spells a new key the way the file already spells its siblings', () => {
    expect(at('src/locales/en/common.json#/cart/item')!.keyTemplate).toBe('item_{category}')
    expect(at('config/locales/en.yml#/en/tasks/count')!.keyTemplate).toBe('{category}')
  })
})

describe('annotations', () => {
  it('takes the forms a pragma declares and marks the site as decided by it', () => {
    const family = at('src/Cart.tsx#Cart/label')!
    expect(family.declaredBy).toBe('annotation')
    expect(family.count).toBe('n')
    expect(family.forms.map((f) => f.value)).toEqual([
      'One item in your cart',
      '{0} items in your cart',
    ])
    const site = inv.sites.find((s) => s.id === family.sites[0])!
    expect(site.decidedBy).toBe('inline-pragma')
  })

  it('still refuses the identical ternary that nobody annotated', () => {
    const site = inv.sites.find((s) => s.file === 'src/Cart.tsx' && s.value.includes('file'))!
    expect(site.verdict).toBe('needs-judgment')
    expect(site.reason).toBe('grammar-hole')
    expect(site.decidedBy).toBe('engine')
  })

  it('does not translate the pragma comment itself', () => {
    const pragma = inv.sites.find((s) => s.kind === 'comment' && s.value.includes('ultrai18n:plural'))!
    expect(pragma.verdict).toBe('do-not-translate')
    expect(pragma.reason).toBe('explicitly-marked')
  })
})

describe('the family is the unit of work', () => {
  it('never groups one form of a family on its own', () => {
    const p = plan(inv)
    const memberSites = new Set(families.flatMap((f) => f.sites))
    const leaked = p.groups.filter((g) => !g.plural && g.sites.some((id) => memberSites.has(id)))
    expect(leaked.map((g) => g.text)).toEqual([])
  })

  it('calls it a completion, not a translation, when the family is already in the target', () => {
    const p = plan(inv)
    const ru = p.groups.find((g) => g.plural?.familyId === at('src/locales/ru/common.json#/cart/item')!.id)
    expect(ru?.plural?.op).toBe('complete')
  })

  it('plans an annotated family even though its site is a refusal', () => {
    const p = plan(inv)
    expect(p.groups.some((g) => g.plural?.familyId === at('src/Cart.tsx#Cart/label')!.id)).toBe(true)
  })
})

describe('the gate', () => {
  it('fails while any family is short of a form its locale selects', () => {
    const report = check({ repo: FIXTURE, inventory: inv })
    const g6 = report.gates.find((g) => g.id === 'G6')!
    const plural = g6.findings.filter((f) => f.kind === 'plural-incomplete')
    expect(plural.length).toBe(3)
    expect(g6.ok).toBe(false)
  })
})

describe('sync', () => {
  it('reports a locale short of a plural form, and does NOT call its extra forms orphans', () => {
    const report = sync({ repo: FIXTURE, inventory: inv, sourceLocale: 'en' })
    const incomplete = report.findings.filter((f) => f.class === 'plural-incomplete')
    expect(incomplete.some((f) => f.locale === 'ru' && f.key === '/cart/item')).toBe(true)
    // Russian's `_few` has no English counterpart. That is Russian being
    // Russian, not a key nobody uses.
    expect(report.findings.filter((f) => f.class === 'orphan' && /item_/.test(f.key))).toEqual([])
    expect(report.ok).toBe(false)
  })
})

describe('end to end, en → ru', () => {
  // The case the pipeline could not express at all before: a two-form source
  // becoming a four-form target, written back to disk.
  //
  // Driven IN PROCESS rather than through the CLI. The subprocess version
  // shelled out to `npx tsx`, which is not a dependency of this project — so an
  // eval reached the npm registry from inside a `--frozen-lockfile` CI job, and
  // a failure surfaced as an opaque non-zero exit with no stack. These are the
  // same five functions `src/cli.ts` calls, in the same order; only the argument
  // parsing and the exit codes are missing, and neither is what this asserts.
  let repo: string
  let out: string

  beforeAll(async () => {
    repo = isolatedRepo(FIXTURE, 'plurals-e2e')
    out = join(repo, '.ultrai18n')
    mkdirSync(out, { recursive: true })

    const written = await scan({ repo, from: 'auto', to: 'ru' })
    writeFileSync(join(out, 'inventory.json'), JSON.stringify(written, null, 2) + '\n')

    // `plan` sets a non-zero exit code on an open hazard — which this fixture
    // has by design — but it still writes every artifact. In process there is
    // nothing to catch: the exit code lives in the CLI, not in cmdPlan.
    cmdPlan(out, 'swap')
    cmdTranslate({
      out,
      repo,
      backend: 'cli',
      translator: `node ${join(import.meta.dirname, 'fake-translator.mjs')}`,
    })
    cmdTranslateApply(out)
    cmdApply(repo, out, true, true)
  }, 120_000)

  afterAll(() => removeRepo(repo))

  it('writes the two keys Russian needs and the file never had', () => {
    const bundle = JSON.parse(readFileSync(join(repo, 'src/locales/ru/common.json'), 'utf8'))
    expect(Object.keys(bundle.cart).sort()).toEqual([
      'item_few', 'item_many', 'item_one', 'item_other',
    ])
  })

  it('rebuilds an ICU message from two branches to four', () => {
    const bundle = JSON.parse(readFileSync(join(repo, 'src/locales/ru/common.json'), 'utf8'))
    for (const category of ['one', 'few', 'many', 'other']) {
      expect(bundle.inbox).toContain(`${category} {`)
    }
  })

  it('leaves the English bundle exactly as it was', () => {
    expect(readFileSync(join(repo, 'src/locales/en/common.json'), 'utf8')).toBe(
      readFileSync(join(FIXTURE, 'src/locales/en/common.json'), 'utf8'),
    )
  })

  it('hands the code-edit families over with their forms already translated', () => {
    const todo = JSON.parse(readFileSync(join(repo, '.ultrai18n/PLURALS.todo.json'), 'utf8'))
    const cart = todo.families.find((f: { file: string }) => f.file === 'src/Cart.tsx')
    expect(cart.targetCategories).toEqual(['one', 'few', 'many', 'other'])
    expect(Object.keys(cart.forms).sort()).toEqual(['few', 'many', 'one', 'other'])
    expect(cart.count).toBe('n')
  })

  it('refuses nothing and applies everything it planned', () => {
    const report = JSON.parse(readFileSync(join(repo, '.ultrai18n/APPLY.json'), 'utf8'))
    expect(report.sites.refused).toBe(0)
    expect(report.sites.applied).toBe(report.sites.total)
    expect(report.sites.inserted).toBe(2)
  })
})
