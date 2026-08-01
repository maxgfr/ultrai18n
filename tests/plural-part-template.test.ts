// Writing a family whose every part carries its own selector.
//
// Symfony writes `{0} Rien|]0,1] Un article|]1,Inf[ %count% articles`. Read
// positionally that is a three-part `zero|one|other` family and all three
// labels are wrong, which is why the dialect reads it BY SELECTOR — and having
// read it that way, the value cannot be rejoined without them. A bare pipe
// produces three bodies and no intervals: not a degraded rendering but a
// corrupted file.
//
// So `symfony.interval` shipped as `code-edit` with its classification already
// correct. `partTemplate` is the six lines that were missing.
import { describe, it, expect } from 'vitest'
import { writeFamily } from '../src/commands'
import { DIALECTS_BY_ID, type PluralFamily } from '../src/plural'
import type { Site } from '../src/types'

const SITE = { id: 'ul_1', value: '{0} Rien|]0,1] Un article|]1,Inf[ %count% articles' } as Site
const bySiteId = new Map<string, Site>([['ul_1', SITE]])

const family = (over: Partial<PluralFamily> = {}): PluralFamily =>
  ({
    id: 'pf_1',
    file: 'translations/messages.fr.yaml',
    anchor: 'translations/messages.fr.yaml#cart',
    base: 'cart',
    shape: 'delimited',
    dialect: 'symfony.interval',
    primitive: 'value-split',
    declaredBy: 'shape',
    locale: 'fr',
    forms: [
      { category: 'zero', selector: '{0}', siteId: 'ul_1', value: 'Rien' },
      { category: 'one', selector: ']0,1]', siteId: 'ul_1', value: 'Un article' },
      { category: 'other', selector: ']1,Inf[', siteId: 'ul_1', value: '%count% articles' },
    ],
    exact: [],
    sourceCategories: ['zero', 'one', 'other'],
    ownRequired: null,
    targetRequired: ['zero', 'one', 'other'],
    missing: [],
    extra: [],
    sites: ['ul_1'],
    ordinal: false,
    writeMode: 'replace',
    keyTemplate: null,
    insertAfterSiteId: null,
    count: null,
    join: '|',
    partTemplate: '{selector} {form}',
    ...over,
  }) as PluralFamily

describe('the dialect declares itself writable now', () => {
  it('is `replace` with a part template rather than `code-edit`', () => {
    const row = DIALECTS_BY_ID.get('symfony.interval')!
    expect(row.write.mode).toBe('replace')
    expect(row.write.partTemplate).toBe('{selector} {form}')
    expect(row.write.join).toBe('|')
  })
})

describe('each part is rebuilt WITH its selector', () => {
  it('keeps every interval where it was', () => {
    const out = writeFamily(
      family(),
      { zero: 'Nothing', one: 'One item', other: '%count% items' },
      bySiteId,
    )
    expect(out.translations).toEqual([
      { id: 'ul_1', text: '{0} Nothing|]0,1] One item|]1,Inf[ %count% items' },
    ])
    expect(out.todo).toBeUndefined()
  })

  it('joins with the dialect\'s own delimiter, unpadded', () => {
    // `' | '` was hardcoded once and is vue-i18n's separator, nobody else's.
    const out = writeFamily(family(), { zero: 'A', one: 'B', other: 'C' }, bySiteId)
    expect(out.translations[0]!.text).not.toContain(' | ')
  })
})

describe('and a form with no interval is refused, not invented', () => {
  it('sends the family to the worklist WITH its translations', () => {
    // `]2,5[` has no CLDR equivalent, and a target category the source never
    // had has no selector to write. Inventing one is exactly the guess a cited
    // catalog exists to prevent.
    const out = writeFamily(
      family({ targetRequired: ['zero', 'one', 'few', 'other'] }),
      { zero: 'Nothing', one: 'One', few: 'A few', other: 'Many' },
      bySiteId,
    )
    expect(out.translations).toEqual([])
    expect(out.todo).toMatchObject({ familyId: 'pf_1', file: 'translations/messages.fr.yaml' })
    // The words were already paid for. Dropping them here made the run report
    // success and throw the translation away.
    expect(out.todo!.forms).toMatchObject({ few: 'A few' })
    expect(out.todo!.targetCategories).toContain('few')
    expect(out.todo!.why).toMatch(/cannot be invented|could not be rebuilt/)
  })

  it('refuses rather than writing an empty part', () => {
    const out = writeFamily(family(), { zero: 'Nothing' }, bySiteId)
    expect(out.translations).toEqual([])
    expect(out.todo).toBeDefined()
  })
})

describe('a family with no part template is unaffected', () => {
  it('still joins positionally, as vue-i18n and Polyglot need', () => {
    const out = writeFamily(
      family({ partTemplate: null, join: ' | ', dialect: 'vue-i18n.pipe-positional' }),
      { zero: 'A', one: 'B', other: 'C' },
      bySiteId,
    )
    expect(out.translations[0]!.text).toBe('A | B | C')
  })
})
