// What the AST tier accounts for, and what it says when it cannot.
//
// The central product claim is that no byte of a scannable file leaves the
// pipeline unaccounted for. For the hand-written lexers that is a measurement:
// they count what they claimed. For the AST tier it used to be an assertion —
// every parsed file reported `claimRatio` of exactly 1, whether or not the
// grammar had managed to read it. These tests are about the difference.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTs } from '../src/extract/ts'
import { prepareGrammars, parserForExt } from '../src/ast/parse'
import { OffsetMap } from '../src/vendor/text'
import { scan, disambiguatePaths } from '../src/scan'
import { check } from '../src/check'
import { classify } from '../src/classify'
import { emptyTokenIndex, type RawSite } from '../src/extract/raw'

let parse: (src: string, file?: string) => ReturnType<typeof extractTs>

beforeAll(async () => {
  await prepareGrammars(['.tsx'])
  const parser = await parserForExt('.tsx')
  if (!parser) throw new Error('tsx grammar unavailable — the AST tier cannot be tested')
  parse = (src, file = 'a.tsx') => extractTs(file, src, parser.parse(src)!, new OffsetMap(src))
})

const verdictOf = (raw: RawSite): string =>
  classify(raw, { from: 'en', to: 'fr', tokens: emptyTokenIndex() }).verdict

const reasonOf = (raw: RawSite): string | null =>
  classify(raw, { from: 'en', to: 'fr', tokens: emptyTokenIndex() }).reason

describe('unparseable regions are reported, not absorbed', () => {
  it('says nothing when the grammar read the whole file', () => {
    const out = parse('export const a = "Hello there friend"')
    expect(out.hasError).toBe(false)
    expect(out.errorSpans).toEqual([])
  })

  it('reports the spans it could not parse', () => {
    const out = parse('export const a = "ok"\n@@@ !!! ###\nexport const b = "also ok"')
    expect(out.hasError).toBe(true)
    expect(out.errorSpans.length).toBeGreaterThan(0)
  })

  it('still finds the sites either side of the damage', () => {
    const out = parse('const a = "before the mess"\n@@@ ??? @@@\nconst b = "after the mess"')
    expect(out.sites.map((s) => s.value)).toEqual(
      expect.arrayContaining(['before the mess', 'after the mess']),
    )
  })
})

describe('a broken parse changes what the census claims', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ultrai18n-ast-'))
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'clean.ts'), 'export const label = "Everything parses here"\n')
    // Text sitting in a region the grammar gives up on. Before the fix this
    // file reported claimRatio 1 and contributed nothing at all.
    writeFileSync(
      join(repo, 'src', 'broken.ts'),
      'export const ok = "This part is fine"\n@@@@ <<< ???\nSomething a person would obviously read\n',
    )
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('claims every byte of a file that parsed cleanly', async () => {
    const inv = await scan({ repo, from: 'en', to: 'fr' })
    const entry = inv.census.find((c) => c.file === 'src/clean.ts')!
    expect(entry.claimRatio).toBe(1)
    expect(entry.degraded).toBe(false)
  })

  it('claims LESS than everything when part of the file could not be parsed', async () => {
    const inv = await scan({ repo, from: 'en', to: 'fr' })
    const entry = inv.census.find((c) => c.file === 'src/broken.ts')!
    expect(entry.claimRatio).toBeLessThan(1)
    expect(entry.degraded).toBe(true)
    expect(entry.reason).toMatch(/unparseable/)
  })

  it('sweeps the unparseable region, so text there is unclassified rather than silent', async () => {
    const inv = await scan({ repo, from: 'en', to: 'fr' })
    const residual = inv.sites.filter(
      (s) => s.file === 'src/broken.ts' && s.verdict === 'unclassified',
    )
    expect(residual.some((s) => s.value.includes('a person would obviously read'))).toBe(true)
    expect(residual[0]!.whyUnclaimed).toMatch(/could not parse/)
  })

  it('raises an advisory naming the cause', async () => {
    const inv = await scan({ repo, from: 'en', to: 'fr' })
    expect(inv.advisories.some((a) => a.id === 'ast-parse-error')).toBe(true)
  })
})

describe('a file with no parser is swept, not silently dropped', () => {
  // The branch that runs when the AST tier is unavailable used to return zero
  // sites and claim zero bytes. Every string in the file then left the pipeline
  // with no site, no `unclassified` and no gate — an advisory named the tier
  // and nothing named the text. `--no-ast` reaches that branch now instead of
  // going around it, which is what the flag always claimed to be for.
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ultrai18n-nograms-'))
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(
      join(repo, 'src', 'app.ts'),
      'export const label = "Enregistrer les modifications du profil"\n',
    )
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('finds the text as unclassified rather than not at all', async () => {
    const inv = await scan({ repo, from: 'fr', to: 'en', noAst: true })
    const residual = inv.sites.filter((s) => s.file === 'src/app.ts' && s.verdict === 'unclassified')
    expect(residual.some((s) => s.value.includes('Enregistrer les modifications'))).toBe(true)
    expect(residual[0]!.whyUnclaimed).toMatch(/no \.ts parser was available/)
  })

  it('marks the file degraded, so the weaker claim is on the record', async () => {
    const inv = await scan({ repo, from: 'fr', to: 'en', noAst: true })
    const entry = inv.census.find((c) => c.file === 'src/app.ts')!
    expect(entry.degraded).toBe(true)
    expect(entry.extractors).toEqual(['none'])
    expect(entry.tier).toBe('sweep')
  })

  it('carries that onto every site in it', async () => {
    // `Site.degraded` was computed from `tier === 'regex'`, a tier nothing has
    // ever emitted — so the field was false in every repository. It says what
    // its name promises now: this site came out of a file read without its
    // full tier, so its verdict is weaker than one from a parsed file.
    const degraded = await scan({ repo, from: 'fr', to: 'en', noAst: true })
    expect(degraded.sites.filter((s) => s.file === 'src/app.ts').every((s) => s.degraded)).toBe(true)

    const parsed = await scan({ repo, from: 'fr', to: 'en' })
    expect(parsed.sites.filter((s) => s.file === 'src/app.ts').some((s) => s.degraded)).toBe(false)
    expect(parsed.census.find((c) => c.file === 'src/app.ts')!.tier).toBe('ast')
  })

  it('and G2 refuses to pass while that site is there', async () => {
    const inv = await scan({ repo, from: 'fr', to: 'en', noAst: true })
    const gate = check({ repo, inventory: inv }).gates.find((g) => g.id === 'G2')!
    expect(gate.ok).toBe(false)
  })

  it('finds it as a real site when the tier IS available', async () => {
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.value.includes('Enregistrer les modifications'))!
    expect(site.verdict).toBe('translate')
    expect(site.extractor).toBe('ts-ast')
  })
})

describe('claimRatio is measured in the unit it is reported in', () => {
  // It is a fraction of the file's BYTES, and every hand-written lexer scans a
  // JS string, which counts UTF-16 units. The two agree only on ASCII — so the
  // number was wrong on precisely the repositories this tool exists for.
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'ultrai18n-ratio-'))
    mkdirSync(join(repo, 'locales'), { recursive: true })
    writeFileSync(join(repo, 'locales', 'ja.json'), '{\n  "greeting": "ワークスペースへおかえりなさい"\n}\n')
    writeFileSync(join(repo, 'locales', 'ru.yml'), 'ru:\n  greeting: С возвращением\n')
    writeFileSync(join(repo, 'notes.md'), '# Заголовок\n\nЦелый абзац текста здесь.\n')
    writeFileSync(join(repo, 'a.css'), '/* Комментарий */\n.a { color: red }\n')
    // No trailing newline: the last line has no newline to claim, and counting
    // one anyway pushed the ratio above 1.
    writeFileSync(join(repo, 'b.yml'), 'name: Тест\nvalue: два')
  })

  afterAll(() => rmSync(repo, { recursive: true, force: true }))

  it('reports full coverage for a non-ASCII file every lexer read end to end', async () => {
    const inv = await scan({ repo, from: 'ru', to: 'en' })
    for (const entry of inv.census.filter((c) => c.bucket === 'scanned')) {
      expect(`${entry.file}: ${entry.claimRatio}`).toBe(`${entry.file}: 1`)
    }
  })

  it('never reports more than the whole file', async () => {
    const inv = await scan({ repo, from: 'ru', to: 'en' })
    expect(inv.census.filter((c) => (c.claimRatio ?? 0) > 1)).toEqual([])
  })

  it('counts a YAML block scalar, whose lines the main loop never revisits', async () => {
    writeFileSync(
      join(repo, 'workflow.yml'),
      'on: push\njobs:\n  release:\n    body: |\n      Une ligne entière de prose.\n      Et une deuxième juste après.\n',
    )
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    expect(inv.census.find((c) => c.file === 'workflow.yml')!.claimRatio).toBe(1)
  })
})

describe('tagged templates are read by their tag', () => {
  it('does not translate a stylesheet', () => {
    const { sites } = parse('const S = css`color: red; font-family: sans-serif;`')
    const site = sites.find((s) => s.kind === 'template')!
    expect(site.container.tag).toBe('css')
    expect(verdictOf(site)).toBe('do-not-translate')
    expect(reasonOf(site)).toBe('style-token')
  })

  it('handles a member-expression tag', () => {
    const { sites } = parse('const B = styled.button`padding: 4px; border: none;`')
    expect(verdictOf(sites.find((s) => s.kind === 'template')!)).toBe('do-not-translate')
  })

  it('does not translate a query document', () => {
    const { sites } = parse('const Q = gql`query { viewer { name email } }`')
    const site = sites.find((s) => s.kind === 'template')!
    expect(reasonOf(site)).toBe('api-contract')
  })

  it('leaves an untagged template alone, which is still copy', () => {
    const { sites } = parse('const t = `Nothing to work on yet`')
    expect(verdictOf(sites.find((s) => s.kind === 'template')!)).toBe('translate')
  })
})

describe('`as const` arrays', () => {
  it('records members as enum origins so the dual-use hazard can fire', () => {
    const { tokens } = parse(`const S = ['active', 'archived'] as const`)
    expect([...tokens.enums.keys()].sort()).toEqual(['active', 'archived'])
  })

  it('does NOT protect them outright, because a label array looks identical', () => {
    // `['Yes', 'No'] as const` is copy and `['on', 'off'] as const` is not, and
    // nothing structural separates them. Verdicting here would silently freeze
    // every label array in the repository.
    const { sites } = parse(`const L = ['Everything is fine here'] as const`)
    expect(verdictOf(sites.find((s) => s.value.startsWith('Everything'))!)).toBe('translate')
  })

  it('leaves a plain array out of the enum index', () => {
    const { tokens } = parse(`const S = ['active', 'archived']`)
    expect(tokens.enums.size).toBe(0)
  })
})

describe('anchors are unique', () => {
  // A shared anchor is a shared site id, and `apply` resolves a translation
  // through a Map — so one translation lands on another site's bytes. These
  // are the four shapes that used to collapse.
  const distinct = (src: string, kind: string, expected: number): void => {
    const paths = parse(src).sites.filter((s) => s.kind === kind).map((s) => s.path)
    expect(paths.length).toBe(expected)
    expect(new Set(paths).size).toBe(expected)
  }

  it('separates comments sharing a function body', () => {
    distinct(
      'function f() {\n  // first remark here\n  // second remark here\n  // third remark here\n}',
      'comment',
      3,
    )
  })

  it('separates comments sharing the top level', () => {
    distinct('// first remark\nconst a = 1\n// second remark\nconst b = 2', 'comment', 2)
  })

  it('separates the members of a union type', () => {
    // Left-associative nesting made every member past the first collapse onto
    // one index.
    distinct(`type S = 'active' | 'done' | 'archived' | 'paused'`, 'string-literal', 4)
  })

  it('separates statements inside one function body', () => {
    distinct(
      'function f(n: number) {\n  if (n) return "first"\n  if (!n) return "second"\n  return "third"\n}',
      'string-literal',
      3,
    )
  })

  it('separates module specifiers at the top level', () => {
    distinct(`import a from 'alpha'\nimport b from 'beta'`, 'string-literal', 2)
  })

  it('keeps a named path unchanged, so the ordinal never churns an existing anchor', () => {
    // An ordinal is emitted INSTEAD of a missing name, never in addition.
    const { sites } = parse(`const WEEKDAY = ['L', 'M', 'J']\ntype S = 'a' | 'b'`)
    expect(sites.find((s) => s.value === 'L')!.path).toBe('WEEKDAY/[0]')
    expect(sites.find((s) => s.value === 'J')!.path).toBe('WEEKDAY/[2]')
    // And a type now contributes its name rather than anchoring at the root.
    expect(sites.find((s) => s.value === 'a')!.path).toBe('S/[0]')
  })

  it('still has the disambiguator behind it as a last resort', () => {
    const sites = [
      { path: '/dup', kind: 'scalar', span: { start: 0, end: 1 } },
      { path: '/dup', kind: 'scalar', span: { start: 2, end: 3 } },
    ] as RawSite[]
    expect(disambiguatePaths(sites)).toBe(1)
    expect(new Set(sites.map((s) => s.path)).size).toBe(2)
  })

  it('separates a JSON key from its own value without calling it a surprise', () => {
    // The pointer names the pair, so this happens on every object in every
    // repository. Reporting it would train people to ignore the advisory.
    const sites = [
      { path: '/item_one', kind: 'key', span: { start: 0, end: 1 } },
      { path: '/item_one', kind: 'scalar', span: { start: 2, end: 3 } },
    ] as RawSite[]
    expect(disambiguatePaths(sites)).toBe(0)
    expect(new Set(sites.map((s) => s.path)).size).toBe(2)
  })

  it('leaves the value on the bare path so a pointer stays readable', () => {
    // `sync` and the plural shapes both read a key name straight out of the
    // pointer; a `~2` in the middle would make `item_one` unrecognisable.
    const sites = [
      { path: '/item_one', kind: 'key', span: { start: 0, end: 1 } },
      { path: '/item_one', kind: 'scalar', span: { start: 2, end: 3 } },
    ] as RawSite[]
    disambiguatePaths(sites)
    expect(sites.find((s) => s.kind === 'scalar')!.path).toBe('/item_one')
    expect(sites.find((s) => s.kind === 'key')!.path).toBe('/item_one~2')
  })

  it('reports how many it had to move', () => {
    const sites = [
      { path: '/a', kind: 'scalar', span: { start: 0, end: 1 } },
      { path: '/a', kind: 'scalar', span: { start: 2, end: 3 } },
      { path: '/b', kind: 'scalar', span: { start: 4, end: 5 } },
    ] as RawSite[]
    expect(disambiguatePaths(sites)).toBe(1)
  })
})
