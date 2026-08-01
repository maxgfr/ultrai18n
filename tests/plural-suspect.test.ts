// What looks like a plural to something that knows no library at all.
//
// The point of these signals is not to be right. It is to make the dialect
// catalog CHECKABLE: without them, a catalog is only ever as good as the
// arrangements somebody thought to write down, and a repository using a scheme
// nobody anticipated reports clean. With them, the engine can say "here are the
// sites that smell like a plural and nothing claimed" — and that list going
// empty is what ends the loop.
//
// So the two properties under test are asymmetric on purpose. FIRING on a real
// unclaimed arrangement is the whole value. Staying quiet on ordinary code is
// what keeps the gate usable; a false suspicion costs one adjudication, once.
import { describe, it, expect } from 'vitest'
import { suspectPlurals, unclaimedSuspicions, type Suspicion } from '../src/plural/suspect'
import type { Site } from '../src/types'

let n = 0
function site(path: string, value: string, file = 'src/locales/en.json'): Site {
  n++
  return {
    id: `ul_${n}`,
    siteKey: `${file}#${path}`,
    file,
    line: n,
    kind: 'scalar',
    value,
  } as Site
}

const signals = (s: Suspicion[]): string[] => [...new Set(s.flatMap((x) => x.signals))].sort()

describe('signals that fire', () => {
  it('sees a category token on the leaf key', () => {
    const found = suspectPlurals([site('/cart/item_one', '{{count}} item')])
    expect(signals(found)).toEqual(['category-key'])
  })

  it('sees a bracketed category, which is how Android and .xcstrings spell it', () => {
    expect(signals(suspectPlurals([site('/plurals[x]/item[few]', 'x')]))).toEqual(['category-key'])
  })

  it('sees a plural delimiter with a part that counts', () => {
    const found = suspectPlurals([site('/cart/items', '%{n} item |||| %{n} items')])
    expect(signals(found)).toEqual(['delimited-counting'])
  })

  it('sees a gettext catalog through the residual sweep, which has no path at all', () => {
    // A `.po` file has no extractor, so its sites come back as `~sweep[n]` prose
    // runs. The marker is in the TEXT, and looking only at paths meant the one
    // format the tool explicitly does not read produced no suspicion whatsoever.
    const found = suspectPlurals([
      site('~sweep[3]', 'msgstr[0] "un fichier"', 'locale/fr/LC_MESSAGES/app.po'),
      site('~sweep[4]', 'msgstr[1] "%d fichiers"', 'locale/fr/LC_MESSAGES/app.po'),
    ])
    expect(signals(found)).toEqual(['structural-marker'])
    expect(found).toHaveLength(2)
  })

  it('sees an .xcstrings variations block', () => {
    const found = suspectPlurals([
      site('/strings/k/localizations/en/variations/plural/one/stringUnit/value', '%d item'),
    ])
    expect(signals(found)).toEqual(['structural-marker'])
  })

  it('sees an ICU message the parser cannot read', () => {
    // Broken today, with nothing translated. Worth surfacing on its own account.
    const found = suspectPlurals([site('/x', '{count, plural, one {# item} other {# items}')])
    expect(signals(found)).toEqual(['broken-icu'])
  })

  it('sees a scheme nobody named, from the two values alone', () => {
    // No category token, no delimiter, no marker. Just two siblings differing by
    // a short suffix, one of which counts — which is what a singular and a
    // plural look like in most languages.
    const found = suspectPlurals([
      site('/inbox/message', '{n} message'),
      site('/inbox/messages', '{n} messages'),
    ])
    expect(signals(found)).toEqual(['sibling-suffix-pair'])
    expect(found).toHaveLength(2)
  })
})

describe('signals that stay quiet', () => {
  it('leaves two unrelated siblings alone', () => {
    expect(suspectPlurals([site('/a/save', 'Save'), site('/a/cancel', 'Cancel')])).toEqual([])
  })

  it('leaves a pipe that counts nothing alone', () => {
    expect(suspectPlurals([site('/a/actions', 'Save | Cancel')])).toEqual([])
  })

  it('leaves a suffix pair alone when neither value counts', () => {
    // `Setting`/`Settings` with no number in sight is a heading and its section,
    // not a family. Requiring a count is what keeps the signal usable.
    expect(suspectPlurals([site('/a/setting', 'Setting'), site('/a/settings', 'Settings')])).toEqual([])
  })

  it('leaves a long suffix alone', () => {
    expect(
      suspectPlurals([site('/a/user', '{n} user'), site('/a/userAccountList', '{n} userAccountList')]),
    ).toEqual([])
  })

  it('does not read a key merely CONTAINING a category word', () => {
    expect(suspectPlurals([site('/a/oneClick', 'One click')])).toEqual([])
    expect(suspectPlurals([site('/a/other_things', 'Other things')])).toEqual([])
  })

  it('never looks at a key site', () => {
    const keySite = { ...site('/cart/item_one', 'item_one'), kind: 'key' } as Site
    expect(suspectPlurals([keySite])).toEqual([])
  })
})

describe('the residual', () => {
  it('is what no family claimed', () => {
    const claimed = site('/cart/item_one', '{{count}} item')
    const orphan = site('/cart/items', '%{n} item |||| %{n} items')
    const all = suspectPlurals([claimed, orphan])
    expect(all).toHaveLength(2)

    const residual = unclaimedSuspicions(all, new Set([claimed.id]))
    expect(residual.map((r) => r.siteId)).toEqual([orphan.id])
  })

  it('carries sibling values, because an arrangement is not readable from a path alone', () => {
    const found = suspectPlurals([
      site('/inbox/message', '{n} message'),
      site('/inbox/messages', '{n} messages'),
    ])
    expect(found[0]!.siblings.map((s) => s.value)).toContain('{n} messages')
  })

  it('merges signals rather than reporting a site twice', () => {
    const found = suspectPlurals([site('/cart/item_one', '{n} item |||| {n} items')])
    expect(found).toHaveLength(1)
    expect(found[0]!.signals.sort()).toEqual(['category-key', 'delimited-counting'])
  })
})
