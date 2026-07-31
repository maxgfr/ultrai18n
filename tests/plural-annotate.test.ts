import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFields, readPragmas, readSidecar, danglingSidecarKeys } from '../src/plural/annotate'
import type { Site } from '../src/types'

function site(over: Partial<Site> & { value: string; span: { start: number; end: number } }): Site {
  return {
    id: 'ul_' + over.span.start,
    siteKey: `a.ts#${over.span.start}`,
    kind: 'string-literal',
    file: 'a.ts',
    ...over,
  } as Site
}

describe('parsing a pragma', () => {
  it('reads bare, single- and double-quoted values', () => {
    expect(parseFields(`// ultrai18n:plural count=n one="One item" other='{0} items'`)).toEqual({
      count: 'n',
      one: 'One item',
      other: '{0} items',
    })
  })

  it('keeps an escaped quote inside a value', () => {
    expect(parseFields(`ultrai18n:plural one="l\\"élément"`)).toEqual({ one: 'l"élément' })
  })

  it('ignores anything before the marker', () => {
    expect(parseFields(`some prose here ultrai18n:plural count=total`)).toEqual({ count: 'total' })
  })

  it('returns nothing for a comment with no fields', () => {
    expect(parseFields('// ultrai18n:plural')).toEqual({})
  })
})

describe('attaching a pragma to a site', () => {
  const comment = (value: string, start: number): Site =>
    site({ value, span: { start, end: start + value.length }, kind: 'comment' })

  it('applies to the next non-comment site after it', () => {
    const sites = [
      comment('ultrai18n:plural count=n one="One item" other="{0} items"', 0),
      site({ value: '{0} item{1}', span: { start: 100, end: 120 } }),
    ]
    const [family] = readPragmas(sites)
    expect(family!.siteId).toBe(sites[1]!.id)
    expect(family!.count).toBe('n')
    expect(family!.forms.map((f) => f.category)).toEqual(['one', 'other'])
    expect(family!.pragmaSiteId).toBe(sites[0]!.id)
  })

  it('skips over further comments to reach the code', () => {
    const sites = [
      comment('ultrai18n:plural one="a" other="b"', 0),
      comment('an ordinary remark', 50),
      site({ value: 'target', span: { start: 100, end: 110 } }),
    ]
    expect(readPragmas(sites)[0]!.siteId).toBe(sites[2]!.id)
  })

  it('declares a family with no forms when only a count is given', () => {
    const sites = [
      comment('ultrai18n:plural count=items', 0),
      site({ value: 'x', span: { start: 100, end: 110 } }),
    ]
    const [family] = readPragmas(sites)
    expect(family!.forms).toEqual([])
    expect(family!.count).toBe('items')
  })

  it('ignores a comment with nothing after it', () => {
    expect(readPragmas([comment('ultrai18n:plural one="a"', 0)])).toEqual([])
  })

  it('ignores an ordinary comment', () => {
    const sites = [comment('just a remark', 0), site({ value: 'x', span: { start: 100, end: 101 } })]
    expect(readPragmas(sites)).toEqual([])
  })
})

describe('the sidecar', () => {
  const sites = [site({ value: 'x', span: { start: 0, end: 1 } })]
  const write = (body: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ultrai18n-sidecar-'))
    const path = join(dir, 'plurals.json')
    writeFileSync(path, JSON.stringify(body))
    return path
  }

  it('declares a family keyed on the structural anchor', () => {
    const path = write({
      families: [{ siteKey: sites[0]!.siteKey, count: 'n', forms: { one: 'a', other: 'b' } }],
    })
    const [family] = readSidecar(path, sites)
    expect(family!.origin).toBe('sidecar')
    expect(family!.forms.map((f) => f.value)).toEqual(['a', 'b'])
    rmSync(path, { force: true })
  })

  it('drops a form whose key is not a CLDR category', () => {
    const path = write({ families: [{ siteKey: sites[0]!.siteKey, forms: { one: 'a', plural: 'b' } }] })
    expect(readSidecar(path, sites)[0]!.forms.map((f) => f.category)).toEqual(['one'])
    rmSync(path, { force: true })
  })

  it('reports a declaration whose site no longer exists rather than dropping it', () => {
    const path = write({ families: [{ siteKey: 'gone.ts#/nowhere', forms: { other: 'x' } }] })
    expect(readSidecar(path, sites)).toEqual([])
    expect(danglingSidecarKeys(path, sites)).toEqual(['gone.ts#/nowhere'])
    rmSync(path, { force: true })
  })

  it('is absent rather than empty when there is no file', () => {
    expect(readSidecar('/no/such/plurals.json', sites)).toEqual([])
    expect(danglingSidecarKeys('/no/such/plurals.json', sites)).toEqual([])
  })

  it('refuses unreadable JSON out loud', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ultrai18n-sidecar-'))
    const path = join(dir, 'plurals.json')
    writeFileSync(path, '{ not json')
    expect(() => readSidecar(path, sites)).toThrow(/not readable JSON/)
    rmSync(dir, { recursive: true, force: true })
  })
})
