// Adding a locale by the catalog-staging route: the target bundle starts as a
// byte copy of the source, at the target's path. Found adding German to an app.
//
// Two things went wrong there. Every plural family was planned as `complete`,
// because its bundle's PATH is the target locale — and the contract for
// `complete` tells the translator to keep the forms as written, which would have
// left English in the German bundle. And a five-letter label was allowed eleven
// characters, one short of the German word for it.
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { maxFor, plan } from '../src/plan'
import { commitAll, emptyRepo, removeRepo } from '../evals/isolate'

const BUNDLE = {
  stops: 'Stops',
  'transfers.one': '{n} change',
  'transfers.other': '{n} changes',
  'stop.error': 'The service did not answer. Departures will show when it does.',
}

async function planFor(files: Record<string, string>, to: string) {
  const repo = emptyRepo('adding-locale')
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true })
      writeFileSync(join(repo, rel), body)
    }
    commitAll(repo)
    return plan(await scan({ repo, from: 'en', to }))
  } finally {
    removeRepo(repo)
  }
}

describe('a target bundle seeded from the source', () => {
  it('has its plural families translated, not completed', async () => {
    const body = JSON.stringify(BUNDLE, null, 2)
    const p = await planFor({ 'locales/en.json': body, 'locales/de.json': body }, 'de')
    const families = p.groups.filter((g) => g.plural)
    expect(families).toHaveLength(1)
    expect(families[0]!.plural!.op).toBe('translate')
    expect(families[0]!.plural!.forms).toEqual({ one: '{n} change', other: '{n} changes' })
    expect(p.counts.pluralCompleting).toBe(0)
  })

  it('while a family already in the target language and short of a form is still completed', async () => {
    const en = JSON.stringify({ 'files.one': '{n} file', 'files.other': '{n} files' }, null, 2)
    const ru = JSON.stringify({ 'files.one': '{n} файл', 'files.other': '{n} файлов' }, null, 2)
    const p = await planFor({ 'locales/en.json': en, 'locales/ru.json': ru }, 'ru')
    const russian = p.groups.filter((x) => x.plural && x.plural.locale === 'ru')
    expect(russian.length).toBeGreaterThan(0)
    for (const g of russian) expect(g.plural!.op).toBe('complete')
  })
})

describe('maxFor', () => {
  it('lets a short label grow the most', () => {
    // `Haltestellen` is 12 characters.
    expect(maxFor('label', 'Stops')).toBe(15)
    expect(maxFor('label', 'Back')).toBe(12)
  })

  it('and a long one by less', () => {
    expect(maxFor('label', 'x'.repeat(20))).toBe(40)
    expect(maxFor('label', 'x'.repeat(40))).toBe(64)
    expect(maxFor('label', 'x'.repeat(100))).toBe(130)
  })

  it('counts characters, not UTF-16 units', () => {
    expect(maxFor('label', 'Café 🚲')).toBe(maxFor('label', 'Cafe x'))
  })

  it('never limits prose', () => {
    expect(maxFor('paragraph', 'x'.repeat(10))).toBeNull()
  })
})
