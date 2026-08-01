// The two returns nobody verified.
//
// `adjudicate --apply` parses an adjudicator's ruling and folds it in. The
// `pluralist` and `structuralist` phases have the same shape and had no such
// path — but the gap is a DIFFERENT one and must not be fixed the same way.
//
// Those two phases WRITE FILES. Their return is therefore not a decision the
// engine has to fold in; it is a claim that an edit was made. Both joins already
// re-scanned, and the re-scan was never compared against what the agent said it
// did, so an agent reporting a family it never touched produced a green run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parsePluralReturns, verifyPluralReturns, readStructuralReturns, unverifiedStructural,
} from '../src/plural/verify'
import { scan } from '../src/scan'
import { check } from '../src/check'
import type { Inventory } from '../src/types'

const todo = {
  families: [
    {
      familyId: 'pf_abc123',
      file: 'src/Cart.tsx',
      anchor: 'src/Cart.tsx#label',
      targetCategories: ['one', 'few', 'many', 'other'],
      forms: { one: 'товар', few: 'товара', many: 'товаров', other: 'товара' },
    },
  ],
}

const inventoryWith = (forms: string[], id = 'pf_abc123', file = 'src/Cart.tsx'): Inventory =>
  ({
    plurals: [
      {
        id,
        file,
        anchor: `${file}#label`,
        forms: forms.map((category) => ({ category, selector: category, siteId: 's', value: 'x' })),
        missing: [],
        extra: [],
      },
    ],
    sites: [],
  }) as unknown as Inventory

describe('a claimed plural edit is checked against a fresh scan', () => {
  it('accepts a family that now has every form its target selects', () => {
    const r = verifyPluralReturns({
      returns: [{ familyId: 'pf_abc123', note: 'used Intl.PluralRules' }],
      todo,
      inventory: inventoryWith(['one', 'few', 'many', 'other']),
    })
    expect(r.ok).toBe(true)
    expect(r.counts).toMatchObject({ claimed: 1, verified: 1, failed: 0 })
  })

  it('refuses a family that is still short of a form', () => {
    // The worklist supplied all four forms ALREADY TRANSLATED. What was left is
    // the code edit, so a short family is an edit that did not happen.
    const r = verifyPluralReturns({
      returns: [{ familyId: 'pf_abc123', note: 'done' }],
      todo,
      inventory: inventoryWith(['one', 'other']),
    })
    expect(r.ok).toBe(false)
    expect(r.claims[0]!.detail).toMatch(/still has no few or many form/)
  })

  it('refuses a claim the re-scan cannot see at all', () => {
    const r = verifyPluralReturns({
      returns: [{ familyId: 'pf_abc123', note: 'done' }],
      todo,
      inventory: ({ plurals: [], sites: [] }) as unknown as Inventory,
    })
    expect(r.ok).toBe(false)
    expect(r.claims[0]!.detail).toMatch(/reported an edit the re-scan cannot see/)
  })

  it('accepts a family the edit legitimately DISSOLVED', () => {
    // Replacing a hand-rolled conditional with the platform's plural API is the
    // point of the phase, and it destroys the old anchor. What is required is
    // that the file now covers the categories that were handed out.
    const r = verifyPluralReturns({
      returns: [{ familyId: 'pf_abc123', note: 'replaced the ternary with Intl.PluralRules' }],
      todo,
      inventory: inventoryWith(['one', 'few', 'many', 'other'], 'pf_different'),
    })
    expect(r.ok).toBe(true)
  })

  it('fails on a family handed out and never reported on', () => {
    // Silence is not success, or the whole phase becomes optional.
    const r = verifyPluralReturns({ returns: [], todo, inventory: inventoryWith(['one', 'other']) })
    expect(r.ok).toBe(false)
    expect(r.unclaimed).toEqual(['pf_abc123'])
  })

  it('refuses a claim for a family this run never handed out', () => {
    const r = verifyPluralReturns({
      returns: [{ familyId: 'pf_elsewhere' }],
      todo,
      inventory: inventoryWith(['one', 'few', 'many', 'other']),
    })
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/not a family this run handed out/)
  })

  it('refuses the same family claimed twice', () => {
    const r = verifyPluralReturns({
      returns: [{ familyId: 'pf_abc123' }, { familyId: 'pf_abc123' }],
      todo,
      inventory: inventoryWith(['one', 'few', 'many', 'other']),
    })
    expect(r.problems[0]).toMatch(/claimed twice/)
  })

  it('reads both shapes an agent might write', () => {
    expect(parsePluralReturns([{ familyId: 'a' }])).toHaveLength(1)
    expect(parsePluralReturns({ returns: [{ familyId: 'a' }] })).toHaveLength(1)
    expect(parsePluralReturns({ nonsense: true })).toBeNull()
  })
})

describe('a claimed structural edit is folded into check', () => {
  let repo: string
  let inv: Inventory

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'ultrai18n-structural-'))
    mkdirSync(join(repo, 'src'), { recursive: true })
    // A plural rule baked into the expression. No translated string can be
    // correct here — the target may need a different NUMBER of agreement sites
    // — so the engine refuses with `grammar-hole`, and the structuralist's job
    // is to make the hole go away.
    writeFileSync(
      join(repo, 'src', 'cart.ts'),
      'export const label = (n: number) => `${n} article${n > 1 ? "s" : ""} dans le panier`\n',
    )
    mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
    inv = await scan({ repo, from: 'fr', to: 'en' })
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  const holeId = () => inv.sites.find((s) => s.reason === 'grammar-hole')!.id

  it('finds the grammar hole in the first place', () => {
    expect(inv.sites.some((s) => s.reason === 'grammar-hole')).toBe(true)
  })

  it('reports a site claimed edited whose hole is still there', () => {
    const stale = unverifiedStructural([{ siteId: holeId(), note: 'used Intl.PluralRules' }], inv)
    expect(stale).toHaveLength(1)
    expect(stale[0]!.note).toBe('used Intl.PluralRules')
  })

  it('says nothing about a site whose hole is gone', () => {
    const closed = { ...inv, sites: inv.sites.map((s) => ({ ...s, reason: null })) } as Inventory
    expect(unverifiedStructural([{ siteId: holeId() }], closed)).toEqual([])
  })

  it('fails G6 when the returns file claims an edit that did not happen', () => {
    writeFileSync(
      join(repo, '.ultrai18n', 'STRUCTURAL.json'),
      JSON.stringify({ returns: [{ siteId: holeId(), file: 'src/cart.ts', note: 'done' }] }),
    )
    const gate = check({ repo, inventory: inv }).gates.find((g) => g.id === 'G6')!
    expect(gate.findings.some((f) => f.kind === 'structural-unverified')).toBe(true)
  })

  it('costs a run with no returns file nothing', () => {
    rmSync(join(repo, '.ultrai18n', 'STRUCTURAL.json'), { force: true })
    const gate = check({ repo, inventory: inv }).gates.find((g) => g.id === 'G6')!
    expect(gate.findings.filter((f) => f.kind === 'structural-unverified')).toEqual([])
  })

  it('reads both shapes an agent might write', () => {
    expect(readStructuralReturns([{ siteId: 'a' }])).toHaveLength(1)
    expect(readStructuralReturns({ returns: [{ siteId: 'a' }] })).toHaveLength(1)
    expect(readStructuralReturns({ nonsense: true })).toEqual([])
  })
})
