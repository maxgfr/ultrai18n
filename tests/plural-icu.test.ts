import { describe, it, expect } from 'vitest'
import {
  scanIcu,
  looksLikeIcu,
  serializeArgument,
  splice,
  branchPlaceholders,
  matchBrace,
} from '../src/plural/icu'

const SIMPLE = '{count, plural, one {# élément} other {# éléments}}'

describe('scanning', () => {
  it('finds a plural argument and its branches', () => {
    const scan = scanIcu(SIMPLE)
    expect(scan.ok).toBe(true)
    expect(scan.arguments).toHaveLength(1)
    const arg = scan.arguments[0]!
    expect(arg.name).toBe('count')
    expect(arg.type).toBe('plural')
    expect(arg.branches.map((b) => b.selector)).toEqual(['one', 'other'])
    expect(arg.branches.map((b) => b.body)).toEqual(['# élément', '# éléments'])
  })

  it('reports the branch body span, not the braces', () => {
    const arg = scanIcu(SIMPLE).arguments[0]!
    const one = arg.branches[0]!
    expect(SIMPLE.slice(one.start, one.end)).toBe('# élément')
  })

  it('keeps =N exact matches apart from the categories', () => {
    const text = '{n, plural, =0 {nothing} one {# thing} other {# things}}'
    const arg = scanIcu(text).arguments[0]!
    expect(arg.branches.map((b) => [b.selector, b.category])).toEqual([
      ['=0', null],
      ['one', 'one'],
      ['other', 'other'],
    ])
  })

  it('reads an offset', () => {
    const arg = scanIcu('{n, plural, offset:1 one {# other} other {# others}}').arguments[0]!
    expect(arg.offset).toBe(1)
    expect(arg.branches).toHaveLength(2)
  })

  it('reads selectordinal', () => {
    const arg = scanIcu('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}').arguments[0]!
    expect(arg.type).toBe('selectordinal')
    expect(arg.branches).toHaveLength(4)
  })

  it('finds a plural nested inside a select', () => {
    const text = '{gender, select, male {{n, plural, one {he has # cat} other {he has # cats}}} other {none}}'
    const scan = scanIcu(text)
    const plural = scan.arguments.find((a) => a.type === 'plural')
    expect(plural).toBeDefined()
    expect(plural!.depth).toBe(1)
    expect(plural!.branches.map((b) => b.selector)).toEqual(['one', 'other'])
  })

  it('leaves a lone apostrophe alone, because French UI text is full of them', () => {
    // ICU 4.8+: an apostrophe only quotes when it precedes a syntax character.
    const text = "{n, plural, one {l'élément} other {les éléments}}"
    const arg = scanIcu(text).arguments[0]!
    expect(arg.branches[0]!.body).toBe("l'élément")
  })

  it('honours a quoted brace', () => {
    const text = "{n, plural, one {a '{' brace} other {braces}}"
    const arg = scanIcu(text).arguments[0]!
    expect(arg.branches).toHaveLength(2)
    expect(arg.branches[0]!.body).toBe("a '{' brace")
  })

  it('collects simple placeholders separately from branch arguments', () => {
    const scan = scanIcu('Hello {name}, you have {count, plural, one {# msg} other {# msgs}}')
    expect(scan.placeholders).toContain('name')
    expect(scan.arguments).toHaveLength(1)
  })

  it('reports unbalanced braces rather than guessing', () => {
    expect(scanIcu('{count, plural, one {# item other {# items}}').ok).toBe(false)
  })

  it('does not claim a plain interpolation is a plural', () => {
    expect(looksLikeIcu('Hello {name}')).toBe(false)
    expect(scanIcu('Hello {name}').arguments).toEqual([])
    expect(looksLikeIcu(SIMPLE)).toBe(true)
  })

  it('matches the outermost brace across nesting', () => {
    const text = '{a, plural, one {{b, plural, one {x} other {y}}} other {z}}'
    expect(matchBrace(text, 0)).toBe(text.length - 1)
  })
})

describe('serializing', () => {
  it('rebuilds a family with MORE forms than the source had', () => {
    // The en→ru case, which no 1-text-in-1-text-out pipeline can express.
    const arg = scanIcu(SIMPLE).arguments[0]!
    const out = serializeArgument(
      arg,
      { one: '# элемент', few: '# элемента', many: '# элементов', other: '# элемента' },
      ['one', 'few', 'many', 'other'],
    )
    expect(out).toBe(
      '{count, plural, one {# элемент} few {# элемента} many {# элементов} other {# элемента}}',
    )
    expect(scanIcu(out).arguments[0]!.branches).toHaveLength(4)
  })

  it('collapses to one form for a language that has one', () => {
    const arg = scanIcu(SIMPLE).arguments[0]!
    expect(serializeArgument(arg, { other: '#件' }, ['other'])).toBe('{count, plural, other {#件}}')
  })

  it('keeps =N ahead of the categories, because ICU tries exact matches first', () => {
    const arg = scanIcu('{n, plural, =0 {none} one {#} other {#}}').arguments[0]!
    const out = serializeArgument(arg, { '=0': 'aucun', one: '#', other: '#' }, ['one', 'other'])
    expect(out.indexOf('=0')).toBeLessThan(out.indexOf('one'))
  })

  it('preserves the offset', () => {
    const arg = scanIcu('{n, plural, offset:1 one {#} other {#}}').arguments[0]!
    expect(serializeArgument(arg, { one: 'a', other: 'b' }, ['one', 'other'])).toContain('offset:1')
  })

  it('round-trips a message through scan and serialize', () => {
    const arg = scanIcu(SIMPLE).arguments[0]!
    const bodies = Object.fromEntries(arg.branches.map((b) => [b.selector, b.body]))
    const out = serializeArgument(arg, bodies, ['one', 'other'])
    expect(scanIcu(out).arguments[0]!.branches.map((b) => b.body)).toEqual([
      '# élément',
      '# éléments',
    ])
  })
})

describe('splice', () => {
  it('replaces spans without disturbing the offsets of the ones still to come', () => {
    expect(
      splice('a XX b YY c', [
        { start: 2, end: 4, text: '1' },
        { start: 7, end: 9, text: '22' },
      ]),
    ).toBe('a 1 b 22 c')
  })
})

describe('branch placeholders', () => {
  it('counts # as a placeholder, because dropping it loses the number', () => {
    expect(branchPlaceholders('# éléments')).toEqual(['#'])
    expect(branchPlaceholders('éléments')).toEqual([])
  })

  it('counts named arguments too', () => {
    expect(branchPlaceholders('# of {total}')).toEqual(['#', '{total}'])
  })

  it('does not count a quoted #', () => {
    expect(branchPlaceholders("a '#' sign")).toEqual([])
  })
})
