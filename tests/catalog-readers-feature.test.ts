import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'
import { plan } from '../src/plan'
import { buildVerify } from '../src/verify'
import { refreshInventory } from '../src/live'

const repos: string[] = []
function fixture(file: string, bytes: string | Buffer) {
  const repo = mkdtempSync(join(tmpdir(), 'catalog-reader-'))
  repos.push(repo)
  writeFileSync(join(repo, file), bytes)
  return repo
}
afterEach(() => { for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true }) })

for (const ext of ['strings', 'properties']) {
  it(`${ext}: stable keyed sites, escaped text and safe write/refresh/verify`, async () => {
    const file = `messages.${ext}`
    const source = ext === 'strings'
      ? '/* Translator context, unchanged. */\n"label" = "Bonjour le monde %@\\n"; "hint" = "Ouvrir les réglages";\n'
      : '# Translator context, unchanged.\nlabel = Bonjour le monde {0}\\n\nhint: Ouvrir les réglages\n'
    const repo = fixture(file, source)
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const sites = inv.sites.filter(s => s.extractor === ext)
    expect(sites).toHaveLength(2)
    const site = sites.find(s => s.siteKey.endsWith('#/label'))!
    expect(site.value).toBe(`Bonjour le monde ${ext === 'strings' ? '%@' : '{0}'}\n`)
    const target = `Hello "reader" ${ext === 'strings' ? '%@' : '{0}'}\nC:\\data 😀`
    expect(apply({ repo, inventory: inv, translations: [{ id: site.id, text: target }], write: true }).ok).toBe(true)
    const live = await refreshInventory(repo, inv)
    expect(live.sites.find(s => s.id === site.id)?.value).toBe(target)
    expect(readFileSync(join(repo, file), 'utf8')).toContain('Translator context, unchanged.')
    const p = plan(inv, { mode: 'swap' })
    const todo = buildVerify({ repo, inventory: inv, live, plan: p, sampleRate: 1 })
    expect(todo.pairs.some(pair => pair.siteId === site.id)).toBe(true)
  })

  it(`${ext}: refuses dropped or invented format placeholders`, async () => {
    const repo = fixture(`a.${ext}`, ext === 'strings' ? '"label" = "Bonjour le monde %1$@";' : 'label=Bonjour le monde {0}\n')
    const inventory = await scan({ repo, from: 'fr', to: 'en' })
    const site = inventory.sites.find(s => s.extractor === ext)!
    expect(site).toBeDefined()
    for (const text of ['Hello reader', 'Hello reader %2$d {9}']) {
      const report = apply({ repo, inventory, translations: [{ id: site.id, text }], write: true })
      expect(report.ok).toBe(false)
      const outcome = report.outcomes[0]
      expect(outcome && 'why' in outcome ? outcome.why : '').toMatch(/placeholder/)
    }
  })

  it(`${ext}: UTF8 BOM spans remain byte-addressable`, async () => {
    const body = ext === 'strings' ? '"label"="Bonjour le monde";' : 'label=Bonjour le monde\n'
    const repo = fixture(`a.${ext}`, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]))
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find(s => s.extractor === ext)!
    expect(site).toBeDefined()
    expect(apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello world' }], write: true }).ok).toBe(true)
    expect(readFileSync(join(repo, `a.${ext}`)).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect((await refreshInventory(repo, inv)).sites.find(s => s.id === site.id)?.value).toBe('Hello world')
  })

  it(`${ext}: UTF16 is inventoried but refused for writing`, async () => {
    const body = ext === 'strings' ? '"label"="Bonjour le monde";' : 'label=Bonjour le monde\n'
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')])
    const repo = fixture(`a.${ext}`, bytes)
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find(s => s.extractor === ext)!
    expect(site).toBeDefined()
    expect(apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello world' }], write: true }).ok).toBe(false)
    expect(readFileSync(join(repo, `a.${ext}`))).toEqual(bytes)
  })
}

it('properties decodes escaped keys, Unicode, continuations and significant trailing spaces', async () => {
  const repo = fixture('a.properties', 'my\\ key\\:x = Bonjour\\u0020le\\\r\n  monde  \r\n')
  const inv = await scan({ repo, from: 'fr', to: 'en' })
  const site = inv.sites.find(s => s.extractor === 'properties')!
  expect(site).toBeDefined()
  expect(site.siteKey).toBe('a.properties#/my key:x')
  expect(site.value).toBe('Bonjour lemonde  ')
  expect(apply({ repo, inventory: inv, translations: [{ id: site.id, text: ' Hello world  ' }], write: true }).ok).toBe(true)
  expect((await refreshInventory(repo, inv)).sites.find(s => s.id === site.id)?.value).toBe(' Hello world  ')
})

it('Latin1 properties are readable but never rewritten as UTF8 accidentally', async () => {
  const bytes = Buffer.from('label=Créez votre espace de travail\n', 'latin1')
  const repo = fixture('a.properties', bytes)
  const inv = await scan({ repo, from: 'fr', to: 'en' })
  const site = inv.sites.find(s => s.extractor === 'properties')!
  expect(site.value).toBe('Créez votre espace de travail')
  const result = apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Create your workspace' }], write: true })
  expect(result.ok).toBe(false)
  expect(readFileSync(join(repo, 'a.properties'))).toEqual(bytes)
})

for (const [file, body] of [
  ['a.strings', '"label"="Bonjour le monde"; "label"="Autre message";'],
  ['a.strings', '"label"="Bonjour\\q le monde";'],
  ['a.strings', '"label"="Bonjour le monde"'],
  ['a.strings', '"x"='],
  ['a.properties', 'label=Bonjour le monde\nlabel=Autre message\n'],
  ['a.properties', 'label=Bonjour\\uQQQQ le monde\n'],
  ['a.properties', 'label=Bonjour le monde\rhint=Autre message\r'],
  ['a.properties', 'label\n'],
]) {
  it(`refuses malformed/ambiguous catalog ${JSON.stringify(body)}`, async () => {
    const repo = fixture(file!, body!)
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    expect(inv.sites.some(s => s.verdict === 'unclassified')).toBe(true)
    expect(inv.sites.some(s => s.extractor === 'strings' || s.extractor === 'properties')).toBe(false)
  })
}
