// Three places where the tool reported success over a wrong result.
//
// `apply` wrote a Python f-string's holes in JavaScript's spelling, and wrote an
// apostrophe into a TOML literal string, both reported as applied. A `.sql` file
// the lexer gave up on lost everything after that point without a site.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { apply } from '../src/apply'
import { escapeFor, spliceHoles, UnknownSyntaxError } from '../src/escape'

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-host-'))
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const translate = async (rel: string, body: string, match: string, to: string) => {
  writeFileSync(join(repo, rel), body)
  const inv = await scan({ repo, from: 'fr', to: 'en' })
  const site = inv.sites.find((s) => s.file === rel && s.value.includes(match))
  if (!site) throw new Error(`no site matching ${match}: ${inv.sites.map((s) => s.value).join(' | ')}`)
  const report = apply({ repo, inventory: inv, translations: [{ id: site.id, text: to }], write: true })
  return { report, out: readFileSync(join(repo, rel), 'utf8') }
}

describe('interpolations are written in the host language', () => {
  const python = async (src: string, match: string, to: string, want: string) => {
    const { report, out } = await translate('a.py', `x = ${src}\n`, match, to)
    expect(report.outcomes[0]).toMatchObject({ status: 'applied' })
    expect(out).toBe(`x = ${want}\n`)
  }

  it('writes a Python hole with braces alone', () =>
    python('f"Vous avez {n} factures en attente"', 'factures', 'You have {0} pending invoices', 'f"You have {n} pending invoices"'))

  it('keeps a format spec and a conversion', () =>
    python('f"Total {x:>8} pour {y!r} ici"', 'Total', 'Sum {0} for {1} here', 'f"Sum {x:>8} for {y!r} here"'))

  it('follows a hole the translation moved', () =>
    python('f"De {a} vers {b} ici"', 'vers', 'To {1}, from {0}', 'f"To {b}, from {a}"'))

  it('accepts two holes spelled the same', () =>
    python('f"De {x} vers {x} encore"', 'vers', 'From {0} to {1} again', 'f"From {x} to {x} again"'))

  it('steps over a doubled brace', () =>
    python('f"Accolade {{0}} et {n} ici"', 'Accolade', 'Brace {{0}} and {0} here', 'f"Brace {{0}} and {n} here"'))

  it('leaves an expression holding quotes as it was', () =>
    python(`f"Bonjour {d['nom']} ici"`, 'Bonjour', 'Hello {0} here', `f"Hello {d['nom']} here"`))

  it('covers a triple-quoted f-string', () =>
    python('f"""Ligne {n} en cours"""', 'Ligne', 'Line {0} running', 'f"""Line {n} running"""'))

  it('still writes a JavaScript template as a JavaScript template', async () => {
    const { out } = await translate('a.ts', 'export const a = `Vous avez ${n} factures`\n', 'factures', 'You have {0} invoices')
    expect(out).toBe('export const a = `You have ${n} invoices`\n')
  })

  it('refuses a host whose interpolation syntax is unknown', () => {
    expect(() => spliceHoles('json', '{0}', [{ index: 0, span: { start: 0, end: 0 }, expr: 'x' }])).toThrow(UnknownSyntaxError)
  })
})

describe('a TOML literal string', () => {
  it('refuses an apostrophe, as a refusal, and leaves the file alone', async () => {
    const body = "titre = 'Le fichier est prêt'\n"
    const { report, out } = await translate('a.toml', body, 'fichier', "It's ready")
    expect(report.outcomes[0]).toMatchObject({ status: 'refused', why: expect.stringMatching(/literal string/) })
    expect(report.sites.applied).toBe(0)
    expect(out).toBe(body)
  })

  it('refuses it too in a file written in \\u escapes, where the round-trip check is skipped', async () => {
    const body = 'autre = "caf\\u00e9"\ntitre = \'Le fichier est pret\'\n'
    const { report, out } = await translate('a.toml', body, 'fichier', "It's ready")
    expect(report.outcomes[0]).toMatchObject({ status: 'refused' })
    expect(out).toBe(body)
  })

  it('refuses a line break', () => {
    expect(() => escapeFor('toml-literal', 'one\ntwo')).toThrow(/line break/)
  })

  it('still writes what it can hold', async () => {
    const { report, out } = await translate('a.toml', "titre = 'Le fichier est prêt'\n", 'fichier', 'The file is ready')
    expect(report.outcomes[0]).toMatchObject({ status: 'applied' })
    expect(out).toBe("titre = 'The file is ready'\n")
  })

  it('leaves a basic string free to hold an apostrophe', async () => {
    const { out } = await translate('a.toml', 'titre = "Le fichier est prêt"\n', 'fichier', "It's ready")
    expect(out).toBe('titre = "It\'s ready"\n')
  })
})

describe('an SQL file the lexer lost sync on', () => {
  const scanned = async (body: string) => {
    writeFileSync(join(repo, 'a.sql'), body)
    const inv = await scan({ repo, from: 'fr', to: 'en' })
    return { sites: inv.sites.filter((s) => s.file === 'a.sql'), census: inv.census.find((c) => c.file === 'a.sql')! }
  }

  it('hands an unterminated literal to the sweep', async () => {
    const { sites, census } = await scanned("-- Lu avant la panne\nSELECT 'ouvert jamais fermé et une phrase française perdue ici\n")
    expect(sites[0]).toMatchObject({ extractor: 'sql', value: 'Lu avant la panne' })
    const tail = sites.slice(1)
    expect(tail.length).toBeGreaterThan(0)
    expect(tail.every((s) => s.extractor === 'residual-sweep' && s.verdict === 'unclassified')).toBe(true)
    expect(tail.map((s) => s.value).join(' ')).toContain('phrase française perdue')
    expect(census.claimRatio).toBeLessThan(1)
  })

  it('hands an unterminated block comment to the sweep', async () => {
    const { sites } = await scanned('/* un commentaire jamais fermé avec une phrase française perdue\nSELECT 1;\n')
    expect(sites.map((s) => s.value).join(' ')).toContain('phrase française perdue')
  })

  it('sweeps nothing when the file reads to the end', async () => {
    const { sites, census } = await scanned("-- Une note lisible\nSELECT 'Bienvenue parmi nous';\n")
    expect(sites.some((s) => s.extractor === 'residual-sweep')).toBe(false)
    expect(census.claimRatio).toBe(1)
  })
})
