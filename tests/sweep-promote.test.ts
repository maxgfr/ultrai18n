// Promoting a wild miss into a case somebody has to explain.
//
// Driven by a SYNTHETIC findings file and a temp root: promoting into the real
// `bench/corpus/` would turn CI red, which is a poor way to test the thing that
// deliberately turns CI red.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — a plain .mjs script, imported for the same reason the
// bench itself is: it is what people actually run.
import { promote, parseSelector, PromoteError } from '../bench/promote.mjs'

let root: string
let clones: string

const REPOS = {
  repos: [
    { slug: 'acme/mit-app', url: 'https://example.test/mit.git', sha: 'abc123', license: 'MIT', tier: 'core' },
    { slug: 'acme/gpl-app', url: 'https://example.test/gpl.git', sha: 'def456', license: 'GPL-3.0', tier: 'core' },
    { slug: 'acme/mystery', url: 'https://example.test/x.git', sha: 'ghi789', license: 'Weird-1.0', tier: 'core' },
  ],
}

const findingsFor = (slug: string) => [
  {
    slug,
    license: REPOS.repos.find((r) => r.slug === slug)!.license,
    confirmedMisses: [
      {
        id: 0,
        file: 'src/labels.py',
        line: 3,
        locator: 'gettext.msgid-plural',
        text: 'Un message non lu',
        claimRatio: 1,
        extractor: 'po',
      },
    ],
  },
]

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ultrai18n-promote-'))
  clones = join(root, 'clones')
  for (const slug of ['acme/mit-app', 'acme/gpl-app', 'acme/mystery']) {
    const dir = join(clones, slug.replace('/', '__'), 'src')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'labels.py'),
      ['# en-tête', 'LABELS = [', '    "Un message non lu",', '    "Des messages non lus",', ']', ''].join('\n'),
    )
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the selector', () => {
  it('reads both forms, and a slug contains a slash so it splits on the right colon', () => {
    expect(parseSelector('acme/x:3')).toEqual({ slug: 'acme/x', index: 3 })
    expect(parseSelector('acme/x:src/a.py:12')).toEqual({ slug: 'acme/x', file: 'src/a.py', line: 12 })
  })

  it('refuses a shape it cannot act on', () => {
    expect(() => parseSelector('acme/x')).toThrow(PromoteError)
    expect(() => parseSelector('acme/x:notanumber')).toThrow(PromoteError)
  })
})

describe('a permissive source', () => {
  it('writes a case whose why starts TODO and which carries no expect block', () => {
    // No `expect`, deliberately: the observed verdict is what the engine does
    // TODAY and that is the behaviour under suspicion. Writing it in would pin
    // the bug rather than the finding.
    const r = promote({
      findings: findingsFor('acme/mit-app'),
      repos: REPOS,
      selector: 'acme/mit-app:0',
      root,
      cloneDir: clones,
    })
    expect(r.kind).toBe('excerpt')
    const expected = JSON.parse(readFileSync(join(r.dir, 'expected.json'), 'utf8'))
    expect(expected.expectations[0].why.startsWith('TODO:')).toBe(true)
    expect(expected.expectations[0].expect).toBeUndefined()
    expect(expected.title.startsWith('TODO:')).toBe(true)
    // The `find` has to resolve against the excerpt, or the case is malformed
    // on its very first run.
    expect(readFileSync(join(r.dir, 'labels.py'), 'utf8')).toContain(expected.expectations[0].find)
  })

  it('records provenance a reader can act on', () => {
    const dir = join(root, 'bench', 'corpus', 'sweep-acme-mit-app-gettext.msgid-plural')
    const prov = readFileSync(join(dir, 'PROVENANCE.md'), 'utf8')
    for (const fragment of ['acme/mit-app', 'abc123', 'src/labels.py', 'MIT', 'gettext.msgid-plural']) {
      expect(prov).toContain(fragment)
    }
  })

  it('never overwrites a case that already exists', () => {
    expect(() =>
      promote({ findings: findingsFor('acme/mit-app'), repos: REPOS, selector: 'acme/mit-app:0', root, cloneDir: clones }),
    ).toThrow(/already exists/)
  })
})

describe('a copyleft source', () => {
  it('copies zero bytes and writes REPRODUCE.md instead', () => {
    // Reading one to measure is fine; vendoring it into an MIT repository is
    // not a licensing question a benchmark gets to answer.
    const r = promote({
      findings: findingsFor('acme/gpl-app'),
      repos: REPOS,
      selector: 'acme/gpl-app:0',
      root,
      cloneDir: clones,
    })
    expect(r.kind).toBe('reproduce')
    expect(readdirSync(r.dir)).toEqual(['REPRODUCE.md'])
    const body = readFileSync(join(r.dir, 'REPRODUCE.md'), 'utf8')
    expect(body).toContain('No source was copied')
    expect(body).toContain('git clone --depth 1')
    // And nothing landed where the bench would pick it up as a case.
    expect(existsSync(join(root, 'bench', 'corpus', r.name))).toBe(false)
  })

  it('fails closed on a licence it does not recognise', () => {
    // A licence this script does not know is not a licence it may copy under.
    const r = promote({
      findings: findingsFor('acme/mystery'),
      repos: REPOS,
      selector: 'acme/mystery:0',
      root,
      cloneDir: clones,
    })
    expect(r.kind).toBe('reproduce')
  })
})

describe('refusals', () => {
  it('names an unpinned repository', () => {
    expect(() =>
      promote({ findings: findingsFor('acme/mit-app'), repos: REPOS, selector: 'acme/nope:0', root, cloneDir: clones }),
    ).toThrow(/no pinned repository/)
  })

  it('says how many misses there are when the index is wrong', () => {
    expect(() =>
      promote({ findings: findingsFor('acme/mit-app'), repos: REPOS, selector: 'acme/mit-app:99', root, cloneDir: clones }),
    ).toThrow(/no confirmed miss/)
  })

  it('refuses when the repository has never been swept', () => {
    expect(() =>
      promote({ findings: [], repos: REPOS, selector: 'acme/mit-app:0', root, cloneDir: clones }),
    ).toThrow(/has no findings/)
  })
})
