import { describe, it, expect } from 'vitest'
import { validate, validatePlural, rejects, braceSkeleton } from '../src/validate'
import type { Group } from '../src/plan'

function group(text: string, over: Partial<Group> = {}): Group {
  return {
    id: 'g_1',
    text,
    role: 'label',
    roleClass: 'ui-short',
    status: 'pending',
    max: null,
    holes: [],
    holeGloss: {},
    sites: ['ul_1'],
    mirrors: [],
    ...over,
  }
}

describe('V1 — placeholders', () => {
  it('rejects a dropped hole', () => {
    expect(rejects(validate(group('Move {0} up'), 'Monter vers le haut'))).toBe(true)
  })

  it('accepts a reordered hole', () => {
    expect(rejects(validate(group('Move {0} up'), 'Monter {0} vers le haut'))).toBe(false)
  })

  it('rejects an invented hole', () => {
    expect(rejects(validate(group('Move up'), 'Monter {0}'))).toBe(true)
  })
})

describe('V2 — brace structure', () => {
  it('still catches the classic near-miss: a letter O for a zero', () => {
    const v = validate(group('Move {0} up'), 'Monter {O} vers le haut')
    expect(rejects(v)).toBe(true)
  })

  // The regression that mattered: brace-bearing syntax used to be rejected
  // outright, which made every ICU and every {{count}} bundle unshippable.
  it('accepts an ICU message whose structure is unchanged', () => {
    const src = '{count, plural, one {# item} other {# items}}'
    const tgt = '{count, plural, one {# élément} other {# éléments}}'
    expect(validate(group(src), tgt)).toEqual([])
  })

  it('accepts a bundle string carrying a named placeholder', () => {
    expect(validate(group('{{count}} items'), '{{count}} éléments')).toEqual([])
  })

  it('rejects a translation that loses one side of a brace pair', () => {
    expect(rejects(validate(group('{{count}} items'), '{{count éléments'))).toBe(true)
  })

  it('rejects a translation that invents a brace', () => {
    expect(rejects(validate(group('Save'), 'Enregistrer {}'))).toBe(true)
  })

  it('builds a skeleton from braces alone', () => {
    expect(braceSkeleton('Move {0} up')).toBe('')
    expect(braceSkeleton('{{count}} items')).toBe('{{}}')
    expect(braceSkeleton('{n, plural, one {#} other {#}}')).toBe('{{}{}}')
  })
})

describe('V3 — host syntax', () => {
  it('rejects a translation that started writing code', () => {
    expect(rejects(validate(group('Hello'), 'Bonjour ${name}'))).toBe(true)
  })
})

describe('V4 — identical', () => {
  it('warns rather than rejects, so a cognate does not fail a run', () => {
    const v = validate(group('Notifications'), 'Notifications')
    expect(rejects(v)).toBe(false)
  })
})

describe('V5 — length', () => {
  it('rejects a label that will overflow its container', () => {
    expect(rejects(validate(group('Save', { max: 8 }), 'Enregistrer les modifications'))).toBe(true)
  })
})

describe('V9 — plural completeness', () => {
  const target = ['one', 'few', 'many', 'other']

  it('accepts exactly the forms the target selects', () => {
    expect(
      validatePlural(
        { one: '# товар', few: '# товара', many: '# товаров', other: '# товара' },
        target,
        ['#'],
      ),
    ).toEqual([])
  })

  it('rejects a missing form, which falls back in front of a user', () => {
    const v = validatePlural({ one: 'a', other: 'b' }, target, [])
    expect(rejects(v)).toBe(true)
    expect(v.map((x) => x.message).join(' ')).toContain('few')
  })

  it('rejects a form the target never selects, which is a dead key', () => {
    const v = validatePlural({ one: 'a', other: 'b', two: 'c' }, ['one', 'other'], [])
    expect(rejects(v)).toBe(true)
    expect(v.map((x) => x.message).join(' ')).toContain('never selects')
  })

  it('rejects an empty form', () => {
    expect(rejects(validatePlural({ one: 'a', other: '  ' }, ['one', 'other'], []))).toBe(true)
  })

  it('lets a form drop the number, because "One item" is better than "1 item"', () => {
    expect(validatePlural({ one: 'One item', other: '# items' }, ['one', 'other'], ['#'])).toEqual([])
  })

  it('rejects a placeholder no source form has, because nothing will substitute it', () => {
    const v = validatePlural({ one: '{total} item', other: '# items' }, ['one', 'other'], ['#'])
    expect(rejects(v)).toBe(true)
    expect(v.map((x) => x.message).join(' ')).toContain('{total}')
  })

  it('rejects a form that started writing code', () => {
    expect(rejects(validatePlural({ one: '${n} item', other: '# items' }, ['one', 'other'], ['#', '${n}']))).toBe(true)
  })

  it('lets =N exact branches ride through', () => {
    expect(validatePlural({ '=0': 'none', one: 'a', other: 'b' }, ['one', 'other'], [])).toEqual([])
  })

  it('accepts a single form for a language that has one', () => {
    expect(validatePlural({ other: '#件' }, ['other'], ['#'])).toEqual([])
  })
})
