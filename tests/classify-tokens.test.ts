// Design tokens, and the refusals they used to cost.
//
// 10,530 sites in one real repository and 7,842 in another came back
// `needs-judgment`. Every one of them was FOUND, so no amount of better
// searching reduces the number — it is a CLASSIFICATION problem, and filing it
// under recall would be the comfortable mistake.
//
// `ambiguous-role` dominated, `.md` dominated that, and the sample was this:
//
//     DESIGN.md | "`oklch(0.15 0.02 255)`"
//     DESIGN.md | "background"
//     DESIGN.md | "+ overrides"
//
// Colour tokens and CSS keywords inside technical documentation, each one an
// adjudication somebody had to make by hand to say "this is a colour".
import { describe, it, expect } from 'vitest'
import { classify, isDesignToken } from '../src/classify'
import { extractMarkdown } from '../src/extract/markdown'
import { OffsetMap } from '../src/vendor/text'
import { emptyTokenIndex, type RawSite } from '../src/extract/raw'

const md = (src: string) => extractMarkdown('DESIGN.md', src, new OffsetMap(src)).sites
const values = (sites: RawSite[]) => sites.map((s) => s.value)

const decide = (value: string) =>
  classify(
    {
      file: 'a.md', path: 'p[0]/text[0]', kind: 'prose-run',
      span: { start: 0, end: value.length }, valueSpan: { start: 0, end: value.length },
      raw: value, value, quote: null, escapes: false, holes: [],
      line: 1, col: 1, endLine: 1, endCol: 1,
      extractor: 'markdown', tier: 'structural', container: { isKey: false },
    } as RawSite,
    { from: 'fr', to: 'en', tokens: emptyTokenIndex() },
  )

describe('a design token is a token', () => {
  const tokens = [
    'oklch(0.15 0.02 255)',
    '#1a2b3c',
    '#fff',
    '1.5rem',
    '0.25s',
    'var(--fg)',
    '--color-ink-950',
    'rgba(0, 0, 0, 0.5)',
    'clamp(1rem, 2vw, 3rem)',
    'color-mix(in oklch, var(--a), var(--b))',
    '0 1px 2px var(--shadow)',
  ]

  for (const value of tokens) {
    it(`decides ${JSON.stringify(value)} without asking anybody`, () => {
      const site = decide(value)
      expect(`${value}: ${site.verdict}/${site.reason}`).toBe(`${value}: do-not-translate/style-token`)
    })
  }
})

describe('and prose that merely mentions one is still prose', () => {
  // The whole value has to be tokens. Documentation about a design system is
  // exactly where a sentence contains `1.5rem`, and swallowing it would trade
  // one silent failure for a worse one.
  const prose = [
    'La marge vaut 1.5rem sur mobile',
    'background colour of the panel',
    'Utilisez var(--fg) pour le texte principal',
    'The token oklch(0.15 0.02 255) is our darkest ink',
  ]

  for (const value of prose) {
    it(`leaves ${JSON.stringify(value.slice(0, 34))}… alone`, () => {
      expect(isDesignToken(value)).toBe(false)
      expect(decide(value).reason).not.toBe('style-token')
    })
  }

  it('does not claim a bare number, which has its own branch', () => {
    expect(isDesignToken('42')).toBe(false)
    expect(isDesignToken('')).toBe(false)
  })
})

describe('a markdown run that is entirely a code span is not prose', () => {
  it('drops a heading holding nothing but code', () => {
    // The paragraph and list paths have masked inline code since they were
    // written. Headings and table cells did not, which is where every one of
    // the evidence lines came from.
    expect(values(md('## `oklch(0.15 0.02 255)`\n'))).toEqual([])
    expect(values(md('## `.gitignore`\n'))).toEqual([])
  })

  it('drops a table cell holding nothing but code', () => {
    const sites = md('| format | note |\n| --- | --- |\n| `.jsonl` | JSON, one object per line |\n')
    expect(values(sites)).not.toContain('`.jsonl`')
    expect(values(sites)).toContain('JSON, one object per line')
  })

  it('keeps a heading and a cell that have prose in them', () => {
    expect(values(md('## Réglages `avancés`\n'))).toEqual(['Réglages `avancés`'])
    const cells = md('| clé | valeur |\n| --- | --- |\n| `--fg` | la couleur du texte |\n')
    expect(values(cells)).toContain('la couleur du texte')
  })

  it('leaves the anchors of everything it still emits untouched', () => {
    // Masking decides WHETHER a heading or cell is emitted, never how it is
    // anchored or what its value is. An anchor that moved would silently stop
    // every exception pinned to it from applying.
    const sites = md('## Réglages avancés\n\n| clé | valeur |\n| --- | --- |\n| nom | la couleur |\n')
    expect(sites.map((s) => s.path)).toEqual([
      'h2[0]',
      'table[1]/cell[0]',
      'table[1]/cell[1]',
      'table[3]/cell[0]',
      'table[3]/cell[1]',
    ])
  })
})

describe('what stays refused, on purpose', () => {
  it('still refuses a genuinely short ambiguous string', () => {
    // `short-string` on "Format" is the engine working, not failing. Nothing
    // here tries to reduce that number.
    expect(decide('Format').verdict).toBe('needs-judgment')
  })
})
