// A declared family is written back by the FORMAT it lives in, not by the fact
// that somebody declared it.
//
// Every pragma and every sidecar entry used to become `code-edit` unconditionally
// — so a declaration landing on a JSON scalar in a locale bundle, where inserting
// a sibling key is exactly what `apply` already does, could never be written
// mechanically. Nothing downstream required that: `writeFamily` has always handled
// `insert` for any family carrying `keyTemplate` and `insertAfterSiteId`, and
// `fromAnnotation` was the only thing withholding them.
//
// The pair of tests that matter are the first two: the same declaration, on a
// JSON bundle and on a template literal, has to come back with two different
// answers — and neither of them may come from the fact that it was declared.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { commitAll, emptyRepo, removeRepo } from '../evals/isolate'
import type { PluralFamily } from '../src/plural'

interface Declared {
  siteKey: string
  forms?: Record<string, string>
  write?: string
  keyTemplate?: string
  category?: string
}

async function scanWith(files: Record<string, string>, families: Declared[]): Promise<PluralFamily[]> {
  const repo = emptyRepo('declared-write')
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true })
      writeFileSync(join(repo, rel), body)
    }
    commitAll(repo)
    mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
    writeFileSync(
      join(repo, '.ultrai18n', 'plurals.json'),
      JSON.stringify({ schemaVersion: 1, families }, null, 2),
    )
    const inv = await scan({ repo, from: 'en', to: 'ru' })
    return inv.plurals as PluralFamily[]
  } finally {
    removeRepo(repo)
  }
}

const BUNDLE = 'src/locales/en/common.json'

describe('a declaration in a locale bundle', () => {
  it('is inserted, because the format allows a sibling key', async () => {
    const families = await scanWith(
      { [BUNDLE]: JSON.stringify({ basket: { item_one: '{{count}} thing' } }, null, 2) },
      [{ siteKey: `${BUNDLE}#/basket/item_one`, forms: { one: '{{count}} thing', other: '{{count}} things' } }],
    )
    const family = families.find((f) => f.declaredBy === 'annotation')
    expect(family?.writeMode).toBe('insert')
    // Derived from the site's own path by `splitPluralKey`, so a declared family
    // and a detected one in the same bundle spell a new key the same way.
    expect(family?.keyTemplate).toBe('item_{category}')
    expect(family?.blocked).toBeUndefined()
  }, 60_000)

  it('spells a child-key family without a prefix', async () => {
    const families = await scanWith(
      { [BUNDLE]: JSON.stringify({ basket: { item: { one: 'a thing' } } }, null, 2) },
      [{ siteKey: `${BUNDLE}#/basket/item/one`, forms: { one: 'a thing', other: 'things' } }],
    )
    const family = families.find((f) => f.declaredBy === 'annotation')
    expect(family?.writeMode).toBe('insert')
    expect(family?.keyTemplate).toBe('{category}')
  }, 60_000)
})

describe('a declaration inside an expression', () => {
  it('stays a code edit, and says why', async () => {
    const files = {
      'src/Cart.tsx':
        '// ultrai18n:plural count=n one="One item" other="{0} items"\n' +
        'export const label = (n: number) => `${n} item${n > 1 ? "s" : ""}`\n',
    }
    const families = await scanWith(files, [])
    const family = families.find((f) => f.declaredBy === 'annotation')
    expect(family?.writeMode).toBe('code-edit')
    expect(family?.blocked).toContain('code edit')
  }, 60_000)

  it('refuses an explicit insert it cannot honour, rather than obeying it', async () => {
    const files = {
      'src/Cart.tsx': 'export const label = "one item"\n',
    }
    const families = await scanWith(files, [
      {
        siteKey: 'src/Cart.tsx#label',
        write: 'insert',
        forms: { one: 'one item', other: 'items' },
      },
    ])
    const family = families.find((f) => f.declaredBy === 'annotation')
    // Unconditional on purpose. A guarded assertion here would pass silently the
    // day the family stops being produced at all, which is the failure this test
    // is least able to afford.
    expect(family, 'no declared family was produced').toBeDefined()
    // A declaration is not a licence to write syntax the engine did not parse.
    expect(family!.writeMode).toBe('code-edit')
    expect(family!.blocked).toContain('not a format')
  }, 60_000)
})

describe('an explicit write mode', () => {
  it('is taken at its word when it asks for a code edit', async () => {
    const families = await scanWith(
      { [BUNDLE]: JSON.stringify({ basket: { item_one: '{{count}} thing' } }, null, 2) },
      [
        {
          siteKey: `${BUNDLE}#/basket/item_one`,
          write: 'code-edit',
          forms: { one: '{{count}} thing', other: '{{count}} things' },
        },
      ],
    )
    const family = families.find((f) => f.declaredBy === 'annotation')
    // The format would allow insertion. Somebody said not to, and that outranks
    // anything derived — the same precedence an annotation has over a shape.
    expect(family?.writeMode).toBe('code-edit')
  }, 60_000)

  it('honours a keyTemplate the declaration spells out', async () => {
    const families = await scanWith(
      { [BUNDLE]: JSON.stringify({ basket: { 'item.one': 'a thing' } }, null, 2) },
      [
        {
          siteKey: `${BUNDLE}#/basket/item.one`,
          keyTemplate: 'item.{category}',
          forms: { one: 'a thing', other: 'things' },
        },
      ],
    )
    const family = families.find((f) => f.declaredBy === 'annotation')
    expect(family?.keyTemplate).toBe('item.{category}')
  }, 60_000)
})

describe('end to end', () => {
  it('writes the keys Russian needs into a bundle nobody detected a family in', async () => {
    // The shape detectors see nothing here: `label` carries no category token,
    // so without the declaration this is one ordinary string. With it, and with
    // the write mode no longer forced to code-edit, the engine completes it.
    const repo = emptyRepo('declared-e2e')
    try {
      const rel = 'src/locales/en/common.json'
      mkdirSync(join(repo, rel, '..'), { recursive: true })
      writeFileSync(join(repo, rel), JSON.stringify({ basket: { item_one: '{{count}} thing' } }, null, 2) + '\n')
      commitAll(repo)

      mkdirSync(join(repo, '.ultrai18n'), { recursive: true })
      writeFileSync(
        join(repo, '.ultrai18n', 'plurals.json'),
        JSON.stringify({
          schemaVersion: 1,
          families: [
            {
              siteKey: `${rel}#/basket/item_one`,
              category: 'one',
              forms: { one: '{{count}} thing', other: '{{count}} things' },
            },
          ],
        }),
      )

      const inv = await scan({ repo, from: 'en', to: 'ru' })
      const family = (inv.plurals as PluralFamily[]).find((f) => f.declaredBy === 'annotation')
      expect(family?.writeMode).toBe('insert')
      // Russian selects four categories, so the family is short three of them
      // and the worklist will ask the translator for all four.
      expect(family?.targetRequired).toEqual(['one', 'few', 'many', 'other'])
    } finally {
      removeRepo(repo)
    }
  }, 60_000)
})

describe('the pragma reads the same fields', () => {
  it('needs no parser change, because parseFields always read arbitrary k=v', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultrai18n-pragma-'))
    try {
      const { parseFields } = await import('../src/plural/annotate')
      expect(parseFields('// ultrai18n:plural write=insert keyTemplate=item_{category} category=one')).toEqual({
        write: 'insert',
        keyTemplate: 'item_{category}',
        category: 'one',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
