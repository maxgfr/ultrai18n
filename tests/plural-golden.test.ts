// A byte-exact snapshot of what `detectFamilies` produces today.
//
// This exists for exactly one reason: the plural detectors are about to be
// rewritten from five hand-written functions into three primitives driven by a
// data catalog, and "zero behaviour change" has to be a CHECK rather than an
// assertion. The other plural tests each pin one property; this pins the whole
// output, which is what a refactor can break in ways nobody thought to assert.
//
// It is deliberately NOT a behaviour test. If it fails and the diff is right,
// update it — after reading the diff. If it fails and the diff is a surprise,
// that surprise is the finding.
import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { isolatedRepo, removeRepo } from '../evals/isolate'
import { scan, isBundleFile } from '../src/scan'
import { detectFamilies } from '../src/plural/shapes'
import type { Site } from '../src/types'

const FIXTURE = join(import.meta.dirname, '..', 'evals', 'fixture-i18n')

let sites: Site[]

beforeAll(async () => {
  const repo = isolatedRepo(FIXTURE, 'plural-golden')
  try {
    const inv = await scan({ repo, from: 'auto', to: 'ru' })
    sites = inv.sites
  } finally {
    removeRepo(repo)
  }
}, 60_000)

describe('detectFamilies, pinned', () => {
  it('produces exactly this, family for family and form for form', () => {
    const families = detectFamilies(sites, { isBundle: isBundleFile })

    // Site ids are hashes of a structural anchor, so they are stable — but they
    // say nothing to a human reading a diff. Rendering each form as
    // `category=value` keeps the snapshot reviewable.
    const shaped = families
      .map((f) => ({
        shape: f.shape,
        file: f.file,
        base: f.base,
        ordinal: f.ordinal,
        forms: f.forms.map((form) => `${form.category}${form.selector ? `[${form.selector}]` : ''}=${form.value}`),
        exact: f.exact.map((e) => `${e.selector}=${e.value}`),
        siteCount: new Set(f.sites).size,
      }))
      .sort((a, b) => (a.file + a.base < b.file + b.base ? -1 : 1))

    expect(shaped).toMatchSnapshot()
  })

  it('claims each site for at most one family', () => {
    const families = detectFamilies(sites, { isBundle: isBundleFile })
    const seen = new Map<string, string>()
    for (const f of families) {
      for (const id of f.sites) {
        const owner = seen.get(id)
        // Precedence is what stops an ICU message under a `_one` key being read
        // twice — once as ICU, once as a key-suffix family whose value happens
        // to contain braces.
        expect(owner, `site ${id} claimed by ${owner} and ${f.shape}`).toBeUndefined()
        seen.set(id, `${f.shape}@${f.base}`)
      }
    }
  })

  it('is stable across two calls on the same inventory', () => {
    const a = detectFamilies(sites, { isBundle: isBundleFile })
    const b = detectFamilies(sites, { isBundle: isBundleFile })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
