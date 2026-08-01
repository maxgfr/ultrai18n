// `sites --audit` — the check that makes the recall claim reproducible.
//
// The strongest claim this project makes is that a file whose `claimRatio` is
// 1.0 has an extractor ASSERTING it accounted for every byte. Until now that
// assertion could only be contradicted by `bench/sweep.mjs`, which needs the
// network, needs `codeindex` on PATH, and runs against nine pinned
// repositories — so the numbers it produced were numbers nobody else could
// reproduce, which is not evidence.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditCoverage, LOCATORS } from '../src/audit'
import { scan } from '../src/scan'
import type { CensusEntry, Inventory, Site } from '../src/types'

let repo: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'ultrai18n-audit-'))
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(
    join(repo, 'src', 'app.ts'),
    'export const a = 1\nconst label = "Enregistrer les modifications"\nexport const b = 2\n',
  )
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

/** A census entry and a site list, without running a scan that would agree with itself. */
const inventory = (census: Partial<CensusEntry>, sites: Partial<Site>[]): Inventory =>
  ({
    census: [{ file: 'src/app.ts', bucket: 'scanned', extractors: ['ts-ast'], claimRatio: 1, ...census }],
    sites,
  }) as unknown as Inventory

describe('an extractor asserting full coverage is held to it', () => {
  it('names the line holding text that no site covers', () => {
    const view = auditCoverage(inventory({}, []), repo)
    expect(view.ok).toBe(false)
    expect(view.findings).toHaveLength(1)
    expect(view.findings[0]).toMatchObject({ file: 'src/app.ts', line: 2, locator: 'quoted-prose' })
    expect(view.findings[0]!.text).toContain('Enregistrer les modifications')
  })

  it('says nothing when a site covers that line', () => {
    const view = auditCoverage(inventory({}, [{ file: 'src/app.ts', line: 2, endLine: 2 }]), repo)
    expect(view.ok).toBe(true)
    expect(view.audited).toBe(1)
  })

  it('counts a multi-line site as covering every line it spans', () => {
    // A block scalar, a template literal and a prose run all span several lines,
    // and a locator only ever knows the one it matched on — so the join has to
    // be interval containment rather than an equality on `line`.
    const view = auditCoverage(inventory({}, [{ file: 'src/app.ts', line: 1, endLine: 3 }]), repo)
    expect(view.findings).toEqual([])
  })
})

describe('the audit refuses to question a claim the file cannot make', () => {
  it('skips a file the residual sweep read, whose ratio was set rather than measured', () => {
    // `scan` sets `bytesClaimed = read.bytes` unconditionally on that branch, so
    // the 1.0 is construction rather than measurement. Counting it would turn
    // every format with no reader into an accusation.
    const view = auditCoverage(inventory({ extractors: ['residual-sweep'] }, []), repo)
    expect(view.findings).toEqual([])
    expect(view.excused.measured).toBe(1)
  })

  it('skips a file whose offsets do not address its bytes', () => {
    const view = auditCoverage(inventory({ byteAddressable: false }, []), repo)
    expect(view.findings).toEqual([])
    expect(view.excused.unaddressable).toBe(1)
  })

  it('skips a file that claimed less than everything', () => {
    const view = auditCoverage(inventory({ claimRatio: 0.7 }, []), repo)
    expect(view.findings).toEqual([])
  })

  it('skips a format no locator speaks for', () => {
    const view = auditCoverage(inventory({ extractors: ['ftl'] }, []), repo)
    expect(view.findings).toEqual([])
    expect(view.excused.noLocator).toBe(1)
  })
})

describe('the oracle does not accuse code of being text', () => {
  // Every one of these was a finding on the first run of this audit against
  // this repository, and every one of them is code.
  const uncovered = (name: string, body: string, extractor = 'ts-ast') => {
    writeFileSync(join(repo, 'src', name), body)
    return auditCoverage(
      inventory({ file: `src/${name}`, extractors: [extractor] }, []),
      repo,
    ).findings
  }

  it('reads a dotted member chain as one identifier, not two words', () => {
    expect(uncovered('a.ts', 'if (hit.line <= s.span.start) return\n')).toEqual([])
  })

  it('does not read a generic parameter list as a JSX text node', () => {
    expect(uncovered('b.ts', 'const m = new Map<string, Site[]>()\n')).toEqual([])
  })

  it('does not read the slashes inside a regex literal as a comment marker', () => {
    expect(uncovered('c.ts', 'const URL = /^(https?:\\/\\/|mailto:|tel:)/i\n')).toEqual([])
  })

  it('does not read a CSS custom property as a SQL comment', () => {
    expect(uncovered('d.css', ':root { --color-ink-950: #0b0f0e; }\n', 'css')).toEqual([])
  })

  it('still finds a real JSX label', () => {
    const found = uncovered('e.tsx', 'export const A = () => <p>Bonjour tout le monde</p>\n')
    expect(found.map((f) => f.locator)).toContain('jsx-text')
  })
})

describe('every locator says what it points at', () => {
  // The same discipline the catalog and the dialect rows are under: a row that
  // can accuse an extractor of missing something has to cite what it saw.
  it('carries a why and at least one extractor', () => {
    for (const row of LOCATORS) {
      expect(`${row.id}: ${row.why.length > 40}`).toBe(`${row.id}: true`)
      expect(`${row.id}: ${row.extractors.length > 0}`).toBe(`${row.id}: true`)
    }
  })

  it('has unique ids', () => {
    expect(new Set(LOCATORS.map((l) => l.id)).size).toBe(LOCATORS.length)
  })
})

describe('what the audit found on its first run', () => {
  let host: string

  beforeAll(() => {
    host = mkdtempSync(join(tmpdir(), 'ultrai18n-found-'))
    // A code span that WRAPS. The paragraph that follows it then holds one
    // unpaired backtick, and an inline-code mask allowed to cross a newline
    // pairs it with the next backtick — blanking prose and exposing code for
    // the rest of the block. On this repository's own SKILL.md that ate an
    // entire line of English out of a file reporting a claimRatio of 1.0.
    writeFileSync(
      join(host, 'doc.md'),
      '- `une commande [--avec] [--des]\n' +
        '  [--options]` — la description qui suit.\n' +
        '  La deuxième ligne, avec `du code` au milieu.\n' +
        '  La troisième ligne que le masque avalait entièrement.\n',
    )
    // A flow collection: recorded as skipped and claimed anyway, so the file
    // reported full coverage over a value that reached no site.
    mkdirSync(join(host, '.github', 'ISSUE_TEMPLATE'), { recursive: true })
    writeFileSync(
      join(host, '.github', 'ISSUE_TEMPLATE', 'bug.yml'),
      'name: Rapport de bogue\nlabels: [bogue, tri]\n',
    )
  })

  afterAll(() => rmSync(host, { recursive: true, force: true }))

  it('keeps every prose line of a paragraph following a wrapped code span', async () => {
    const inv = await scan({ repo: host, from: 'fr', to: 'en' })
    const values = inv.sites.filter((s) => s.file === 'doc.md').map((s) => s.value)
    expect(values.some((v) => v.includes('troisième ligne'))).toBe(true)
    expect(values.some((v) => v.includes('deuxième ligne'))).toBe(true)
  })

  it('sweeps a flow collection instead of claiming its bytes', async () => {
    const inv = await scan({ repo: host, from: 'fr', to: 'en' })
    const entry = inv.census.find((c) => c.file === '.github/ISSUE_TEMPLATE/bug.yml')!
    expect(entry.claimRatio).toBeLessThan(1)
    const swept = inv.sites.filter(
      (s) => s.verdict === 'unclassified' && s.whyUnclaimed?.includes('flow collection'),
    )
    expect(swept.some((s) => s.value.includes('bogue'))).toBe(true)
  })

  it('and the audit comes back clean once both are fixed', async () => {
    const inv = await scan({ repo: host, from: 'fr', to: 'en' })
    expect(auditCoverage(inv, host).findings).toEqual([])
  })
})
