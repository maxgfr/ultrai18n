// Writing a key that does not exist yet.
//
// The one case where replacing bytes cannot express the result: Russian needs
// `few` and `many`, an English source has neither, and there is no span to
// overwrite. Everything here is about keeping that narrow — a sibling of a key
// that is already there, in a format whose shape is known, and a refusal
// otherwise.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-insert-'))
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const write = (rel: string, body: string): void => {
  const dir = join(repo, rel.split('/').slice(0, -1).join('/'))
  if (dir !== repo) mkdirSync(dir, { recursive: true })
  writeFileSync(join(repo, rel), body)
}
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')

async function anchor(rel: string, value: string) {
  const inv = await scan({ repo, from: 'en', to: 'ru' })
  const site = inv.sites.find((s) => s.file === rel && s.value === value && s.kind !== 'key')
  if (!site) throw new Error(`no site for ${JSON.stringify(value)} in ${rel}`)
  return { inv, site }
}

describe('JSON bundles', () => {
  it('writes a new sibling after the anchor, keeping its indentation', async () => {
    write(
      'locales/ru/common.json',
      '{\n  "cart": {\n    "item_one": "товар",\n    "item_other": "товаров"\n  }\n}\n',
    )
    const { inv, site } = await anchor('locales/ru/common.json', 'товаров')
    const report = apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [
        { afterSiteId: site.id, key: 'item_few', text: 'товара', order: 0 },
        { afterSiteId: site.id, key: 'item_many', text: 'товаров', order: 1 },
      ],
      write: true,
    })

    expect(report.ok).toBe(true)
    expect(report.sites.inserted).toBe(2)
    expect(read('locales/ru/common.json')).toBe(
      '{\n  "cart": {\n    "item_one": "товар",\n    "item_other": "товаров",\n' +
        '    "item_few": "товара",\n    "item_many": "товаров"\n  }\n}\n',
    )
    expect(() => JSON.parse(read('locales/ru/common.json'))).not.toThrow()
  })

  it('stays valid when the anchor is NOT the last key in its object', async () => {
    write('locales/ru/c.json', '{\n  "item_one": "a",\n  "greeting": "b"\n}\n')
    const { inv, site } = await anchor('locales/ru/c.json', 'a')
    apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [{ afterSiteId: site.id, key: 'item_other', text: 'c' }],
      write: true,
    })
    const parsed = JSON.parse(read('locales/ru/c.json'))
    expect(parsed).toEqual({ item_one: 'a', item_other: 'c', greeting: 'b' })
  })

  it('escapes the new value for its host', async () => {
    write('locales/ru/c.json', '{\n  "item_one": "a"\n}\n')
    const { inv, site } = await anchor('locales/ru/c.json', 'a')
    apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [{ afterSiteId: site.id, key: 'item_other', text: 'say "hi"\nagain' }],
      write: true,
    })
    expect(JSON.parse(read('locales/ru/c.json')).item_other).toBe('say "hi"\nagain')
  })

  it('writes nothing at all in a dry run', async () => {
    write('locales/ru/c.json', '{\n  "item_one": "a"\n}\n')
    const before = read('locales/ru/c.json')
    const { inv, site } = await anchor('locales/ru/c.json', 'a')
    const report = apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [{ afterSiteId: site.id, key: 'item_other', text: 'b' }],
    })
    expect(report.write).toBe(false)
    expect(read('locales/ru/c.json')).toBe(before)
  })
})

describe('YAML bundles', () => {
  it('writes a new key on its own line at the sibling indentation', async () => {
    write('config/locales/ru.yml', 'ru:\n  tasks:\n    one: одна задача\n    other: задач\n')
    const { inv, site } = await anchor('config/locales/ru.yml', 'задач')
    const report = apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [{ afterSiteId: site.id, key: 'few', text: 'задачи' }],
      write: true,
    })
    expect(report.ok).toBe(true)
    expect(read('config/locales/ru.yml')).toBe(
      'ru:\n  tasks:\n    one: одна задача\n    other: задач\n    few: "задачи"\n',
    )
  })
})

describe('refusals', () => {
  it('refuses to invent markup in a format it did not parse structurally', async () => {
    write(
      'res/values/strings.xml',
      '<resources>\n  <plurals name="n">\n    <item quantity="one">One task</item>\n  </plurals>\n</resources>\n',
    )
    const before = read('res/values/strings.xml')
    const { inv, site } = await anchor('res/values/strings.xml', 'One task')
    const report = apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [{ afterSiteId: site.id, key: 'other', text: 'Many tasks' }],
      write: true,
    })
    expect(report.ok).toBe(false)
    expect(report.outcomes.some((o) => o.status === 'refused' && /only supported in JSON and YAML/.test((o as { why: string }).why))).toBe(true)
    expect(read('res/values/strings.xml')).toBe(before)
  })

  it('refuses an anchor that is not in the inventory', () => {
    const report = apply({
      repo,
      inventory: { schemaVersion: 1, repo, sourceLanguage: 'en', targetLanguage: 'ru', sites: [], census: [], advisories: [], limits: [], recallClaim: 'full', plurals: [], pluralResidual: [] },
      translations: [],
      insertions: [{ afterSiteId: 'ul_nope', key: 'few', text: 'x' }],
      write: true,
    })
    expect(report.ok).toBe(false)
    expect(report.outcomes[0]!.status).toBe('refused')
  })

  it('refuses rather than guessing when the anchor has drifted', async () => {
    write('locales/ru/c.json', '{\n  "item_one": "a"\n}\n')
    const { inv, site } = await anchor('locales/ru/c.json', 'a')
    // An insertion has no text of its own to relocate by, so unlike a
    // replacement there is no recovery path — "roughly where that key used to
    // be" is not a position.
    write('locales/ru/c.json', '{\n  "renamed": "a"\n}\n')
    const report = apply({
      repo,
      inventory: inv,
      translations: [],
      insertions: [{ afterSiteId: site.id, key: 'item_other', text: 'b' }],
      write: true,
    })
    expect(report.ok).toBe(false)
    expect(report.outcomes.some((o) => o.status === 'refused' && /drift/.test((o as { why: string }).why))).toBe(true)
  })

  it('holds back the whole file when one insertion into it refuses', async () => {
    // File atomicity, applied to insertions: the XML insertion below refuses,
    // so the perfectly good translation sitting in the same file must not land
    // on its own and leave the file in a state nobody chose.
    write(
      'res/values/strings.xml',
      '<resources>\n  <string name="empty">Nothing here yet</string>\n' +
        '  <plurals name="n">\n    <item quantity="one">One task</item>\n  </plurals>\n</resources>\n',
    )
    const before = read('res/values/strings.xml')
    const inv = await scan({ repo, from: 'en', to: 'ru' })
    const one = inv.sites.find((s) => s.value === 'One task')!
    const empty = inv.sites.find((s) => s.value === 'Nothing here yet')!

    const report = apply({
      repo,
      inventory: inv,
      translations: [{ id: empty.id, text: 'Пока ничего нет' }],
      insertions: [{ afterSiteId: one.id, key: 'other', text: 'Много задач' }],
      write: true,
    })
    expect(report.ok).toBe(false)
    expect(read('res/values/strings.xml')).toBe(before)
  })

  it('leaves an unrelated file alone when another one refuses', async () => {
    write('locales/ru/c.json', '{\n  "greeting": "b"\n}\n')
    write(
      'res/values/strings.xml',
      '<resources>\n  <plurals name="n">\n    <item quantity="one">One task</item>\n  </plurals>\n</resources>\n',
    )
    const inv = await scan({ repo, from: 'en', to: 'ru' })
    const greeting = inv.sites.find((s) => s.value === 'b' && s.kind !== 'key')!
    const one = inv.sites.find((s) => s.value === 'One task')!

    apply({
      repo,
      inventory: inv,
      translations: [{ id: greeting.id, text: 'привет' }],
      insertions: [{ afterSiteId: one.id, key: 'other', text: 'x' }],
      write: true,
    })
    expect(JSON.parse(read('locales/ru/c.json')).greeting).toBe('привет')
  })
})
