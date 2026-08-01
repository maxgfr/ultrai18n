// The eval that decides whether this tool works.
//
// Every assertion below is a case a real French-to-English translation pass got
// wrong, or a trap it nearly fell into. Unit tests prove the extractors do what
// they were written to do; this proves the whole pipeline finds what two human
// passes over a real repository did not.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { isolatedRepo, removeRepo } from './isolate'
import { scan } from '../src/scan'
import type { Inventory, Site } from '../src/types'

const FIXTURE = join(import.meta.dirname, 'fixture')

let repo: string
let inv: Inventory
const at = (file: string, match: string | RegExp): Site | undefined =>
  inv.sites.find(
    (s) =>
      s.file === file &&
      (typeof match === 'string' ? s.value.includes(match) : match.test(s.value)),
  )
const allIn = (file: string): Site[] => inv.sites.filter((s) => s.file === file)

beforeAll(async () => {
  repo = isolatedRepo(FIXTURE, 'recall')
  inv = await scan({ repo, from: 'fr', to: 'en' })
}, 60_000)

afterAll(() => removeRepo(repo))

describe('the misses', () => {
  it('finds package.json description — the miss that motivated the tool', () => {
    const site = at('package.json', 'minuteur de focus')
    expect(site?.verdict).toBe('translate')
    // Found by rule, not by luck. The rule is the difference.
    expect(site?.rule).toBe('npm.package-json.description')
  })

  it('finds the web manifest inlined in a bundler config', () => {
    // `find -name manifest.json` returns nothing here: the manifest exists only
    // at build time, so a filename-driven search misses the whole PWA listing.
    const manifest = allIn('vite.config.ts').filter((s) => s.surface === 'meta.webmanifest')
    const values = manifest.map((s) => s.value)
    expect(values).toContain('fixture — minuteur de focus')
    expect(values).toContain('Un minuteur de focus local-first : sessions, tâches et statistiques.')
    expect(manifest.every((s) => s.verdict === 'translate')).toBe(true)
  })

  it('retargets the manifest lang rather than translating it', () => {
    // Both "translate it" and "leave it" are wrong for a locale marker.
    const lang = allIn('vite.config.ts').find((s) => s.verdict === 'locale-marker')
    expect(lang?.value).toBe('fr')
  })

  it('finds GitHub issue-form labels, placeholders and dropdown options', () => {
    const values = allIn('.github/ISSUE_TEMPLATE/bug.yml')
      .filter((s) => s.verdict === 'translate')
      .map((s) => s.value)
    expect(values).toContain('Ce qui se passe')
    expect(values).toContain('1. Démarrer un focus')
    expect(values).toContain('Onglet de navigateur')
  })

  it('finds the release-notes body nested in workflow YAML', () => {
    const body = allIn('.github/workflows/release.yml').find((s) => s.kind === 'block-scalar')
    expect(body?.value).toContain('### Extension Chrome')
    expect(body?.verdict).toBe('translate')
    expect(body?.rule).toBe('github.release-notes-body')
  })

  it('finds French comments in a stylesheet', () => {
    // The exact shape of what two separate human passes over the reference
    // repository both left behind: a file in src/ that nobody opened.
    const comments = allIn('src/index.css')
    expect(comments.length).toBeGreaterThanOrEqual(2)
    expect(comments.some((s) => s.value.includes('Le thème vit ici'))).toBe(true)
    expect(comments.every((s) => s.verdict === 'translate')).toBe(true)
  })

  it('finds French comments in TypeScript', () => {
    expect(at('src/protocol.ts', "Le même tableau")?.verdict).toBe('translate')
  })

  it('finds JSX text and text-bearing attributes', () => {
    expect(at('src/Pomodoros.tsx', 'Rien à faire')?.verdict).toBe('translate')
    expect(at('src/Pomodoros.tsx', 'Fermer')?.surface).toBe('ui.attribute-text')
  })

  it('finds markdown prose and HTML metadata', () => {
    expect(allIn('README.md').some((s) => s.verdict === 'translate')).toBe(true)
    expect(at('index.html', 'Un minuteur de focus local-first')?.verdict).toBe('translate')
    expect(at('index.html', 'Capture des réglages')?.verdict).toBe('translate')
  })
})

describe('the traps', () => {
  it('never translates a storage key', () => {
    expect(at('src/protocol.ts', 'fixture:v1:app')?.verdict).toBe('do-not-translate')
  })

  it('never translates a compared value', () => {
    const sync = allIn('src/protocol.ts').find((s) => s.value === 'sync')
    expect(sync?.verdict).toBe('do-not-translate')
    expect(sync?.reason).toBe('api-contract')
  })

  it('never translates a type-union member', () => {
    const focus = allIn('src/protocol.ts').filter((s) => s.value === 'focus')
    expect(focus.every((s) => s.verdict === 'do-not-translate')).toBe(true)
  })

  it('never translates a module specifier', () => {
    const imports = inv.sites.filter((s) => s.reason === 'module-specifier')
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every((s) => s.verdict === 'do-not-translate')).toBe(true)
  })

  it('never translates an object key', () => {
    expect(at('package.json', 'description')?.verdict).toBe('do-not-translate')
  })

  it('leaves vendored legal text alone, and hard', () => {
    const license = allIn('LICENSE')
    expect(license.length).toBeGreaterThan(0)
    // Hard means no agent verdict overrides it: altering LICENSE makes GitHub
    // report the licence as "Other".
    expect(license.every((s) => s.verdict === 'do-not-translate' && s.hard)).toBe(true)
  })

  it('never translates a viewport or theme-color meta', () => {
    // These read like prose and are layout directives.
    expect(at('index.html', 'width=device-width')?.verdict).toBe('do-not-translate')
    expect(at('index.html', '#0b0f0e')?.verdict).toBe('do-not-translate')
  })

  it('never translates a class name or a base path', () => {
    expect(at('vite.config.ts', '/fixture/')?.verdict).toBe('do-not-translate')
    expect(at('vite.config.ts', 'fixture-v1')?.verdict).toBe('do-not-translate')
  })
})

describe('the refusals', () => {
  it('refuses a plural rule baked into a ternary', () => {
    // French agrees the adjective too, so the target needs a different NUMBER
    // of agreement sites. No translated string can be correct here.
    const site = allIn('src/Pomodoros.tsx').find((s) => s.reason === 'grammar-hole')
    expect(site).toBeDefined()
    expect(site!.verdict).toBe('needs-judgment')
    expect(site!.holes.some((h) => h.grammar)).toBe(true)
  })

  it('refuses a label whose value has no word', () => {
    // '25 / 5' is a real label. The risk is a model helpfully expanding it to
    // '25 min / 5 min' and breaking the layout.
    const site = allIn('src/format.ts').find((s) => s.value === '25 / 5')
    expect(site?.reason).toBe('label-without-prose')
    expect(site?.verdict).toBe('needs-judgment')
  })

  it('refuses rather than guessing on short strings', () => {
    const short = inv.sites.filter((s) => s.reason === 'short-string')
    expect(short.length).toBeGreaterThan(0)
    expect(short.every((s) => s.lang.detected === null)).toBe(true)
  })
})

describe('the guarantees', () => {
  it('gives every site a byte span that round-trips against the file', () => {
    // A span that does not round-trip is silent corruption at write-back time.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const cache = new Map<string, Buffer>()
    const broken: string[] = []
    for (const s of inv.sites) {
      if (s.kind === 'prose-run' && s.extractor === 'markdown') continue
      let buf = cache.get(s.file)
      if (!buf) {
        buf = readFileSync(join(FIXTURE, s.file))
        cache.set(s.file, buf)
      }
      const slice = buf.subarray(s.span.start, s.span.end).toString('utf8')
      if (slice !== s.raw) broken.push(`${s.file}:${s.line} expected ${JSON.stringify(s.raw)} got ${JSON.stringify(slice)}`)
    }
    expect(broken.slice(0, 5)).toEqual([])
  })

  it('gives the same answer twice', () => {
    // Determinism is a product guarantee: without it, "nothing changed since
    // the last run" is unprovable.
    expect(inv.sites.map((s) => s.id)).toEqual([...inv.sites.map((s) => s.id)])
  })

  it('assigns every site a closed-vocabulary verdict', () => {
    const allowed = new Set(['translate', 'do-not-translate', 'locale-marker', 'needs-judgment', 'unclassified'])
    expect(inv.sites.filter((s) => !allowed.has(s.verdict))).toEqual([])
  })

  it('gives every do-not-translate a reason', () => {
    const missing = inv.sites.filter((s) => s.verdict === 'do-not-translate' && !s.reason)
    expect(missing.map((s) => `${s.file}:${s.line}`)).toEqual([])
  })

  it('infers the source language from the repository itself', () => {
    expect(inv.sourceLanguage).toBe('fr')
  })

  it('groups the same copy so it cannot diverge', () => {
    const grouped = inv.sites.filter((s) => s.links.duplicateOf || s.links.mirrors.length)
    expect(grouped.length).toBeGreaterThan(0)
  })

  it('accounts for every file it read', () => {
    const scanned = inv.census.filter((c) => c.bucket !== 'skipped')
    expect(scanned.length).toBeGreaterThan(0)
    // "Zero sites" must be a measurement, not a scanner that bailed early.
    expect(scanned.every((c) => typeof c.claimRatio === 'number')).toBe(true)
  })

  it('states its limits in the output, not only in the docs', () => {
    expect(inv.limits.length).toBeGreaterThan(4)
    expect(inv.limits.join(' ')).toContain('never claimed')
  })
})

describe('deterministic across runs', () => {
  it('produces a byte-identical inventory on a second scan', async () => {
    const again = await scan({ repo: FIXTURE, from: 'fr', to: 'en' })
    expect(JSON.stringify(again.sites)).toBe(JSON.stringify(inv.sites))
  }, 60_000)
})
