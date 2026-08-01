import { describe, it, expect } from 'vitest'
import { detectFamilies, splitPluralKey } from '../src/plural/shapes'
import { DIALECTS } from '../src/plural/dialect/dialects'
import { PRIMITIVES } from '../src/plural/primitives'
import type { Site } from '../src/types'

/** A site with only the fields the shape detectors read. */
function site(path: string, value: string, over: Partial<Site> = {}): Site {
  const file = over.file ?? 'src/locales/en/common.json'
  return {
    id: 'ul_' + path.replace(/\W/g, ''),
    siteKey: `${file}#${path}`,
    kind: 'scalar',
    value,
    file,
    ...over,
  } as Site
}

const bundle = { isBundle: () => true }
const notBundle = { isBundle: () => false }

describe('key-suffix', () => {
  it('groups keys that differ only by their category', () => {
    const families = detectFamilies(
      [site('/item_one', '{{count}} item'), site('/item_other', '{{count}} items')],
      bundle,
    )
    expect(families).toHaveLength(1)
    expect(families[0]!.shape).toBe('key-suffix')
    expect(families[0]!.base).toBe('/item')
    expect(families[0]!.forms.map((f) => f.category)).toEqual(['one', 'other'])
  })

  it('reads a dotted separator as well as an underscore', () => {
    const families = detectFamilies(
      [site('/tasks/count.one', 'one'), site('/tasks/count.other', 'many')],
      bundle,
    )
    expect(families[0]!.base).toBe('/tasks/count')
  })

  it('reads the i18next v20 spelling', () => {
    const families = detectFamilies([site('/item', '1'), site('/item_plural', 'n')], bundle)
    // `_plural` is `other`; the bare `/item` is a different key and not a form.
    expect(families[0]!.forms.map((f) => f.category)).toEqual(['other'])
  })

  it('keeps ordinal families apart from cardinal ones', () => {
    const families = detectFamilies(
      [
        site('/place_one', '1st'),
        site('/place_other', 'nth'),
        site('/place_ordinal_one', '1st'),
        site('/place_ordinal_other', 'nth'),
      ],
      bundle,
    )
    expect(families).toHaveLength(2)
    expect(families.filter((f) => f.ordinal)).toHaveLength(1)
  })

  it('refuses a numeric suffix, which collides with an array index', () => {
    expect(detectFamilies([site('/item_0', 'a'), site('/item_1', 'b')], bundle)).toEqual([])
  })

  it('needs the locale-bundle context, so a stray key is not a family', () => {
    expect(detectFamilies([site('/button_one', 'Save')], notBundle)).toEqual([])
  })
})

describe('sibling-object', () => {
  it('groups category-named siblings of one object', () => {
    const families = detectFamilies(
      [site('/tasks/count/one', 'One task'), site('/tasks/count/other', '%{count} tasks')],
      bundle,
    )
    expect(families[0]!.shape).toBe('sibling-object')
    expect(families[0]!.base).toBe('/tasks/count')
  })

  it('needs two of them, because `other` alone is just a word', () => {
    expect(detectFamilies([site('/settings/other', 'Other settings')], bundle)).toEqual([])
  })
})

describe('inline-select', () => {
  it('finds an ICU plural wherever it lives, bundle or not', () => {
    const families = detectFamilies(
      [site('/inbox', 'You have {n, plural, one {# message} other {# messages}}')],
      notBundle,
    )
    expect(families[0]!.shape).toBe('inline-select')
    expect(families[0]!.forms.map((f) => f.value)).toEqual(['# message', '# messages'])
  })

  it('keeps =N branches out of the categories', () => {
    const families = detectFamilies(
      [site('/n', '{n, plural, =0 {none} one {#} other {#}}')],
      notBundle,
    )
    expect(families[0]!.exact).toEqual([{ selector: '=0', value: 'none' }])
    expect(families[0]!.forms.map((f) => f.category)).toEqual(['one', 'other'])
  })

  it('does not treat a bare select as a plural', () => {
    expect(
      detectFamilies([site('/g', '{g, select, male {he} female {she} other {they}}')], notBundle),
    ).toEqual([])
  })
})

describe('attr-quantity', () => {
  it('reads an Android plurals resource', () => {
    const families = detectFamilies(
      [
        site('plurals[task_count]/item[one]', 'One task', { file: 'res/values/strings.xml' }),
        site('plurals[task_count]/item[other]', '%d tasks', { file: 'res/values/strings.xml' }),
      ],
      notBundle,
    )
    expect(families[0]!.shape).toBe('attr-quantity')
    expect(families[0]!.forms).toHaveLength(2)
  })
})

describe('delimited', () => {
  it('reads vue-i18n positional forms', () => {
    const families = detectFamilies([site('/cars', 'no cars | one car | {count} cars')], bundle)
    expect(families[0]!.shape).toBe('delimited')
    expect(families[0]!.forms.map((f) => f.category)).toEqual(['zero', 'one', 'other'])
  })

  it('leaves a pipe that is not counting anything alone', () => {
    // The guard that stops every two-option string becoming a plural family.
    expect(detectFamilies([site('/actions', 'Save | Cancel')], bundle)).toEqual([])
  })

  it('needs the bundle context', () => {
    expect(detectFamilies([site('/cars', 'no cars | one car | {count} cars')], notBundle)).toEqual([])
  })
})

describe('precedence', () => {
  it('reads an ICU message under a _one key as ICU, not as a key family', () => {
    const families = detectFamilies(
      [
        site('/x_one', '{n, plural, one {# a} other {# b}}'),
        site('/x_other', '{n, plural, one {# c} other {# d}}'),
      ],
      bundle,
    )
    expect(families.every((f) => f.shape === 'inline-select')).toBe(true)
  })
})

describe('splitPluralKey', () => {
  it('splits both arrangements a catalog uses', () => {
    expect(splitPluralKey('/cart/item_few')).toMatchObject({ base: '/cart/item', category: 'few' })
    expect(splitPluralKey('/tasks/count/one')).toMatchObject({ base: '/tasks/count', category: 'one' })
    expect(splitPluralKey('/greeting')).toBe(null)
  })
})

describe('the dialect catalog', () => {
  it('cites evidence for every dialect, exactly as a catalog rule must', () => {
    expect(DIALECTS.filter((d) => !/^https?:\/\//.test(d.docs)).map((d) => d.id)).toEqual([])
  })

  it('has no duplicate ids', () => {
    expect(new Set(DIALECTS.map((d) => d.id)).size).toBe(DIALECTS.length)
  })

  it('gives every dialect a distinct precedence, so two rows never race', () => {
    expect(new Set(DIALECTS.map((d) => d.precedence)).size).toBe(DIALECTS.length)
  })

  it('names a primitive that exists, and a `read` that primitive accepts', () => {
    for (const d of DIALECTS) {
      const primitive = PRIMITIVES[d.primitive]
      expect(primitive, d.id).toBeDefined()
      expect(primitive.validate(d.read), d.id).toEqual([])
    }
  })

  it('never claims CLDR governs a positional scheme', () => {
    // A scheme whose selectors are POSITIONS cannot know CLDR by construction:
    // `order` says "the second part", not `few`. Claiming otherwise makes the
    // engine report rendering bugs that do not exist.
    for (const d of DIALECTS) {
      const read = d.read as { order?: unknown }
      if (read.order) expect(d.cldr, d.id).toBe(false)
    }
  })
})
