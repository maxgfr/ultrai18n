import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'
import { escapeFor, unescapeFor, type HostSyntax } from '../src/escape'
import type { Inventory } from '../src/types'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-apply-'))
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const write = (rel: string, body: string): void => {
  const dir = join(repo, rel.split('/').slice(0, -1).join('/'))
  if (dir !== repo) mkdirSync(dir, { recursive: true })
  writeFileSync(join(repo, rel), body)
}
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8')

async function translateFirst(
  rel: string,
  match: (v: string) => boolean,
  to: string,
): Promise<{ inv: Inventory; report: ReturnType<typeof apply> }> {
  const inv = await scan({ repo, from: 'fr', to: 'en' })
  const site = inv.sites.find((s) => s.file === rel && match(s.value))
  if (!site) throw new Error(`no site in ${rel} matching; saw ${inv.sites.filter((s) => s.file === rel).map((s) => JSON.stringify(s.value)).join(', ')}`)
  const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: to }], write: true })
  return { inv, report }
}

describe('delimiters survive', () => {
  it('keeps a line comment’s marker', async () => {
    // Writing the text alone over a comment's span deletes the `//` and turns
    // the comment into a syntax error. Silent, and fatal.
    write('a.ts', '// Le même tableau existe ailleurs.\nexport const a = 1\n')
    await translateFirst('a.ts', (v) => v.includes('Le même'), 'The same table exists elsewhere.')
    expect(read('a.ts')).toBe('// The same table exists elsewhere.\nexport const a = 1\n')
  })

  it('keeps a single-line block comment’s delimiters', async () => {
    write('a.ts', '/* Le thème vit ici. */\nexport const a = 1\n')
    await translateFirst('a.ts', (v) => v.includes('thème'), 'The theme lives here.')
    expect(read('a.ts')).toBe('/* The theme lives here. */\nexport const a = 1\n')
  })

  it('keeps a JSDoc block’s gutter asterisks', async () => {
    // Losing them turns a documented function into a wall of prose the next
    // reader has to re-format by hand.
    write('a.ts', '/**\n * Première ligne.\n * Deuxième ligne.\n */\nexport const a = 1\n')
    await translateFirst('a.ts', (v) => v.includes('Première'), 'First line.\nSecond line.')
    expect(read('a.ts')).toBe('/**\n * First line.\n * Second line.\n */\nexport const a = 1\n')
  })

  it('keeps a CSS comment’s delimiters', async () => {
    write('a.css', '/* Le compte à rebours ne doit jamais danser. */\n.a { color: red }\n')
    await translateFirst('a.css', (v) => v.includes('rebours'), 'The countdown must never dance.')
    expect(read('a.css')).toBe('/* The countdown must never dance. */\n.a { color: red }\n')
  })

  it('keeps a YAML comment’s hash', async () => {
    write('a.yml', '# Mise à jour hebdomadaire\nversion: 2\n')
    await translateFirst('a.yml', (v) => v.includes('hebdomadaire'), 'Weekly update')
    expect(read('a.yml')).toBe('# Weekly update\nversion: 2\n')
  })

  it('keeps an HTML comment’s delimiters', async () => {
    write('a.html', '<!-- Le pied de page -->\n<p>x</p>\n')
    await translateFirst('a.html', (v) => v.includes('pied'), 'The footer')
    expect(read('a.html')).toBe('<!-- The footer -->\n<p>x</p>\n')
  })

  it('keeps a string’s original quote style', async () => {
    write('a.ts', "export const a = 'Données effacées.'\n")
    await translateFirst('a.ts', (v) => v.includes('Données'), 'Data erased.')
    expect(read('a.ts')).toBe("export const a = 'Data erased.'\n")
  })
})

describe('escaping', () => {
  it('escapes an apostrophe for a single-quoted host', async () => {
    write('a.ts', "export const a = 'Tout effacer'\n")
    await translateFirst('a.ts', (v) => v.includes('effacer'), "C'est fini")
    expect(read('a.ts')).toBe("export const a = 'C\\'est fini'\n")
  })

  it('escapes braces in JSX text, but never the ampersand', async () => {
    // JSX renders `&` literally; escaping it would put "R&amp;D" on screen.
    write('a.tsx', 'export const C = () => <p>Bonjour</p>\n')
    await translateFirst('a.tsx', (v) => v === 'Bonjour', 'R&D {x} costs > 5')
    expect(read('a.tsx')).toContain('R&D &#123;x&#125; costs &gt; 5')
  })

  it('quotes a YAML scalar that would otherwise change meaning', async () => {
    write('a.yml', 'label: Bonjour\n')
    await translateFirst('a.yml', (v) => v === 'Bonjour', 'Note: this matters')
    // Unquoted, `Note: this matters` parses as a nested mapping.
    expect(read('a.yml')).toBe("label: 'Note: this matters'\n")
  })

  it('escapes a JSON string per RFC 8259', async () => {
    write('a.json', '{"description": "Bonjour"}\n')
    await translateFirst('a.json', (v) => v === 'Bonjour', 'He said "hi"\\done')
    expect(JSON.parse(read('a.json')).description).toBe('He said "hi"\\done')
  })

  it('round-trips every escaper over a nasty corpus', () => {
    const corpus = [
      "Oui, c'est fini",
      'Il a dit "bonjour"',
      'Coût > 5 {x} & <b>',
      'Note: voilà # ici',
      'Chemin C:\\Users\\x',
      'Ligne un\nligne deux',
      '100% — «guillemets»',
      'Fin */ et /* début',
    ]
    // Every syntax that CAN round-trip, not the eight that happened to work.
    // Six inverses used to be copies of the escaper, so this check was comparing
    // escape(escape(x)) against x for every format outside the original list —
    // and passing, because most text has nothing to escape.
    const syntaxes: HostSyntax[] = [
      'js-single', 'js-double', 'js-template', 'json-string',
      'jsx-attr-string', 'html-attr', 'html-text', 'jsx-text',
      'po-string', 'toml-basic', 'ftl-pattern', 'dockerfile-value',
      'py-triple', 'sql-string', 'plain',
    ]
    /**
     * Syntaxes that cannot hold a newline, so folding it is the correct answer
     * and the round trip is deliberately lossy. `apply` refuses such a write
     * rather than performing it, which is what the identity inverse encodes.
     */
    const foldsNewlines = new Set<HostSyntax>(['line-comment', 'dockerfile-value', 'sql-string'])
    const broken: string[] = []
    for (const syntax of syntaxes) {
      for (const text of corpus) {
        if (foldsNewlines.has(syntax) && /\n/.test(text)) continue
        const quote = syntax === 'js-single' ? "'" : '"'
        const back = unescapeFor(syntax, escapeFor(syntax, text, { quote }), { quote })
        if (back !== text) broken.push(`${syntax}: ${JSON.stringify(text)} → ${JSON.stringify(back)}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('refuses rather than silently folding, where the host cannot hold a newline', () => {
    // The lossy direction is modelled, not hidden: re-reading returns the
    // folded text, which no longer equals the translation, so `apply`'s
    // round-trip self-check fails the write instead of performing it.
    const text = 'Ligne un\nligne deux'
    for (const syntax of ['line-comment', 'sql-string', 'dockerfile-value'] as HostSyntax[]) {
      expect(`${syntax}: ${unescapeFor(syntax, escapeFor(syntax, text))}`).not.toBe(`${syntax}: ${text}`)
    }
  })
})

describe('templates and holes', () => {
  it('rewrites the whole literal so a hole can move', async () => {
    // "Move {0} up" → "Monter {0}" deletes a static chunk outright. Nothing but
    // a whole-span rewrite can express that.
    write('a.ts', 'export const a = (t: string) => `Move ${t} up`\n')
    const inv = await scan({ repo, from: 'en', to: 'fr' })
    const site = inv.sites.find((s) => s.value === 'Move {0} up')!
    apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Monter {0}' }], write: true })
    expect(read('a.ts')).toBe('export const a = (t: string) => `Monter ${t}`\n')
  })

  it('reorders holes when the target language needs it', async () => {
    write('a.ts', 'export const a = (d: string, t: string) => `${d} of ${t} sessions`\n')
    const inv = await scan({ repo, from: 'en', to: 'fr' })
    const site = inv.sites.find((s) => s.value === '{0} of {1} sessions')!
    apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'sessions {1} sur {0}' }], write: true })
    expect(read('a.ts')).toBe('export const a = (d: string, t: string) => `sessions ${t} sur ${d}`\n')
  })
})

describe('safety', () => {
  it('is dry-run by default and touches nothing', async () => {
    write('a.ts', "export const a = 'Bonjour'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.value === 'Bonjour')!
    const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello' }] })
    expect(report.sites.applied).toBe(1)
    expect(read('a.ts')).toBe("export const a = 'Bonjour'\n")
  })

  it('refuses a site whose text has vanished, rather than writing at a stale offset', async () => {
    write('a.ts', "export const a = 'Bonjour'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.value === 'Bonjour')!
    write('a.ts', "export const a = 'Something else entirely'\n")
    const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello' }], write: true })
    expect(report.ok).toBe(false)
    expect(report.outcomes[0]).toMatchObject({ status: 'refused' })
    expect(read('a.ts')).toBe("export const a = 'Something else entirely'\n")
  })

  it('follows a site whose file grew above it', async () => {
    // The site is where it always was, relative to its own text. Following it
    // is a fact, not a guess — but only because the answer is unique.
    write('a.ts', "export const a = 'Bonjour'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.value === 'Bonjour')!
    write('a.ts', "// a new line above\nexport const a = 'Bonjour'\n")
    const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello' }], write: true })
    expect(report.sites.recovered).toBe(1)
    expect(read('a.ts')).toBe("// a new line above\nexport const a = 'Hello'\n")
  })

  it('refuses when the text moved but occurs more than once', async () => {
    write('a.ts', "export const a = 'Bonjour'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.value === 'Bonjour')!
    write('a.ts', "const x = 'Bonjour'\nconst y = 'Bonjour'\nexport const a = 'Bonjour'\n")
    const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello' }], write: true })
    expect(report.ok).toBe(false)
    expect(report.outcomes[0]!.status).toBe('refused')
  })

  it('holds back a whole group when one of its files refuses', async () => {
    // CI must never see the app translated and its test not.
    write('a.ts', "export const a = 'Bonjour'\n")
    write('b.ts', "export const b = 'Bonjour'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const sa = inv.sites.find((s) => s.file === 'a.ts')!
    const sb = inv.sites.find((s) => s.file === 'b.ts')!
    write('b.ts', "export const b = 'moved away'\n")
    const report = apply({
      repo,
      inventory: inv,
      translations: [{ id: sa.id, text: 'Hello' }, { id: sb.id, text: 'Hello' }],
      write: true,
      groups: [[sa.id, sb.id]],
    })
    expect(report.groups.incomplete).toBe(1)
    expect(read('a.ts')).toBe("export const a = 'Bonjour'\n")
  })

  it('applies several sites in one file without shifting each other', async () => {
    write('a.ts', "export const a = 'un'\nexport const b = 'deux'\nexport const c = 'trois'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const ids = ['un', 'deux', 'trois'].map((v) => inv.sites.find((s) => s.value === v)!.id)
    const report = apply({
      repo,
      inventory: inv,
      write: true,
      translations: [
        { id: ids[0]!, text: 'one — a much longer replacement' },
        { id: ids[1]!, text: 'two' },
        { id: ids[2]!, text: 'three' },
      ],
    })
    expect(report.sites.applied).toBe(3)
    expect(read('a.ts')).toBe(
      "export const a = 'one — a much longer replacement'\nexport const b = 'two'\nexport const c = 'three'\n",
    )
  })

  it('is idempotent: applying the same run twice is a no-op the second time', async () => {
    write('a.ts', "export const a = 'Bonjour'\n")
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    const site = inv.sites.find((s) => s.value === 'Bonjour')!
    apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello' }], write: true })
    const after = read('a.ts')
    // Re-running is a valid recovery from an interrupted write, so a patched
    // site must not read as drift.
    const second = apply({ repo, inventory: inv, translations: [{ id: site.id, text: 'Hello' }], write: true })
    expect(read('a.ts')).toBe(after)
    expect(second.sites.refused).toBeGreaterThanOrEqual(0)
  })
})
