// Strings in application code that the browser or the i18n runtime reads, and nobody sees.
//
// Pointed at an app whose copy already lives in catalogues (maxgfr/ways), every call site came
// back `needs-judgment`: `t("dir.myPosition")` is camel-cased so it is not a slug, and fell
// through to the language detector as a short string. So did `rel="noopener noreferrer"`, a
// media query given to `matchMedia`, `normalize("NFD")` and `timeZone: "UTC"`. Each is decided
// by where it sits, not by how it reads.
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareGrammars, parserForExt } from '../src/ast/parse'
import { classify } from '../src/classify'
import { extractTs } from '../src/extract/ts'
import { emptyTokenIndex } from '../src/extract/raw'
import { OffsetMap } from '../src/text'

let verdicts: (src: string) => Map<string, string>

beforeAll(async () => {
  await prepareGrammars(['.tsx'])
  const parser = await parserForExt('.tsx')
  if (!parser) throw new Error('tsx grammar unavailable')
  verdicts = (src) => {
    const { sites, tokens } = extractTs('a.tsx', src, parser.parse(src)!, new OffsetMap(src))
    const index = { ...emptyTokenIndex(), ...tokens }
    const out = new Map<string, string>()
    for (const site of sites) {
      const d = classify(site, { from: 'en', to: 'fr', tokens: index })
      out.set(site.value, `${d.verdict}/${d.reason ?? ''}`)
    }
    return out
  }
})

describe('a key given to the message lookup is an identifier', () => {
  const calls = [
    `t("dir.myPosition")`,
    `i18n.t("settings.engine.auto.hint")`,
    `i18next.t("common:save")`,
    `this.$t("cart.items_count")`,
    `intl.formatMessage("home.title")`,
  ]
  for (const call of calls) {
    it(call, () => {
      const v = verdicts(`const x = ${call}`)
      const key = [...v.keys()][0] as string
      expect(`${key}: ${v.get(key)}`).toBe(`${key}: do-not-translate/identifier`)
    })
  }

  it('inside a JSX attribute too', () => {
    const v = verdicts(`const C = () => <Toggle label={t("pref.avoidHills")} />`)
    expect(v.get('pref.avoidHills')).toBe('do-not-translate/identifier')
  })

  it('but a sentence given to the same function is still copy', () => {
    // Some runtimes key their catalogues by the source sentence itself.
    const v = verdicts(`const x = t("Your position could not be found")`)
    expect(v.get('Your position could not be found')).toBe('translate/')
  })

  it('and only the first argument is the key', () => {
    const v = verdicts(`const x = t("stop.late", "Running late by a few minutes today")`)
    expect(v.get('stop.late')).toBe('do-not-translate/identifier')
    expect(v.get('Running late by a few minutes today')).not.toBe('do-not-translate/identifier')
  })
})

describe('what the browser reads', () => {
  it('a link type list', () => {
    const v = verdicts(`const C = () => <a href="x" rel="noopener noreferrer">Read</a>`)
    expect(v.get('noopener noreferrer')).toBe('do-not-translate/code-token')
  })

  it('a media query, a normalisation form, a selector', () => {
    const v = verdicts(
      `matchMedia("(prefers-color-scheme: dark)"); s.normalize("NFD"); document.querySelector("main .sheet-body")`,
    )
    expect(v.get('(prefers-color-scheme: dark)')).toBe('do-not-translate/api-contract')
    expect(v.get('NFD')).toBe('do-not-translate/api-contract')
    expect(v.get('main .sheet-body')).toBe('do-not-translate/api-contract')
  })

  it('a time zone', () => {
    const v = verdicts(`fmt({ timeZone: "UTC" }); fmt({ timeZone: "America/Argentina/Buenos_Aires" })`)
    expect(v.get('UTC')).toBe('do-not-translate/code-token')
    expect(v.get('America/Argentina/Buenos_Aires')).toBe('do-not-translate/code-token')
  })

  it('while a title attribute stays copy', () => {
    const v = verdicts(`const C = () => <button title="Show where I am on the map">x</button>`)
    expect(v.get('Show where I am on the map')).toBe('translate/')
  })
})
