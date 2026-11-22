// ICU MessageFormat catalogs, as a Next.js + next-intl app keeps them. Found
// localizing a real application from English into German, Spanish and Italian
// by the catalog-staging route. The wording below is synthetic; the shapes are
// the ones that went wrong.
//
// Three separate misreadings of the same syntax:
//
//  - G4 counted ICU KEYWORDS and ARGUMENT NAMES as words. `other` and `where`
//    are English stopwords, so `{gender, select, female {Kardiologin} other
//    {Kardiologe}}` and `Sie suchten in „{where}“` read as English, and a
//    correctly translated German catalog failed with a hundred findings.
//  - `sync` read a select BRANCH BODY as a placeholder: `{Kardiologe}` matched
//    `\{\w+\}`, so every gendered noun whose branches happened to be ASCII was
//    an arity mismatch against an English source with no variable at all.
//  - A plural embedded in a sentence was planned as its branches alone. The
//    words around the argument and every `=0` branch rode through in English.
import { describe, it, expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { check } from '../src/check'
import { sync } from '../src/sync'
import { plan } from '../src/plan'
import { buildBatches, foldResults } from '../src/translate'
import { writeFamily } from '../src/commands'
import { apply } from '../src/apply'
import { detect } from '../src/lang/detect'
import type { PluralFamily } from '../src/plural'
import { commitAll, emptyRepo, removeRepo } from '../evals/isolate'

const EN = {
  search: {
    where: 'You searched in “{where}”',
    range: 'Results {from} to {to}',
  },
  taxonomy: {
    cardiologist: 'Cardiologist',
    pharmacist: 'Pharmacist',
    baker: 'Baker',
  },
  list: {
    lead: 'The directory lists {count, plural, =0 {no specialist} one {# specialist} other {# specialists}} near {place}.',
    codes: '{count, plural, =0 {No more codes can be sent.} one {You can ask for # more code.} other {You can ask for # more codes.}}',
  },
}

// A correct German catalog: gendered nouns are selects, the plural carries the
// whole sentence in every branch, and the zero case is translated.
const DE = {
  search: {
    where: 'Sie suchten in „{where}“',
    range: 'Ergebnisse {from} bis {to}',
  },
  taxonomy: {
    cardiologist: '{gender, select, female {Kardiologin} other {Kardiologe}}',
    pharmacist: '{gender, select, female {Apothekerin} male {Apotheker} other {Apotheker}}',
    baker: '{gender, select, female {Konditorin} other {Konditor}}',
  },
  list: {
    lead:
      '{count, plural, =0 {Das Verzeichnis führt keine Fachkraft in der Nähe von {place}.} ' +
      'one {Das Verzeichnis führt # Fachkraft in der Nähe von {place}.} ' +
      'other {Das Verzeichnis führt # Fachkräfte in der Nähe von {place}.}}',
    codes:
      '{count, plural, =0 {Es können keine Codes mehr gesendet werden.} ' +
      'one {Sie können noch # weiteren Code anfordern.} other {Sie können noch # weitere Codes anfordern.}}',
  },
}

async function withRepo<T>(
  files: Record<string, string>,
  to: string,
  fn: (repo: string, inv: Awaited<ReturnType<typeof scan>>) => Promise<T> | T,
): Promise<T> {
  const repo = emptyRepo('icu-catalog')
  try {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(repo, rel, '..'), { recursive: true })
      writeFileSync(join(repo, rel), body)
    }
    commitAll(repo)
    return await fn(repo, await scan({ repo, from: 'en', to }))
  } finally {
    removeRepo(repo)
  }
}

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n'

describe('G4 votes on the words of a message, never on its ICU syntax', () => {
  it('passes a correctly translated German catalog', async () => {
    await withRepo({ 'messages/en.json': json(EN), 'messages/de.json': json(DE) }, 'de', (repo, inv) => {
      const g4 = check({ repo, inventory: inv }).gates.find((g) => g.id === 'G4')!
      const german = g4.findings.filter((f) => f.file === 'messages/de.json')
      expect(german.map((f) => f.message)).toEqual([])
    })
  })

  it('still catches English left inside the branches', async () => {
    const stale = { ...DE, list: { ...DE.list, codes: EN.list.codes } }
    await withRepo({ 'messages/en.json': json(EN), 'messages/de.json': json(stale) }, 'de', (repo, inv) => {
      const g4 = check({ repo, inventory: inv }).gates.find((g) => g.id === 'G4')!
      const german = g4.findings.filter((f) => f.file === 'messages/de.json')
      expect(german).toHaveLength(1)
      expect(german[0]!.message).toMatch(/^still en .*No more codes/)
    })
  })

  it('reads keywords, selectors and argument names as nothing', () => {
    const candidates = ['en', 'de'] as const
    expect(detect('{gender, select, female {Kardiologin} other {Kardiologe}}', { candidates }).detected).not.toBe('en')
    expect(detect('Sie suchten in „{where}“', { candidates }).detected).not.toBe('en')
    expect(
      detect('{count, selectordinal, one {#.} two {#.} few {#.} other {#.}} Platz für {practitionerName}', { candidates }).detected,
    ).not.toBe('en')
    // The literal text is still read, branches included.
    expect(detect('{count, plural, =0 {Nothing is waiting for you.} other {There are # items waiting for you.}}', { candidates }).detected).toBe('en')
  })
})

describe('sync reads placeholders from ICU arguments, never from branch bodies', () => {
  it('finds no arity mismatch on gendered selects', async () => {
    await withRepo({ 'messages/en.json': json(EN), 'messages/de.json': json(DE) }, 'de', (repo, inv) => {
      const report = sync({ repo, inventory: inv, sourceLocale: 'en' })
      const arity = report.findings.filter((f) => f.class === 'arity-mismatch')
      expect(arity.map((f) => `${f.key}: ${f.detail}`)).toEqual([])
      expect(report.ok).toBe(true)
    })
  })

  it('still reports a placeholder a translation lost', async () => {
    const lost = {
      ...DE,
      search: { ...DE.search, range: 'Ergebnisse {from} bis …' },
      list: { ...DE.list, lead: '{count, plural, one {Das Verzeichnis führt # Fachkraft.} other {Das Verzeichnis führt # Fachkräfte.}}' },
    }
    await withRepo({ 'messages/en.json': json(EN), 'messages/de.json': json(lost) }, 'de', (repo, inv) => {
      const report = sync({ repo, inventory: inv, sourceLocale: 'en' })
      const arity = report.findings.filter((f) => f.class === 'arity-mismatch').map((f) => f.key).sort()
      expect(arity).toEqual(['/list/lead', '/search/range'])
    })
  })
})

describe('a plural inside a sentence is translated as the whole sentence', () => {
  const staged = { 'messages/en.json': json(EN), 'messages/de.json': json(EN) }

  it('offers every branch, =0 included, with the words around the argument', async () => {
    await withRepo(staged, 'de', (_repo, inv) => {
      const p = plan(inv)
      const lead = p.groups.find((g) => g.plural && g.sites.some((id) => inv.sites.find((s) => s.id === id)?.file === 'messages/de.json' && inv.sites.find((s) => s.id === id)?.value === EN.list.lead))
      expect(lead).toBeDefined()
      expect(lead!.plural!.forms).toEqual({
        one: 'The directory lists # specialist near {place}.',
        other: 'The directory lists # specialists near {place}.',
      })
      expect(lead!.plural!.exact).toEqual([{ selector: '=0', value: 'The directory lists no specialist near {place}.' }])

      const item = buildBatches([lead!], { sourceLang: 'en', targetLang: 'de', project: { name: 't' } })[0]!.items[0]!
      expect(item.plural!.exact).toEqual({ '=0': 'The directory lists no specialist near {place}.' })
      expect(item.plural!.placeholders).toEqual(['#', '{place}'])
    })
  })

  it('writes the translated sentence into every branch and keeps =0', async () => {
    await withRepo(staged, 'de', (repo, inv) => {
      const p = plan(inv)
      const families = new Map(((inv.plurals ?? []) as PluralFamily[]).map((f) => [f.id, f]))
      const bySiteId = new Map(inv.sites.map((s) => [s.id, s]))
      const german = p.groups.filter(
        (g) => g.plural && families.get(g.plural.familyId)?.file === 'messages/de.json',
      )
      expect(german).toHaveLength(2)

      const answers: Record<string, Record<string, string>> = {
        [EN.list.lead]: {
          '=0': 'Das Verzeichnis führt keine Fachkraft in der Nähe von {place}.',
          one: 'Das Verzeichnis führt # Fachkraft in der Nähe von {place}.',
          other: 'Das Verzeichnis führt # Fachkräfte in der Nähe von {place}.',
        },
        [EN.list.codes]: {
          '=0': 'Es können keine Codes mehr gesendet werden.',
          one: 'Sie können noch # weiteren Code anfordern.',
          other: 'Sie können noch # weitere Codes anfordern.',
        },
      }
      const batches = buildBatches(german, { sourceLang: 'en', targetLang: 'de', project: { name: 't' } })
      const results = batches.map((b) => ({
        batchId: b.batchId,
        batchDigest: b.batchDigest,
        items: b.items.map((it) => {
          const site = bySiteId.get(german.find((g) => g.id === it.id)!.sites[0]!)!
          return { id: it.id, forms: answers[site.value]! }
        }),
      }))
      const folded = foldResults(results, { groups: german, batches })
      expect(folded.rejected).toEqual([])
      expect(folded.accepted).toHaveLength(2)

      const translations = folded.accepted.flatMap((a) => {
        const g = german.find((x) => x.id === a.groupId)!
        return writeFamily(families.get(g.plural!.familyId)!, a.forms!, bySiteId).translations
      })
      const report = apply({ repo, inventory: inv, translations, insertions: [], write: true })
      expect(report.ok).toBe(true)

      const written = JSON.parse(readFileSync(join(repo, 'messages/de.json'), 'utf8'))
      expect(written.list).toEqual(DE.list)
      // The source catalog is untouched.
      expect(readFileSync(join(repo, 'messages/en.json'), 'utf8')).toBe(json(EN))
    })
  })

  it('also translates =0 when the argument is the whole message', async () => {
    await withRepo(staged, 'de', (_repo, inv) => {
      const p = plan(inv)
      const codes = p.groups.find(
        (g) => g.plural && g.sites.some((id) => inv.sites.find((s) => s.id === id)?.file === 'messages/de.json' && inv.sites.find((s) => s.id === id)?.value === EN.list.codes),
      )!
      expect(codes.plural!.forms).toEqual({ one: 'You can ask for # more code.', other: 'You can ask for # more codes.' })
      expect(codes.plural!.exact).toEqual([{ selector: '=0', value: 'No more codes can be sent.' }])
      const folded = foldResults(
        [{ batchId: 'x', items: [{ id: codes.id, forms: { one: 'Noch # Code.', other: 'Noch # Codes.' } }] }],
        { groups: [codes] },
      )
      // An answer that leaves out the exact branch is incomplete, not accepted.
      expect(folded.accepted).toEqual([])
      expect(folded.rejected[0]!.violations.map((v) => v.message).join(' ')).toContain('=0')
    })
  })
})
