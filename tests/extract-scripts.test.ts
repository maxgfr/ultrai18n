// The four formats that had no reader.
//
// 743 sites in one real repository and 471 in another came back `unclassified`
// from these. None of it was lost — the residual sweep listed it and G2 refused
// — but listed is not understood, and the sweep fragments as it lists. A real
// example from a `.jsonl`:
//
//     "grounding\", \"author\": \"fable-crealink-improver-2/lens-A\", \"dimensionScor"
//
// Accounted for, and useless as a unit of translation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scan } from '../src/scan'
import { extractSql } from '../src/extract/sql'
import { isCommentOnly } from '../src/extract/shell'
import { OffsetMap } from '../src/vendor/text'
import { auditCoverage } from '../src/audit'
import type { Inventory, Site } from '../src/types'

let repo: string
let inv: Inventory

const sitesIn = (file: string): Site[] => inv.sites.filter((s) => s.file === file)
const valuesIn = (file: string): string[] => sitesIn(file).map((s) => s.value)
const censusOf = (file: string) => inv.census.find((c) => c.file === file)!

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-scripts-'))
  mkdirSync(join(repo, 'src'), { recursive: true })

  writeFileSync(
    join(repo, 'src', 'facturation.py'),
    [
      '"""Calcule les montants dus par chaque abonné."""',
      '# type: ignore',
      'import decimal',
      '',
      'STATUT = "actif"',
      '',
      'def resume(n):',
      '    """Rend une phrase lisible par une personne."""',
      '    # Arrondi au centime le plus proche',
      '    if STATUT == "actif":',
      '        return f"Vous avez {n} factures en attente"',
      '    return "Aucune facture"',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(repo, 'install.sh'),
    [
      '#!/bin/sh',
      '# shellcheck disable=SC2086',
      '# Installe les dépendances avant de démarrer le serveur',
      'set -eu',
      'npm install --production',
      'echo "Terminé"',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(repo, 'schema.sql'),
    [
      '-- Table des abonnés et de leur statut de paiement',
      'CREATE TABLE abonnes (',
      '  id SERIAL PRIMARY KEY,',
      "  statut TEXT NOT NULL DEFAULT 'actif',",
      "  message TEXT DEFAULT 'Bienvenue parmi nous'",
      ');',
      '/* Index ajouté pour la recherche par statut */',
      'CREATE INDEX ON abonnes (statut);',
      '',
    ].join('\n'),
  )

  writeFileSync(
    join(repo, 'events.jsonl'),
    [
      '{"event":"start","label":"Démarrer la session de travail"}',
      '{"event":"stop","label":"Arrêter la session en cours"}',
      '',
    ].join('\n'),
  )

  writeFileSync(join(repo, '.gitignore'), '# Rien de ce dossier ne doit être publié\ndist/\n*.log\n')

  inv = await scan({ repo, from: 'fr', to: 'en' })
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('python, on the AST tier', () => {
  it('reads a module docstring as the prose it is', () => {
    expect(valuesIn('src/facturation.py')).toContain('Calcule les montants dus par chaque abonné.')
  })

  it('reads a function docstring, which only a parser can tell from a string', () => {
    // A docstring is the first STATEMENT of a body, not a string that happens
    // to come first. That is not something a lexer can see, and it is the whole
    // argument for putting this reader on the AST tier.
    const site = sitesIn('src/facturation.py').find((s) => s.value.startsWith('Rend une phrase'))!
    expect(site.surface).toBe('comment.docstring')
    expect(site.verdict).toBe('translate')
  })

  it('reads comments, and leaves tool directives alone', () => {
    const values = valuesIn('src/facturation.py')
    expect(values).toContain('Arrondi au centime le plus proche')
    expect(values.some((v) => v.includes('type: ignore'))).toBe(false)
  })

  it('protects a compared literal, which is a token however it reads', () => {
    const compared = sitesIn('src/facturation.py').find((s) => s.value === 'actif' && s.line === 10)
    expect(compared?.verdict).toBe('do-not-translate')
  })

  it('reads an f-string as a template whose holes must survive', () => {
    const site = sitesIn('src/facturation.py').find((s) => s.value.includes('factures en attente'))!
    expect(site.kind).toBe('template')
    expect(site.value).toBe('Vous avez {0} factures en attente')
    expect(site.constraints.mustKeepHoles).toEqual([0])
  })

  it('claims every byte of a file that parsed cleanly', () => {
    expect(censusOf('src/facturation.py')).toMatchObject({ claimRatio: 1, tier: 'ast', degraded: false })
  })
})

describe('shell, on the AST tier', () => {
  it('finds the install instruction a person reads', () => {
    expect(valuesIn('install.sh')).toContain('Installe les dépendances avant de démarrer le serveur')
  })

  it('leaves the shebang and the linter directive alone', () => {
    const values = valuesIn('install.sh')
    expect(values.some((v) => v.includes('/bin/sh'))).toBe(false)
    expect(values.some((v) => v.includes('shellcheck'))).toBe(false)
  })

  it('emits comments and nothing else, which is the whole design', () => {
    // A shell script's strings are arguments to programs. Emitting them would
    // hand a translator a wall of tokens to refuse one at a time.
    expect(sitesIn('install.sh').every((s) => s.kind === 'comment')).toBe(true)
    expect(censusOf('install.sh')).toMatchObject({ claimRatio: 1, tier: 'ast' })
  })

  it('serves the ignore-file formats, which share its comment syntax', () => {
    expect(valuesIn('.gitignore')).toContain('Rien de ce dossier ne doit être publié')
    expect(isCommentOnly('.gitignore', '')).toBe(true)
    expect(isCommentOnly('.env.example', '.example')).toBe(true)
    // Not shell, and each its own decision rather than a guess made here.
    expect(isCommentOnly('app.ini', '.ini')).toBe(false)
    expect(isCommentOnly('nginx.conf', '.conf')).toBe(false)
  })
})

describe('sql, which earns its place by silencing', () => {
  it('reads the comments', () => {
    const values = valuesIn('schema.sql')
    expect(values).toContain('Table des abonnés et de leur statut de paiement')
    expect(values).toContain('Index ajouté pour la recherche par statut')
  })

  it('claims the DDL as read and non-textual, rather than sweeping it', () => {
    // The point of the reader. Without it the sweep forces every human-looking
    // run of DDL into the inventory as `unclassified`, and `check` refuses
    // until somebody adjudicates 384 of them one at a time.
    expect(censusOf('schema.sql')).toMatchObject({ claimRatio: 1, tier: 'structural' })
    expect(sitesIn('schema.sql').filter((s) => s.verdict === 'unclassified')).toEqual([])
    expect(valuesIn('schema.sql').some((v) => v.includes('CREATE TABLE'))).toBe(false)
  })

  it('still surfaces a literal carrying prose, and lets the classifier decide', () => {
    expect(valuesIn('schema.sql')).toContain('Bienvenue parmi nous')
  })

  it('says so when it loses sync instead of claiming the rest', () => {
    const src = "SELECT 'ouvert /* pas un commentaire"
    expect(extractSql('a.sql', src, new OffsetMap(src)).complete).toBe(false)
  })
})

describe('jsonl', () => {
  it('reads each line as its own document', () => {
    expect(valuesIn('events.jsonl')).toContain('Démarrer la session de travail')
    expect(valuesIn('events.jsonl')).toContain('Arrêter la session en cours')
  })

  it('anchors each line separately, so one translation cannot land on another', () => {
    const anchors = sitesIn('events.jsonl').map((s) => s.siteKey)
    expect(new Set(anchors).size).toBe(anchors.length)
    expect(anchors.some((a) => a.includes('/line[0]/'))).toBe(true)
    expect(anchors.some((a) => a.includes('/line[1]/'))).toBe(true)
  })

  it('gives spans that address the right bytes of the whole file', () => {
    // The failure this replaces was not a miss: the sweep listed the text and
    // fragmented it mid-token. A site has to address the file, not the line.
    const buf = readFileSync(join(repo, 'events.jsonl'))
    for (const site of sitesIn('events.jsonl')) {
      expect(buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')).toBe(site.value)
    }
  })

  it('accounts for every byte, newlines included', () => {
    expect(censusOf('events.jsonl').claimRatio).toBe(1)
  })
})

describe('an inline <script> is parsed, not swept', () => {
  // The markup scanner declares a `<script>` body UNREAD and the sweep covers
  // it. Honest, and unfinished: the strings arrive `unclassified` with no
  // container semantics, so a persisted key and a rendered label inside one are
  // indistinguishable. Routing the body to the AST tier is plumbing rather than
  // a lexer — the grammar load is async and lives in `scan`.
  let host: string
  let page: Inventory

  beforeAll(async () => {
    host = mkdtempSync(join(tmpdir(), 'ultrai18n-inline-'))
    writeFileSync(
      join(host, 'index.html'),
      [
        '<!doctype html>',
        '<html lang="fr">',
        '<head>',
        '<script type="application/ld+json">',
        '  {"name": "Atelier de publication", "description": "Un outil pour les auteurs"}',
        '</script>',
        '<script>',
        '  const VIDE = "Aucun projet pour le moment"',
        '  if (mode === "brouillon") render(VIDE)',
        '</script>',
        '</head>',
        '<body><p>Bienvenue dans l\'atelier</p></body>',
        '</html>',
        '',
      ].join('\n'),
    )
    writeFileSync(
      join(host, 'broken.html'),
      '<html><script>\n  const x = "Une chaîne bien lisible" @@@ ??? !!!\n</script></html>\n',
    )
    page = await scan({ repo: host, from: 'fr', to: 'en' })
  })

  afterAll(() => rmSync(host, { recursive: true, force: true }))

  const inPage = (file: string) => page.sites.filter((s) => s.file === file)

  it('gives a script string a real verdict instead of unclassified', () => {
    const site = inPage('index.html').find((s) => s.value === 'Aucun projet pour le moment')!
    expect(site.verdict).toBe('translate')
    expect(site.extractor).toBe('ts-ast')
  })

  it('carries the container semantics that were the whole point', () => {
    // `mode === "brouillon"` is compared, not rendered. Swept, it was one more
    // `unclassified` run indistinguishable from the label above it.
    const site = inPage('index.html').find((s) => s.value === 'brouillon')!
    expect(site.verdict).toBe('do-not-translate')
    expect(site.reason).toBe('api-contract')
  })

  it('reads a ld+json body as the structured data it is', () => {
    expect(inPage('index.html').map((s) => s.value)).toContain('Un outil pour les auteurs')
  })

  it('anchors each block separately, so two scripts cannot collide', () => {
    const anchors = inPage('index.html').map((s) => s.siteKey)
    expect(new Set(anchors).size).toBe(anchors.length)
    expect(anchors.some((a) => a.includes('#script[0]/'))).toBe(true)
    expect(anchors.some((a) => a.includes('#script[1]/'))).toBe(true)
  })

  it('gives spans that address the right bytes of the HOST file', () => {
    // The body is parsed as its own document with its own map, so every offset
    // has to be shifted back. Getting this wrong writes into the right file at
    // the wrong place, which no test of the extractor alone would catch.
    const buf = readFileSync(join(host, 'index.html'))
    for (const site of inPage('index.html')) {
      if (site.quote === null) continue
      expect(buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')).toBe(site.value)
    }
  })

  it('reports line numbers in the host document', () => {
    expect(inPage('index.html').find((s) => s.value === 'Aucun projet pour le moment')!.line).toBe(8)
  })

  it('claims every byte of a document whose scripts all parsed', () => {
    expect(page.census.find((c) => c.file === 'index.html')).toMatchObject({ claimRatio: 1 })
  })

  it('falls back to the sweep when the grammar cannot read the block', () => {
    // The fallback is the behaviour this replaces, reached now only when the
    // better answer is unavailable — and it still refuses to claim the bytes.
    const swept = inPage('broken.html').filter((s) => s.verdict === 'unclassified')
    expect(swept.some((s) => s.value.includes('Une chaîne bien lisible'))).toBe(true)
    expect(page.census.find((c) => c.file === 'broken.html')!.claimRatio).toBeLessThan(1)
  })
})

describe('all four together', () => {
  it('leave nothing unclassified', () => {
    const residual = inv.sites.filter((s) => s.verdict === 'unclassified')
    expect(residual.map((s) => `${s.file}:${s.line} ${s.value}`)).toEqual([])
  })

  it('survive their own audit', () => {
    expect(auditCoverage(inv, repo).findings).toEqual([])
  })
})
