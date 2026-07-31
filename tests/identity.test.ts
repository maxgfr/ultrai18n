import { describe, it, expect } from 'vitest'
import {
  siteId,
  contentHash,
  dupKey,
  pointer,
  disambiguate,
  reconcile,
  ordinalDistance,
  type ReconcileInput,
} from '../src/identity'

describe('keys', () => {
  it('gives the same site the same id across runs', () => {
    const k = 'package.json#/description'
    expect(siteId(k)).toBe(siteId(k))
    expect(siteId(k)).toMatch(/^ul_[0-9a-f]{12}$/)
  })

  it('changes contentHash when the value changes, so a pinned exception is voided', () => {
    expect(contentHash('Yes, erase it all')).toBe(contentHash('Yes, erase it all'))
    expect(contentHash('Yes, erase it all')).not.toBe(contentHash('Oui, tout effacer'))
  })

  it('does NOT fold case when grouping', () => {
    // basilico: `focus: 'Focus'` — key is a persisted enum, value is a label.
    // Folding these together would give both one translation and reset user data.
    expect(dupKey('Focus')).not.toBe(dupKey('focus'))
  })

  it('groups the same copy across files despite whitespace', () => {
    expect(dupKey('Short break')).toBe(dupKey('  Short   break '))
  })
})

describe('pointer', () => {
  it('escapes RFC 6901 special characters', () => {
    expect(pointer(['description'])).toBe('/description')
    expect(pointer(['body', 0, 'attributes', 'label'])).toBe('/body/0/attributes/label')
    expect(pointer(['a/b'])).toBe('/a~1b')
    expect(pointer(['a~b'])).toBe('/a~0b')
    expect(pointer([])).toBe('')
  })
})

describe('disambiguate', () => {
  it('never lets one site shadow another', () => {
    // Losing a site to a key collision is the one failure this tool cannot have.
    expect(disambiguate(['a', 'b', 'a', 'a'])).toEqual(['a', 'b', 'a~2', 'a~3'])
  })
})

describe('ordinalDistance', () => {
  it('is 0 for identical anchors', () => {
    expect(ordinalDistance('f.tsx#A/li[3]', 'f.tsx#A/li[3]')).toBe(0)
  })

  it('measures renumbering', () => {
    expect(ordinalDistance('f.tsx#A/li[3]', 'f.tsx#A/li[5]')).toBe(2)
  })

  it('is infinite when the structure differs, not merely the numbers', () => {
    expect(ordinalDistance('f.tsx#A/li[3]', 'f.tsx#B/li[3]')).toBe(Infinity)
    expect(ordinalDistance('f.tsx#A/li[3]', 'f.tsx#A/li[3]/span[1]')).toBe(Infinity)
  })
})

const site = (o: Partial<ReconcileInput> & { siteKey: string }): ReconcileInput => ({
  file: 'a.tsx',
  surface: 'ui.jsx-text',
  contentHash: 'aaaa',
  dupKey: 'dddd',
  ...o,
})

describe('reconcile', () => {
  it('matches unchanged sites exactly', () => {
    const prev = [site({ siteKey: 'a.tsx#A/p[1]' })]
    const cur = [site({ siteKey: 'a.tsx#A/p[1]' })]
    expect(reconcile(prev, cur).map((m) => m.tier)).toEqual(['same'])
  })

  it('follows a site whose anchor changed but whose text did not', () => {
    // A wrapper element was added around it.
    const prev = [site({ siteKey: 'a.tsx#A/p[1]' })]
    const cur = [site({ siteKey: 'a.tsx#A/div[1]/p[1]' })]
    const m = reconcile(prev, cur)
    expect(m.map((x) => x.tier)).toEqual(['moved'])
    expect(m[0]!.previous!.siteKey).toBe('a.tsx#A/p[1]')
  })

  it('follows a renumbered sibling within 3 ordinals', () => {
    const prev = [site({ siteKey: 'a.tsx#A/li[2]', contentHash: 'old' })]
    const cur = [site({ siteKey: 'a.tsx#A/li[4]', contentHash: 'new' })]
    expect(reconcile(prev, cur).map((m) => m.tier)).toEqual(['renumbered'])
  })

  it('refuses to pair distant siblings that merely share their words', () => {
    const prev = [site({ siteKey: 'a.tsx#A/li[1]', contentHash: 'old' })]
    const cur = [site({ siteKey: 'a.tsx#A/li[40]', contentHash: 'new' })]
    const tiers = reconcile(prev, cur).map((m) => m.tier).sort()
    expect(tiers).toEqual(['added', 'removed'])
  })

  it('reports genuinely new and genuinely gone sites', () => {
    const prev = [site({ siteKey: 'a.tsx#A/p[1]', contentHash: 'x', dupKey: 'x' })]
    const cur = [site({ siteKey: 'b.tsx#B/p[1]', file: 'b.tsx', contentHash: 'y', dupKey: 'y' })]
    const tiers = reconcile(prev, cur).map((m) => m.tier).sort()
    expect(tiers).toEqual(['added', 'removed'])
  })

  it('never matches one previous site to two current ones', () => {
    const prev = [site({ siteKey: 'a.tsx#A/p[1]' })]
    const cur = [site({ siteKey: 'a.tsx#A/p[1]' }), site({ siteKey: 'a.tsx#A/p[2]' })]
    const m = reconcile(prev, cur)
    expect(m.filter((x) => x.previous?.siteKey === 'a.tsx#A/p[1]')).toHaveLength(1)
    expect(m.map((x) => x.tier).sort()).toEqual(['added', 'same'])
  })
})
