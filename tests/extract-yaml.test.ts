import { describe, it, expect } from 'vitest'
import { extractYaml } from '../src/extract/yaml'
import { OffsetMap } from '../src/vendor/text'

const run = (src: string, file = 'a.yml') => extractYaml(file, src, new OffsetMap(src))
const byPath = (src: string) =>
  Object.fromEntries(
    run(src)
      .sites.filter((s) => s.kind !== 'comment')
      .map((s) => [s.path, s.value]),
  )

describe('the GitHub surface', () => {
  it('finds issue-form labels, placeholders and dropdown options', () => {
    // basilico shipped these entirely in French through two translation passes.
    const src = `name: Bug
description: Quelque chose ne marche pas comme prévu.
body:
  - type: textarea
    id: what
    attributes:
      label: Ce qui se passe
      placeholder: 1. Démarrer un focus
  - type: dropdown
    attributes:
      label: Navigateur
      options:
        - Onglet de navigateur
        - Application installée (PWA)
`
    const paths = byPath(src)
    expect(paths['/name']).toBe('Bug')
    expect(paths['/description']).toBe('Quelque chose ne marche pas comme prévu.')
    expect(paths['/body/0/attributes/label']).toBe('Ce qui se passe')
    expect(paths['/body/0/attributes/placeholder']).toBe('1. Démarrer un focus')
    expect(paths['/body/1/attributes/options/0']).toBe('Onglet de navigateur')
    expect(paths['/body/1/attributes/options/1']).toBe('Application installée (PWA)')
  })

  it('separates sequence items by index', () => {
    const paths = byPath(`items:\n  - one\n  - two\n  - three\n`)
    expect(paths['/items/0']).toBe('one')
    expect(paths['/items/2']).toBe('three')
  })
})

describe('block scalars', () => {
  it('captures a release-notes body as its own site', () => {
    const src = `jobs:
  release:
    steps:
      - uses: softprops/action-gh-release@v2
        with:
          body: |
            ### Extension Chrome
            Téléchargez le zip, puis ouvrez chrome://extensions
`
    const { sites } = run(src, '.github/workflows/release.yml')
    const block = sites.find((s) => s.kind === 'block-scalar')!
    expect(block).toBeDefined()
    expect(block.path).toBe('/jobs/release/steps/0/with/body')
    expect(block.value).toContain('### Extension Chrome')
    expect(block.value).toContain('chrome://extensions')
  })

  it('dedents the body so a nested extractor sees real markdown', () => {
    const src = `a:\n  body: |\n    # Titre\n    Du texte.\n`
    const block = run(src).sites.find((s) => s.kind === 'block-scalar')!
    expect(block.value).toBe('# Titre\nDu texte.')
  })

  it('hands the body to a nested extractor with ABSOLUTE offsets', () => {
    // One coordinate system for the whole run, or the patcher writes into the
    // wrong position of the right file.
    const src = `a:\n  body: |\n    Bonjour\n`
    const seen: { body: string; start: number; path: string }[] = []
    extractYaml('w.yml', src, new OffsetMap(src), (body, absoluteStart, path) => {
      seen.push({ body, start: absoluteStart, path })
      return []
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.body).toBe('Bonjour')
    expect(seen[0]!.path).toBe('/a/body')
    expect(Buffer.from(src, 'utf8').subarray(seen[0]!.start).toString('utf8')).toMatch(/^Bonjour/)
  })

  it('does not treat a following sibling key as part of the block', () => {
    const src = `a:\n  body: |\n    inside\n  other: outside\n`
    const paths = byPath(src)
    expect(paths['/a/other']).toBe('outside')
    const block = run(src).sites.find((s) => s.kind === 'block-scalar')!
    expect(block.value).toBe('inside')
  })
})

describe('scalars and quoting', () => {
  it('reads quoted scalars and strips the quotes from the value', () => {
    const paths = byPath(`a: "Données effacées."\nb: 'Oui, c''est fini'\n`)
    expect(paths['/a']).toBe('Données effacées.')
    expect(paths['/b']).toBe("Oui, c'est fini")
  })

  it('stops a plain scalar at an inline comment', () => {
    expect(byPath(`a: valeur # un commentaire\n`)['/a']).toBe('valeur')
  })

  it('keeps a hash inside a quoted scalar', () => {
    expect(byPath(`a: "chrome://extensions#top"\n`)['/a']).toBe('chrome://extensions#top')
  })
})

describe('comments', () => {
  it('emits standalone comments as sites', () => {
    const { sites } = run(`# Mise à jour hebdomadaire\nversion: 2\n`, '.github/dependabot.yml')
    const comment = sites.find((s) => s.kind === 'comment')!
    expect(comment.value).toBe('Mise à jour hebdomadaire')
  })

  it('ignores comments with no words', () => {
    expect(run(`# ---\na: 1\n`).sites.filter((s) => s.kind === 'comment')).toHaveLength(0)
  })
})

describe('byte offsets', () => {
  it('round-trips accented scalars', () => {
    const src = `description: "Un minuteur de focus, avec tâches et alertes."\n`
    const site = run(src).sites.find((s) => s.kind === 'scalar')!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.valueSpan.start, site.valueSpan.end).toString('utf8')).toBe(
      'Un minuteur de focus, avec tâches et alertes.',
    )
  })

  it('round-trips a plain scalar', () => {
    const src = `label: Ce qui se passe\n`
    const site = run(src).sites.find((s) => s.kind === 'scalar')!
    const buf = Buffer.from(src, 'utf8')
    expect(buf.subarray(site.span.start, site.span.end).toString('utf8')).toBe('Ce qui se passe')
  })
})

describe('honesty about gaps', () => {
  it('records constructs it deliberately skips rather than dropping them silently', () => {
    const { skipped } = run(`a: &anchor value\nb: [1, 2]\n`)
    expect(skipped.join(' ')).toContain('anchor')
    expect(skipped.join(' ')).toContain('flow collection')
  })
})
