// The Rust reader.
//
// Without it a `.rs` file went to the residual sweep whole, and `Motion::PanUp`
// or `use std::fs;` came back `unclassified`: 3385 of 4244 sites on a real
// repository, all of them code. Everything below is a way a lexer that treats
// Rust like C would lose its place, or write a file the compiler then rejects.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'
import { auditCoverage } from '../src/audit'
import { validate } from '../src/validate'
import { escapeFor, spliceRustHoles, syntaxFor, unescapeFor } from '../src/escape'
import { extractRust } from '../src/extract/rust'
import { humanLookingRuns } from '../src/sweep'
import { OffsetMap } from '../src/text'
import type { Group } from '../src/plan'
import type { Hole } from '../src/types'

const lex = (src: string) => extractRust('a.rs', src, new OffsetMap(src))
const values = (src: string): string[] => lex(src).sites.map((s) => s.value)

describe('comments', () => {
  it('reads line, outer doc and inner doc comments', () => {
    expect(values('// Première note\n/// Décrit la fonction\n//! Décrit le module\nfn a() {}\n')).toEqual([
      'Première note',
      'Décrit la fonction',
      'Décrit le module',
    ])
  })

  it('keeps the marker apart from the text', () => {
    const [site] = lex('/// Décrit la fonction\n').sites
    expect(site).toMatchObject({ kind: 'comment', prefix: '/// ', suffix: '', value: 'Décrit la fonction' })
  })

  it('counts nested block comments, where a C lexer would stop at the first closer', () => {
    const out = lex('/* dehors /* dedans */ encore dehors */ fn a() { "Après le commentaire"; }\n')
    expect(out.complete).toBe(true)
    expect(out.sites.map((s) => s.value)).toEqual([
      'dehors /* dedans */ encore dehors',
      'Après le commentaire',
    ])
  })

  it('leaves a tool directive alone', () => {
    expect(values('// rustfmt::skip\n// clippy::too_many_arguments\nfn a() {}\n')).toEqual([])
  })
})

describe('strings', () => {
  it('resolves escapes in the value and leaves the span on the source', () => {
    const src = 'let a = "Ligne \\"une\\"\\nLigne deux\\t\\u{e9}\\x41";\n'
    const [site] = lex(src).sites
    expect(site!.value).toBe('Ligne "une"\nLigne deux\té' + 'A')
    expect(site!.escapes).toBe(true)
    expect(src.slice(site!.span.start, site!.span.end)).toBe(site!.raw)
  })

  it('drops a line continuation and its indentation', () => {
    expect(values('let a = "première \\\n        seconde";\n')).toEqual(['première seconde'])
  })

  it('does not end a string at an escaped quote', () => {
    const out = lex('let a = "un \\" deux"; let b = "trois quatre";\n')
    expect(out.sites.map((s) => s.value)).toEqual(['un " deux', 'trois quatre'])
  })

  it('reads a raw string whose body holds quotes', () => {
    const out = lex('let a = r#"Il a dit "bonjour" ici"#; let b = r"sans dièse"; let c = r##"a "# b deux"##;\n')
    expect(out.complete).toBe(true)
    expect(out.sites.map((s) => s.value)).toEqual(['Il a dit "bonjour" ici', 'sans dièse', 'a "# b deux'])
    expect(out.sites.map((s) => s.quote)).toEqual(['r#"', 'r"', 'r##"'])
    expect(out.sites[0]!.escapes).toBe(false)
  })

  it('does not take a raw identifier for a raw string', () => {
    const out = lex('let r#type = 1; let a = "encore lu";\n')
    expect(out.complete).toBe(true)
    expect(out.sites.map((s) => s.value)).toEqual(['encore lu'])
  })

  it('claims byte and C strings without emitting them', () => {
    const src = 'let a = b"octets bruts"; let b = br#"encore "des" octets"#; let c = c"chaine c"; let d = "gardée ici";\n'
    const out = lex(src)
    expect(out.sites.map((s) => s.value)).toEqual(['gardée ici'])
    expect(out.claimedBytes).toBe(Buffer.byteLength(src))
  })
})

describe('char literals and lifetimes', () => {
  it('tells them apart without losing sync', () => {
    const src = [
      "fn a<'a>(x: &'a str, y: &'static str) -> char {",
      "    let c = 'a';",
      "    let d = '\\n';",
      "    let e = '\\'';",
      "    let f = '\\u{1F600}';",
      "    let g = '😀';",
      "    let h = b'x';",
      "    'outer: loop { break 'outer; }",
      '    let m = "après les lifetimes";',
      '    c',
      '}',
      '',
    ].join('\n')
    const out = lex(src)
    expect(out.complete).toBe(true)
    expect(out.claimedBytes).toBe(Buffer.byteLength(src))
    expect(out.sites.map((s) => s.value)).toEqual(['après les lifetimes'])
  })

  it('is not fooled by a quote char holding a double quote', () => {
    expect(values(`let q = '"'; let m = "vraie chaîne";\n`)).toEqual(['vraie chaîne'])
  })
})

describe('attributes', () => {
  it('keeps a sentence and drops configuration', () => {
    const out = values(
      [
        '#[derive(Debug)]',
        '#[command(about = "Read and animate")]',
        '#[arg(default_value = "magi")]',
        '#[serde(rename_all = "snake_case")]',
        '#![doc = "Documentation du module"]',
        'struct A;',
        '',
      ].join('\n'),
    )
    expect(out).toEqual(['Read and animate', 'Documentation du module'])
  })

  it('only applies inside the attribute', () => {
    expect(values('#[derive(Debug)]\nfn a() { let m = "unmot"; }\n')).toEqual(['unmot'])
  })

  it('tracks nested brackets', () => {
    expect(values('#[cfg(any(feature = "x", all(a, b)))]\n#[doc = "ok ici"]\nconst A: [u8; 1] = [0];\n')).toEqual(['ok ici'])
  })
})

describe('format placeholders', () => {
  it('records each one as an ordinal hole', () => {
    const [site] = lex('println!("Bonjour {name}, vous avez {} messages et {0:>5}");\n').sites
    expect(site).toMatchObject({ kind: 'template', value: 'Bonjour {0}, vous avez {1} messages et {2}' })
    expect(site!.holes.map((h) => h.expr)).toEqual(['name', '', '0:>5'])
  })

  it('addresses the placeholder in the source by byte, after non-ASCII text', () => {
    const src = 'let a = "Évité {x}";\n'
    const [site] = lex(src).sites
    const { start, end } = site!.holes[0]!.span
    expect(Buffer.from(src, 'utf8').subarray(start, end).toString('utf8')).toBe('{x}')
  })

  it('keeps doubled braces as text and not as holes', () => {
    const [site] = lex('println!("Accolade {{ ouverte }} et {n}");\n').sites
    expect(site!.value).toBe('Accolade {{ ouverte }} et {0}')
    expect(site!.holes).toHaveLength(1)
  })

  it('makes the placeholder a hole the validator holds a translation to', () => {
    const [site] = lex('println!("Bonjour {name} !");\n').sites
    const group = { text: site!.value, max: null, role: 'x' } as unknown as Group
    expect(validate(group, 'Hello there!').some((v) => v.validator === 'V1')).toBe(true)
    expect(validate(group, 'Hello {0}!').filter((v) => v.validator === 'V1')).toEqual([])
  })
})

describe('losing sync', () => {
  const cases: [string, string][] = [
    ['an unterminated string', 'let a = "jamais fermée'],
    ['an unterminated raw string', 'let a = r#"jamais fermée"'],
    ['an unterminated nested comment', '/* un /* deux */ pas fermé'],
    ['an unterminated byte string', 'let a = b"jamais'],
    ['a stray quote', "let a = '( ;"],
  ]
  for (const [name, src] of cases) {
    it(`says so on ${name}`, () => {
      const out = lex(src)
      expect(out.complete).toBe(false)
      expect(out.claimedBytes).toBeLessThan(Buffer.byteLength(src))
    })
  }
})

describe('the census and the sweep', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ultrai18n-rust-'))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('stops code reaching the inventory as unclassified', async () => {
    writeFileSync(
      join(repo, 'a.rs'),
      'use std::fs;\npub type BBox = (u32, u32);\n// Calcule la boîte englobante du panneau courant\nfn a() -> Motion { Motion::PanUp }\n',
    )
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const sites = inv.sites.filter((s) => s.file === 'a.rs')
    expect(sites.filter((s) => s.verdict === 'unclassified')).toEqual([])
    expect(sites.map((s) => s.value)).toEqual(['Calcule la boîte englobante du panneau courant'])
    expect(inv.census.find((c) => c.file === 'a.rs')).toMatchObject({ claimRatio: 1, extractors: ['rust'], tier: 'structural' })
  })

  it('hands the rest of a file to the sweep when it loses sync', async () => {
    writeFileSync(join(repo, 'a.rs'), '// Lu avant la panne\nlet a = "jamais fermée et cette phrase reste à lire\n')
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const sites = inv.sites.filter((s) => s.file === 'a.rs')
    expect(sites[0]).toMatchObject({ extractor: 'rust', value: 'Lu avant la panne' })
    expect(sites.slice(1).length).toBeGreaterThan(0)
    expect(sites.slice(1).every((s) => s.extractor === 'residual-sweep' && s.verdict === 'unclassified')).toBe(true)
    expect(sites.slice(1).map((s) => s.value).join(' ')).toContain('cette phrase reste')
    expect(inv.census.find((c) => c.file === 'a.rs')!.claimRatio).toBeLessThan(1)
  })

  it('is audited on the comments and strings of a file it claims whole', () => {
    writeFileSync(join(repo, 'a.rs'), '// Une phrase laissée de côté\nlet a = "deux mots";\n')
    const census = { file: 'a.rs', bucket: 'scanned', extractors: ['rust'], claimRatio: 1, byteAddressable: true }
    const view = auditCoverage({ repo, census: [census], sites: [] } as never, repo)
    expect(view.findings.map((f) => f.locator).sort()).toEqual(['rust-comment', 'rust-string'])
  })

  it('does not read an attribute or a byte string as text', () => {
    writeFileSync(join(repo, 'a.rs'), '#[allow(dead_code, unused)]\nlet a = b"deux mots";\n')
    const census = { file: 'a.rs', bucket: 'scanned', extractors: ['rust'], claimRatio: 1, byteAddressable: true }
    expect(auditCoverage({ repo, census: [census], sites: [] } as never, repo).findings).toEqual([])
  })
})

describe('what the sweep counts as a declared word', () => {
  // The lookup behind this was words × identifiers, on the path every format
  // without a reader goes through. Faster must not mean different.
  it('treats a segment of a compound identifier as code', () => {
    expect(humanLookingRuns('banane cerise', new Set(['fruit-banane', 'fruit_cerise']))).toEqual([])
  })

  it('matches a segment case-sensitively', () => {
    expect(humanLookingRuns('Banane Cerise', new Set(['fruit-banane', 'fruit-cerise']))).toHaveLength(1)
  })

  it('sees identifiers added after the first lookup', () => {
    const ids = new Set(['x-y'])
    expect(humanLookingRuns('banane cerise', ids)).toHaveLength(1)
    ids.add('fruit-banane')
    ids.add('fruit-cerise')
    expect(humanLookingRuns('banane cerise', ids)).toEqual([])
  })
})

describe('writing back', () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ultrai18n-rust-apply-'))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  const translate = async (body: string, match: string, to: string) => {
    writeFileSync(join(repo, 'a.rs'), body)
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.file === 'a.rs' && s.value.includes(match))
    if (!site) throw new Error(`no site matching ${match}: ${inv.sites.map((s) => s.value).join(' | ')}`)
    const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: to }], write: true })
    return { report, out: readFileSync(join(repo, 'a.rs'), 'utf8') }
  }

  it('escapes a quote and a backslash for a normal string', async () => {
    const { out } = await translate('let a = "Le fichier est prêt";\n', 'fichier', 'The "file" is C:\\ready')
    expect(out).toBe('let a = "The \\"file\\" is C:\\\\ready";\n')
  })

  it('writes placeholders back as Rust, not as a JavaScript template', async () => {
    const { out } = await translate('println!("Bonjour {name}, solde {total:>8}");\n', 'Bonjour', 'Hello {0}, balance {1}')
    expect(out).toBe('println!("Hello {name}, balance {total:>8}");\n')
  })

  it('leaves `{}` implicit when the order holds', async () => {
    const { out } = await translate('println!("De {} vers {:?}");\n', 'vers', 'From {0} to {1}')
    expect(out).toBe('println!("From {} to {:?}");\n')
  })

  it('pins `{}` to its argument when a translation reorders them', async () => {
    const { out } = await translate('println!("De {} vers {:?}");\n', 'vers', 'To {1}, from {0}')
    expect(out).toBe('println!("To {1:?}, from {0}");\n')
  })

  it('keeps a comment marker and a doc comment marker', async () => {
    expect((await translate('/// Décrit la fonction\nfn a() {}\n', 'Décrit', 'Describes it')).out).toBe('/// Describes it\nfn a() {}\n')
    expect((await translate('//! Décrit le module\n', 'Décrit', 'Describes it')).out).toBe('//! Describes it\n')
  })

  it('writes into a raw string, delimiters intact', async () => {
    const { out } = await translate('let a = r#"Le "vrai" fichier"#;\n', 'fichier', 'The "real" file')
    expect(out).toBe('let a = r#"The "real" file"#;\n')
  })

  it('refuses a raw string the translation would end early, and leaves the file alone', async () => {
    const body = 'let a = r"Le dernier fichier";\n'
    const { report, out } = await translate(body, 'fichier', 'The "last" file')
    expect(report.outcomes[0]).toMatchObject({ status: 'refused' })
    expect(out).toBe(body)
  })

  it('refuses a raw string on the same terms in an ASCII file written in \\u escapes', () => {
    // `apply` skips its round-trip check for such a file, so the refusal cannot
    // live there.
    expect(() => escapeFor('rust-raw', 'x"y', { quote: 'r"', asciiOnly: true })).toThrow(/cannot contain/)
  })

  it('refuses a block comment the translation would unbalance', async () => {
    const body = '/* Le vrai commentaire */\nfn a() {}\n'
    const { report, out } = await translate(body, 'commentaire', 'opens /* and never closes')
    expect(report.outcomes[0]).toMatchObject({ status: 'refused' })
    expect(out).toBe(body)
  })

  it('writes a nested comment back when it stays balanced', async () => {
    const { out } = await translate('/* dehors /* dedans */ encore */\n', 'dehors', 'outside /* inside */ still')
    expect(out).toBe('/* outside /* inside */ still */\n')
    expect(lex(out).complete).toBe(true)
  })

  it('round-trips everything a Rust string can escape, in one pass', () => {
    for (const s of ['a\nb', 'tab\there', 'back\\slash', 'lit\\nnot newline', 'quo"te', "apo'strophe", 'é€😀']) {
      const syntax = 'rust-string' as const
      expect(unescapeFor(syntax, escapeFor(syntax, s))).toBe(s)
      expect(unescapeFor(syntax, escapeFor(syntax, s, { asciiOnly: true }))).toBe(s)
    }
    expect(escapeFor('rust-string', 'é', { asciiOnly: true })).toBe('\\u{e9}')
  })

  it('routes each site to its own syntax', () => {
    const at = (kind: 'comment' | 'string-literal', raw: string, quote: string | null) =>
      syntaxFor({ kind, raw, quote, extractor: 'rust' })
    expect(at('comment', '// a', null)).toBe('line-comment')
    expect(at('comment', '/* a */', null)).toBe('rust-block-comment')
    expect(at('string-literal', '"a"', '"')).toBe('rust-string')
    expect(at('string-literal', 'r#"a"#', 'r#"')).toBe('rust-raw')
  })

  it('refuses to reorder `{:.*}`, which takes two arguments', () => {
    const holes: Hole[] = [
      { index: 0, span: { start: 0, end: 0 }, expr: ':.*' },
      { index: 1, span: { start: 0, end: 0 }, expr: '' },
    ]
    expect(spliceRustHoles('{0} {1}', holes)).toBe('{:.*} {}')
    expect(() => spliceRustHoles('{1} {0}', holes)).toThrow(/cannot be reordered/)
  })

  it('leaves a literal doubled brace untouched while splicing', () => {
    const holes: Hole[] = [{ index: 0, span: { start: 0, end: 0 }, expr: 'x' }]
    expect(spliceRustHoles('{{0}} {0}', holes)).toBe('{{0}} {x}')
  })
})
