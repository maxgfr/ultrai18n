import { describe, it, expect } from 'vitest'
import { extractJson } from '../src/extract/json'
import { OffsetMap } from '../src/vendor/text'

const run = (src: string, file = 'package.json') => extractJson(file, src, new OffsetMap(src))
const byPath = (src: string, file?: string) =>
  Object.fromEntries(run(src, file).sites.map((s) => [s.path, s.value]))

describe('the founding case', () => {
  it('finds package.json description by pointer', () => {
    // The miss that motivated the tool: read as dependency config, never as copy.
    const src = `{
  "name": "basilico",
  "description": "Un minuteur de focus local-first, avec tâches et alertes.",
  "keywords": ["pomodoro", "minuteur"]
}`
    const paths = byPath(src)
    expect(paths['/description']).toBe('Un minuteur de focus local-first, avec tâches et alertes.')
    expect(paths['/name']).toBe('basilico')
    expect(paths['/keywords/0']).toBe('pomodoro')
    expect(paths['/keywords/1']).toBe('minuteur')
  })

  it('separates keys from values', () => {
    const { sites } = run(`{"description": "hi"}`)
    const key = sites.find((s) => s.kind === 'key')!
    const value = sites.find((s) => s.kind === 'scalar')!
    expect(key.value).toBe('description')
    expect(key.container.isKey).toBe(true)
    expect(value.value).toBe('hi')
    expect(value.container.isKey).toBe(false)
  })
})

describe('pointers', () => {
  it('walks nested objects and arrays', () => {
    const src = `{"a": {"b": ["x", {"c": "y"}]}}`
    const paths = byPath(src)
    expect(paths['/a/b/0']).toBe('x')
    expect(paths['/a/b/1/c']).toBe('y')
  })

  it('indexes array elements independently', () => {
    const paths = byPath(`{"k": ["one", "two", "three"]}`)
    expect(paths['/k/0']).toBe('one')
    expect(paths['/k/2']).toBe('three')
  })

  it('escapes RFC 6901 characters in keys', () => {
    const paths = byPath(`{"a/b": "v"}`)
    expect(paths['/a~1b']).toBe('v')
  })
})

describe('tolerance', () => {
  it('reads JSONC comments as sites, because a comment may be the last French left', () => {
    const src = `{
  // Le thème vit ici
  "a": 1
}`
    const { sites, complete } = run(src, 'tsconfig.json')
    expect(complete).toBe(true)
    expect(sites.find((s) => s.kind === 'comment')!.value).toBe('Le thème vit ici')
  })

  it('survives trailing commas', () => {
    const { complete, sites } = run(`{"a": "x",}`, 'tsconfig.json')
    expect(complete).toBe(true)
    expect(sites.find((s) => s.kind === 'scalar')!.value).toBe('x')
  })

  it('reports incompleteness rather than pretending to have read the file', () => {
    // Silently returning what it managed to read is how a file half-scans and
    // reports clean.
    expect(run(`{"a": "unterminated`).complete).toBe(false)
  })
})

describe('byte offsets', () => {
  it('round-trips accented values', () => {
    const src = `{"description": "Données effacées."}`
    const { sites } = run(src)
    const site = sites.find((s) => s.value === 'Données effacées.')!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')).toBe(
      'Données effacées.',
    )
    expect(buf.subarray(site.span.start, site.span.end).toString('utf8')).toBe('"Données effacées."')
  })

  it('decodes escapes into the value but keeps raw intact', () => {
    const src = String.raw`{"a": "Oui, c'est \"fini\""}`
    const { sites } = run(src)
    const site = sites.find((s) => s.kind === 'scalar')!
    expect(site.value).toBe(`Oui, c'est "fini"`)
    expect(site.escapes).toBe(true)
  })

  it('decodes \\u escapes so language detection sees real characters', () => {
    const { sites } = run(String.raw`{"a": "Données"}`)
    expect(sites.find((s) => s.kind === 'scalar')!.value).toBe('Données')
  })
})

describe('accounting', () => {
  it('claims every byte of a well-formed document', () => {
    // claimRatio is what makes "no sites found" a measurement rather than a
    // guess. A scanner that bailed early must not look like a clean file.
    const src = `{"a": 1, "b": [true, null], "c": "x"}`
    const { claimedBytes, complete } = run(src)
    expect(complete).toBe(true)
    expect(claimedBytes).toBe(src.length)
  })

  it('collects keys for the repo identifier vocabulary', () => {
    const { keys } = run(`{"scripts": {"build": "tsup"}}`)
    expect([...keys].sort()).toEqual(['build', 'scripts'])
  })
})
