#!/usr/bin/env node
// The real-repository sweep: codeindex locates, ultrai18n claims, and the
// difference is the finding.
//
// The offline corpus proves a fixed miss cannot come back. This asks the other
// question — what is missing that nobody thought to write a fixture for — and it
// needs a second opinion that knows nothing about this engine's decisions.
// `codeindex grep` is that opinion: it builds a candidate set from patterns
// alone, with no reference to the inventory.
//
// A grep oracle has its own false positives, so the honesty is in the BUCKETS.
// Every hit lands in exactly one, and only one of them is an accusation:
//
//   confirmed-miss   no covering site, the file was `scanned`, its claimRatio is
//                    1.0, and the locator is `strong`
//
// That combination is not a difference of opinion between two tools. When
// claimRatio is 1.0 the extractor ASSERTED it accounted for every byte of the
// file — so a human-looking line it never emitted contradicts a recorded claim.
// Everything else degrades into a lower bucket rather than into noise.
//
// Network-dependent, therefore manual and nightly, never the PR gate, and it
// exits 0 unless it crashes. A sweep that can fail a pull request is a sweep
// somebody will disable.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENGINE = join(ROOT, 'skills', 'ultrai18n', 'scripts', 'ultrai18n.mjs')
const OUT = join(ROOT, 'bench', '.out', 'sweep')
const CLONES = join(ROOT, 'bench', '.out', 'repos')

main()

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    process.stderr.write(`ultrai18n sweep: ${args.error}\n`)
    process.exit(2)
  }

  const locators = readJson(join(ROOT, 'bench', 'locators.json'))
  const manifest = readJson(join(ROOT, 'bench', 'repos.json'))
  const repos = manifest.repos.filter(
    (r) => (!args.only || r.slug === args.only) && (args.tier === 'all' || r.tier === args.tier),
  )
  if (repos.length === 0) {
    process.stderr.write('ultrai18n sweep: nothing selected\n')
    process.exit(2)
  }

  mkdirSync(OUT, { recursive: true })
  mkdirSync(CLONES, { recursive: true })

  const results = []
  for (const repo of repos) {
    process.stderr.write(`\n— ${repo.slug}\n`)
    try {
      results.push(sweepRepo(repo, locators, args))
    } catch (err) {
      results.push({ slug: repo.slug, crashed: String(err.message ?? err) })
      process.stderr.write(`  crashed: ${err.message ?? err}\n`)
    }
  }

  const report = formatSweep(results)
  writeFileSync(join(OUT, 'SWEEP.md'), report + '\n')
  writeFileSync(join(OUT, 'findings.json'), JSON.stringify(results, null, 2) + '\n')
  process.stdout.write(report + '\n')
  process.stdout.write(`\nwrote ${join(OUT, 'SWEEP.md')}\n`)
  // Always 0. This reports; it does not gate.
}

function parseArgs(argv) {
  const args = { only: null, tier: 'core', keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') args.only = argv[++i]
    else if (a === '--tier') args.tier = argv[++i]
    else if (a === '--keep') args.keep = true
    else return { error: `unknown flag ${a}` }
  }
  if (!args.tier) return { error: '--tier needs a value' }
  return args
}

// ---------------------------------------------------------------------------

function sweepRepo(repo, locators, args) {
  const dir = join(CLONES, repo.slug.replace('/', '__'))
  clone(repo, dir)

  // One indexing pass, incremental across nights. The read commands below reuse
  // it, which turns the second and later runs into a stat pass.
  process.stderr.write('  indexing…\n')
  codeindex(['index', '--repo', dir, '--out', join(dir, '.codeindex')])

  process.stderr.write('  locating…\n')
  const hits = []
  for (const locator of locators) {
    const found = codeindexJson(['grep', locator.pattern, '--repo', dir]) ?? []
    for (const hit of found) {
      if (locator.include && !locator.include.some((g) => matchGlob(g, hit.file))) continue
      hits.push({ ...hit, locator: locator.id, confidence: locator.confidence, kind: locator.kind ?? 'plural' })
    }
  }

  process.stderr.write(`  scanning (${hits.length} oracle hits)…\n`)
  const out = join(OUT, repo.slug.replace('/', '__'))
  mkdirSync(out, { recursive: true })
  const scan = engine(['scan', '--repo', dir, '--out', out, '--to', 'en'])
  if (scan.status !== 0) throw new Error(`scan exited ${scan.status}: ${scan.stderr.slice(0, 300)}`)
  const inventory = readJson(join(out, 'inventory.json'))

  return { slug: repo.slug, license: repo.license, ...join_(hits, inventory), workspaces: packages(dir) }
}

/**
 * Join the oracle's hits against the inventory, on LINE-INTERVAL CONTAINMENT.
 *
 * Line level, not byte level, because the oracle only knows the line — and
 * multi-line sites (block scalars, template literals, prose runs) make
 * containment the only correct test. A secondary text match raises confidence
 * and is never used to reject.
 */
function join_(hits, inventory) {
  const sitesByFile = new Map()
  for (const site of inventory.sites) {
    const list = sitesByFile.get(site.file)
    if (list) list.push(site)
    else sitesByFile.set(site.file, [site])
  }
  const censusByFile = new Map(inventory.census.map((c) => [c.file, c]))
  const walked = new Set(inventory.census.map((c) => c.file))

  const buckets = {
    claimed: [], protected: [], refused: [], surfaced: [],
    'explained-skip': [], 'confirmed-miss': [], candidate: [],
  }

  for (const hit of hits) {
    const covering = (sitesByFile.get(hit.file) ?? []).filter(
      (s) => s.line <= hit.line && hit.line <= s.endLine,
    )
    const census = censusByFile.get(hit.file)

    if (covering.length) {
      const verdicts = new Set(covering.map((s) => s.verdict))
      const bucket = verdicts.has('translate') || verdicts.has('locale-marker')
        ? 'claimed'
        : verdicts.has('do-not-translate')
          ? 'protected'
          : verdicts.has('needs-judgment')
            ? 'refused'
            : 'surfaced'
      buckets[bucket].push(entry(hit, census))
      continue
    }
    if (!census || census.bucket === 'skipped') {
      buckets['explained-skip'].push(entry(hit, census))
      continue
    }
    // The load-bearing row, and the one place this script can slander the
    // engine, so its predicate is narrow on purpose.
    //
    // `claimRatio === 1` means an extractor ASSERTED it accounted for every byte
    // of the file — "what I did not emit, I looked at and judged non-textual".
    // That assertion is what a missing site contradicts.
    //
    // It does NOT hold for a file the residual sweep read: `scan` sets
    // `bytesClaimed = read.bytes` unconditionally on that branch, so the ratio
    // is 1 by construction rather than by measurement. Counting those as
    // confirmed misses turned every `.po` file in a gettext repository into an
    // accusation, when "gettext has no reader" is a limit this project states
    // out loud and G2 already refuses to pass on.
    const asserted = census.claimRatio === 1 && measuredRatio(census)
    if (asserted && hit.confidence === 'strong') {
      buckets['confirmed-miss'].push(entry(hit, census))
    } else {
      buckets.candidate.push(entry(hit, census))
    }
  }

  return {
    oracleHits: hits.length,
    walked: walked.size,
    sites: inventory.sites.length,
    families: (inventory.plurals ?? []).length,
    pluralResidual: (inventory.pluralResidual ?? []).length,
    counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    // Only the two that need a human are carried in full; the rest are counts.
    confirmedMisses: buckets['confirmed-miss'].slice(0, 50),
    candidates: buckets.candidate.slice(0, 50),
  }
}

/**
 * Was this file's `claimRatio` MEASURED, or set?
 *
 * A declaration, not a `const`: `main()` runs at the top of this file, so a
 * `const` down here is still in its temporal dead zone when the join reaches it
 * — which surfaced as every repository "crashing".
 */
function measuredRatio(census) {
  const extractor = (census.extractors ?? [])[0] ?? ''
  return extractor !== '' && extractor !== 'residual-sweep' && extractor !== 'none'
}

function entry(hit, census) {
  return {
    file: hit.file,
    line: hit.line,
    locator: hit.locator,
    confidence: hit.confidence,
    text: (hit.text ?? '').trim().slice(0, 120),
    claimRatio: census?.claimRatio ?? null,
    extractor: (census?.extractors ?? []).join(',') || null,
    censusReason: census?.reason ?? null,
  }
}

function packages(dir) {
  const ws = codeindexJson(['workspaces', '--repo', dir])
  // The realistic failure in the wild is not a missed line but a missed PACKAGE,
  // and a repo-wide percentage hides that completely.
  return Array.isArray(ws?.packages) ? ws.packages.length : Array.isArray(ws) ? ws.length : null
}

// ---------------------------------------------------------------------------

function clone(repo, dir) {
  if (existsSync(join(dir, '.git'))) {
    process.stderr.write('  reusing clone\n')
    run('git', ['fetch', '--depth', '1', 'origin', repo.sha], dir)
  } else {
    process.stderr.write('  cloning…\n')
    mkdirSync(dir, { recursive: true })
    run('git', ['init', '-q'], dir)
    run('git', ['remote', 'add', 'origin', repo.url], dir)
    run('git', ['fetch', '--depth', '1', '--filter=blob:none', 'origin', repo.sha], dir)
  }
  run('git', ['checkout', '-q', 'FETCH_HEAD'], dir)
}

function run(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed: ${(r.stderr ?? '').slice(0, 300)}`)
  return r.stdout ?? ''
}

function codeindex(argv) {
  return spawnSync('codeindex', argv, { encoding: 'utf8', maxBuffer: 1 << 28 })
}

function codeindexJson(argv) {
  const r = codeindex(argv)
  if (r.status !== 0) return null
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

function engine(argv) {
  const r = spawnSync(process.execPath, [ENGINE, ...argv], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Enough glob for an `include` list: `**` any depth, `*` one segment.
 *
 * Built by tokenising rather than by chained `replace` calls. The chained
 * version had `.replace(//g, '.*')` in it — two slashes that JavaScript reads as
 * the start of a comment, so the rest of the expression silently vanished and
 * `node --check` was perfectly happy.
 */
function matchGlob(pattern, file) {
  let re = '^'
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches any number of directories, including none.
        if (pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
      continue
    }
    re += ch.replace(/[.+^${}()|[\]\\?]/, '\\$&')
  }
  return new RegExp(re + '$').test(file)
}

function formatSweep(results) {
  const lines = ['# ultrai18n sweep', '']
  lines.push('```')
  lines.push(
    '  repo'.padEnd(34) +
      'oracle'.padStart(8) + 'claimed'.padStart(9) + 'protect'.padStart(9) +
      'refused'.padStart(9) + 'surfaced'.padStart(10) + 'skip'.padStart(7) +
      'MISS'.padStart(7) + 'cand'.padStart(7),
  )
  for (const r of results) {
    if (r.crashed) {
      lines.push(`  ${r.slug.padEnd(32)}  crashed: ${r.crashed.slice(0, 60)}`)
      continue
    }
    const c = r.counts
    lines.push(
      `  ${r.slug.padEnd(32)}` +
        String(r.oracleHits).padStart(8) +
        String(c.claimed).padStart(9) +
        String(c.protected).padStart(9) +
        String(c.refused).padStart(9) +
        String(c.surfaced).padStart(10) +
        String(c['explained-skip']).padStart(7) +
        String(c['confirmed-miss']).padStart(7) +
        String(c.candidate).padStart(7),
    )
  }
  lines.push('```')
  lines.push('')

  const misses = results.flatMap((r) => (r.confirmedMisses ?? []).map((m) => ({ ...m, slug: r.slug })))
  lines.push(`## CONFIRMED MISSES (${misses.length})`)
  lines.push('')
  lines.push('A file whose `claimRatio` is 1.0 has an extractor asserting it accounted for')
  lines.push('every byte. A human-looking line no site covers contradicts that claim.')
  lines.push('')
  for (const m of misses) {
    lines.push(`- **${m.slug}** \`${m.file}:${m.line}\` — ${m.locator}`)
    lines.push(`  > ${m.text}`)
    lines.push(`  claimRatio ${m.claimRatio} · extractor ${m.extractor}`)
  }
  if (misses.length === 0) lines.push('_none_')
  lines.push('')

  const candidates = results.flatMap((r) => (r.candidates ?? []).map((c) => ({ ...c, slug: r.slug })))
  lines.push(`## CANDIDATES (${candidates.length}) — the oracle's own false positives live here`)
  lines.push('')
  lines.push('Never merged with the table above, and never summed with it.')
  lines.push('')
  for (const c of candidates.slice(0, 60)) {
    lines.push(`- ${c.slug} \`${c.file}:${c.line}\` — ${c.locator} (${c.confidence}, claimRatio ${c.claimRatio})`)
  }
  if (candidates.length > 60) lines.push(`- … and ${candidates.length - 60} more in findings.json`)
  return lines.join('\n')
}
