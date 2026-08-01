#!/usr/bin/env node
// The corpus benchmark: what this engine finds, measured against ground truth
// somebody wrote down by hand.
//
// The headline number here is deliberately NOT recall. `found / hand_listed`
// makes the denominator one author's guess about what exists, which is exactly
// the unfalsifiable claim this project rejects ("We found every string"). The
// number that IS falsifiable is accounting: for every region a human declared,
// does the inventory contain a site whose bytes overlap it — and for every path
// git tracks, does the census name a bucket and a reason?
//
// So there are two hard floors and they are not negotiable per case:
//
//   accountingCoverage  every declared region is covered by a site
//   censusMismatches    every declared path is in the bucket it should be
//
// and one hard ceiling, which is the half with no in-product gate at all:
//
//   trapViolations      nothing declared `mustNotClaim` came back `translate`
//
// A miss in a file with no extractor is already caught by the residual sweep and
// G2. A false `translate` on a persisted enum is caught by nothing — G4 will
// actively demand it be translated, because it is a `translate` site still
// reading as the source language. That asymmetry is why a single trap violation
// fails the run while recall is measured against a floor a human can move.
//
// This drives the COMMITTED BUNDLE, not `src/`. It is what people actually run,
// and it needs no TypeScript loader.
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ENGINE = join(ROOT, 'skills', 'ultrai18n', 'scripts', 'ultrai18n.mjs')
const CORPUS = join(ROOT, 'bench', 'corpus')
const OUT = join(ROOT, 'bench', '.out')

const EXIT_OK = 0
const EXIT_FAILED = 1
const EXIT_USAGE = 2

main()

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    process.stderr.write(`ultrai18n bench: ${args.error}\n`)
    process.exit(EXIT_USAGE)
  }
  if (!existsSync(ENGINE)) {
    process.stderr.write(`ultrai18n bench: no engine at ${ENGINE} — run \`pnpm build\` first\n`)
    process.exit(EXIT_USAGE)
  }

  const thresholds = readJson(join(ROOT, 'bench', 'thresholds.json'))
  const cases = discoverCases(args.only)
  if (cases.length === 0) {
    process.stderr.write(`ultrai18n bench: no cases${args.only ? ` matching ${args.only}` : ''}\n`)
    process.exit(EXIT_USAGE)
  }

  mkdirSync(OUT, { recursive: true })
  const results = cases.map((c) => runCase(c, args))
  // The catalog ratchet is a claim about the WHOLE corpus. On a filtered run it
  // would report every rule the other cases exercise as newly dead, which is
  // noise dressed as a finding.
  const report = summarise(results, thresholds, { partial: !!args.only })

  writeFileSync(join(ROOT, 'bench', 'report.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(join(ROOT, 'bench', 'REPORT.md'), formatReport(report) + '\n')

  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else process.stdout.write(formatReport(report) + '\n')

  process.exit(report.ok ? EXIT_OK : EXIT_FAILED)
}

// ---------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const args = { only: null, json: false, ci: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--ci') args.ci = true
    else if (a === '--only') {
      args.only = argv[++i]
      if (!args.only) return { error: '--only needs a case name' }
    } else return { error: `unknown flag ${a}` }
  }
  return args
}

function discoverCases(only) {
  if (!existsSync(CORPUS)) return []
  return readdirSync(CORPUS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !only || name === only)
    .sort()
    .map((name) => ({ name, dir: join(CORPUS, name) }))
}

// ---------------------------------------------------------------------------
// Running one case

function runCase({ name, dir }, args) {
  const expected = readJson(join(dir, 'expected.json'))
  const problems = [...validateExpected(name, expected, args.ci), ...untrackedFiles(dir)]
  if (problems.length) {
    return { name, title: expected.title ?? name, malformed: problems, ok: false }
  }

  const repo = isolate(dir, expected, name)
  const out = join(OUT, name)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  try {
    const from = expected.scan?.from ?? 'auto'
    const to = expected.scan?.to ?? 'en'
    const scan = engine(['scan', '--repo', repo, '--out', out, '--from', from, '--to', to])
    if (scan.status !== 0) {
      return { name, title: expected.title ?? name, ok: false, crashed: `scan exited ${scan.status}: ${scan.stderr.slice(0, 400)}` }
    }
    const inventory = readJson(join(out, 'inventory.json'))

    // Determinism is a product guarantee, so a flaky bench means a broken
    // product, not a flaky bench. Second scan into a scratch dir, byte-compare
    // the sites.
    const out2 = join(OUT, name + '.repeat')
    rmSync(out2, { recursive: true, force: true })
    mkdirSync(out2, { recursive: true })
    engine(['scan', '--repo', repo, '--out', out2, '--from', from, '--to', to])
    const second = readJson(join(out2, 'inventory.json'))
    const deterministic = JSON.stringify(second.sites) === JSON.stringify(inventory.sites)
    rmSync(out2, { recursive: true, force: true })

    // `check` exits 1 whenever a gate fails, which several cases declare on
    // purpose. The exit code carries no information the report does not.
    const checkRun = engine(['check', '--repo', repo, '--out', out, '--json'])
    const report = parseJson(checkRun.stdout)

    return {
      name,
      title: expected.title ?? name,
      ...evaluate(dir, expected, inventory, report, deterministic),
    }
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

/**
 * Copy the case out of this repository and give it a git history of its own.
 *
 * The census denominator is `git ls-files` on purpose — the walker's own
 * exclusions are what G1 audits. A case scanned in place would be measured
 * against THIS repository's git state instead of its own.
 */
function isolate(dir, expected, name) {
  const repo = mkdtempSync(join(tmpdir(), `ultrai18n-bench-${name}-`))
  cpSync(dir, repo, { recursive: true })
  // `expected.json` is the ground truth, not part of the repository under test.
  rmSync(join(repo, 'expected.json'), { force: true })
  rmSync(join(repo, '.ultrai18n'), { recursive: true, force: true })

  // Files a git repository can hold but this one should not: a megabyte of
  // filler, and a symlink pointing out of the tree. Declared in the ground
  // truth so they are visible rather than magic.
  for (const g of expected.generate ?? []) {
    const abs = join(repo, g.file)
    mkdirSync(dirname(abs), { recursive: true })
    if (g.symlinkTo) symlinkSync(g.symlinkTo, abs)
    else writeFileSync(abs, g.repeat.repeat(Math.ceil(g.bytes / Buffer.byteLength(g.repeat))))
  }

  git(repo, ['init', '-q'])
  git(repo, ['add', '-A'])
  // A gitignored path that git tracks anyway. Common in the wild, and the
  // census has to attribute it rather than call it unaccounted.
  for (const f of expected.forceAdd ?? []) git(repo, ['add', '-f', f])
  git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'])
  return repo
}

// ---------------------------------------------------------------------------
// Evaluating one case against its ground truth

function evaluate(dir, expected, inventory, report, deterministic) {
  const findings = []
  const sitesByFile = new Map()
  for (const site of inventory.sites) {
    const list = sitesByFile.get(site.file)
    if (list) list.push(site)
    else sitesByFile.set(site.file, [site])
  }
  const censusByFile = new Map(inventory.census.map((e) => [e.file, e]))

  // --- regions ------------------------------------------------------------
  let accounted = 0
  let trapViolations = 0
  const expectations = expected.expectations ?? []
  for (const e of expectations) {
    const located = locate(dir, e)
    if (located.error) {
      findings.push({ kind: 'unresolvable', id: e.id, detail: located.error })
      continue
    }
    const covering = (sitesByFile.get(e.file) ?? []).filter(
      (s) => s.span.start < located.end && s.span.end > located.start,
    )
    if (covering.length === 0) {
      findings.push({
        kind: 'unaccounted',
        id: e.id,
        detail: `${e.file} bytes ${located.start}-${located.end} — no site covers this region`,
      })
      continue
    }
    accounted++

    const verdicts = covering.map((s) => s.verdict)
    if (e.mustNotClaim && verdicts.includes('translate')) {
      trapViolations++
      findings.push({
        kind: 'trap-violation',
        id: e.id,
        detail: `${e.file} — declared must-not-claim, came back translate`,
      })
    }
    if (e.expect?.verdict && !verdicts.includes(e.expect.verdict)) {
      findings.push({
        kind: 'verdict',
        id: e.id,
        detail: `${e.file} — expected ${e.expect.verdict}, got ${[...new Set(verdicts)].join('/')}`,
      })
    }
    if (e.expect?.reason && !covering.some((s) => s.reason === e.expect.reason)) {
      findings.push({
        kind: 'verdict',
        id: e.id,
        detail: `${e.file} — expected reason ${e.expect.reason}, got ${[...new Set(covering.map((s) => s.reason ?? 'none'))].join('/')}`,
      })
    }
    if (e.expect?.hard !== undefined && !covering.some((s) => s.hard === e.expect.hard)) {
      findings.push({
        kind: 'verdict',
        id: e.id,
        detail: `${e.file} — expected hard=${e.expect.hard}, got ${[...new Set(covering.map((s) => s.hard))].join('/')}`,
      })
    }
    if (e.expect?.rule && !covering.some((s) => s.rule === e.expect.rule)) {
      findings.push({
        kind: 'rule',
        id: e.id,
        detail: `${e.file} — expected rule ${e.expect.rule}, got ${[...new Set(covering.map((s) => s.rule))].join('/')}`,
      })
    }
  }

  // --- path sites ---------------------------------------------------------
  // A filename that reads as source-language text is a site with a ZERO-WIDTH
  // span: it describes the path, not a region inside the file — and the file may
  // not even be readable (a screenshot named `réglages.png`). So it is asserted
  // by value, which is the only thing it has.
  for (const want of expected.pathSites ?? []) {
    const site = (sitesByFile.get(want.file) ?? []).find((s) => s.kind === 'key' && s.value === want.segment)
    if (!site) {
      findings.push({
        kind: 'path-site',
        id: want.file,
        detail: `no path site for segment ${JSON.stringify(want.segment)}`,
      })
      continue
    }
    if (want.verdict && site.verdict !== want.verdict) {
      findings.push({
        kind: 'path-site',
        id: want.file,
        detail: `expected ${want.verdict}, got ${site.verdict}`,
      })
    }
  }

  // --- plural families ----------------------------------------------------
  // Asserted by ANCHOR, which is structural and survives the text being
  // translated — unlike a siteKey, which is what the region expectations
  // deliberately avoid.
  const familyByAnchor = new Map((inventory.plurals ?? []).map((f) => [f.anchor, f]))
  for (const want of expected.plurals ?? []) {
    const family = familyByAnchor.get(want.anchor)
    if (want.expect === 'absent') {
      if (family) findings.push({ kind: 'plural', id: want.anchor, detail: 'a family was detected where the case says there is none' })
      continue
    }
    if (!family) {
      findings.push({ kind: 'plural', id: want.anchor, detail: 'no family at this anchor' })
      continue
    }
    for (const [key, actual] of [
      ['categories', family.sourceCategories],
      ['missing', family.missing],
      ['extra', family.extra],
      ['targetRequired', family.targetRequired],
    ]) {
      if (want[key] === undefined) continue
      if (JSON.stringify(actual) !== JSON.stringify(want[key])) {
        findings.push({
          kind: 'plural',
          id: want.anchor,
          detail: `${key}: expected ${JSON.stringify(want[key])}, got ${JSON.stringify(actual)}`,
        })
      }
    }
    for (const key of ['locale', 'writeMode', 'shape', 'dialect']) {
      if (want[key] !== undefined && family[key] !== want[key]) {
        findings.push({
          kind: 'plural',
          id: want.anchor,
          detail: `${key}: expected ${JSON.stringify(want[key])}, got ${JSON.stringify(family[key])}`,
        })
      }
    }
  }

  // --- census -------------------------------------------------------------
  let censusMismatches = 0
  for (const want of expected.census ?? []) {
    const got = censusByFile.get(want.file)
    if (!got) {
      censusMismatches++
      findings.push({ kind: 'census-missing', id: want.file, detail: 'not in the census at all' })
      continue
    }
    const CENSUS_KEYS = [
      'bucket', 'reason', 'extractor', 'degraded', 'mustVerifyManually',
      'byteAddressable', 'claimRatio',
    ]
    for (const key of CENSUS_KEYS) {
      if (want[key] === undefined) continue
      const actual = key === 'extractor' ? (got.extractors ?? []).join(',') : got[key]
      // `null` asserts ABSENCE. Needed because the interesting claim about a
      // UTF-16 file is that the engine reports no `claimRatio` for it at all —
      // "not measured" rather than a number — and `undefined` already means
      // "this case does not care".
      const matches =
        want[key] === null
          ? actual === undefined
          : key === 'reason'
            ? String(actual ?? '').startsWith(want[key])
            : actual === want[key]
      if (!matches) {
        censusMismatches++
        findings.push({
          kind: 'census',
          id: want.file,
          detail: `${key}: expected ${JSON.stringify(want[key])}, got ${JSON.stringify(actual)}`,
        })
      }
    }
  }

  // --- gates --------------------------------------------------------------
  let gateMismatches = 0
  const gateOutcomes = {}
  for (const gate of report.gates ?? []) gateOutcomes[gate.id] = gate.ok ? 'pass' : 'fail'
  for (const [id, want] of Object.entries(expected.gates ?? {})) {
    if (want === 'any') continue
    const got = gateOutcomes[id]
    if (got !== want) {
      gateMismatches++
      findings.push({ kind: 'gate', id, detail: `expected ${want}, got ${got ?? 'no such gate'}` })
    }
  }

  if (!deterministic) {
    findings.push({ kind: 'determinism', id: 'scan', detail: 'a second scan produced different sites' })
  }

  // Everything a human wrote down explicitly — a verdict, a rule id, a path
  // site — is a hard claim. Aggregate recall gets a floor somebody can move; an
  // assertion somebody typed does not, or writing one down would mean less than
  // leaving it out.
  const expectationMismatches = findings.filter(
    (f) => f.kind === 'verdict' || f.kind === 'rule' || f.kind === 'path-site' || f.kind === 'plural',
  ).length

  return {
    expectations: expectations.length,
    accounted,
    expectationMismatches,
    trapViolations,
    censusMismatches,
    gateMismatches,
    determinismFailures: deterministic ? 0 : 1,
    gates: gateOutcomes,
    // Which catalog rules actually DECIDED something here. `checkCatalog`
    // validates a rule's shape — docs present, reason present — and never its
    // reachability, so a rule can be well-formed, cited, and unable to fire.
    rulesExercised: [...new Set(inventory.sites.map((s) => s.rule).filter(Boolean))].sort(),
    sites: inventory.sites.length,
    tracked: inventory.census.length,
    // Things this case knows the engine gets wrong or cannot express. Reported
    // in every run and gated by nothing — the alternative is to bake the wrong
    // behaviour into ground truth, where it stops being visible and starts
    // looking like a decision somebody made.
    knownGaps: expected.knownGaps ?? [],
    findings,
    ok: findings.length === 0,
  }
}

/**
 * Resolve an expectation's `find` to a byte range in the case's own file.
 *
 * Keyed on a verbatim substring rather than on a `siteKey`, and the reason is
 * the difference between a check and a rubber stamp: writing a siteKey means
 * running the tool and copying its answer, so the expectation would be derived
 * from the output it exists to verify. A substring is something a human can
 * read off the fixture and confirm by eye — and when it stops resolving, it
 * fails loudly instead of silently pointing at the wrong line.
 */
function locate(dir, e) {
  const abs = join(dir, e.file)
  if (!existsSync(abs)) return { error: `${e.file} does not exist in the case` }
  const decoded = decode(readFileSync(abs))
  if (!decoded) return { error: `${e.file} is binary or latin1 — its spans are not byte-addressable` }
  const buf = decoded
  const needle = Buffer.from(e.find, 'utf8')

  const hits = []
  let at = buf.indexOf(needle)
  while (at !== -1) {
    hits.push(at)
    at = buf.indexOf(needle, at + 1)
  }
  if (hits.length === 0) return { error: `${e.file} does not contain ${JSON.stringify(e.find)}` }
  const wanted = e.occurrence ?? 1
  if (hits.length > 1 && e.occurrence === undefined) {
    return { error: `${e.file} contains ${JSON.stringify(e.find)} ${hits.length} times — add "occurrence"` }
  }
  const start = hits[wanted - 1]
  if (start === undefined) return { error: `${e.file} has no occurrence ${wanted} of ${JSON.stringify(e.find)}` }
  return { start, end: start + needle.length }
}

/**
 * Refuse a case holding a file THIS repository does not track.
 *
 * A corpus file that git ignores never reaches a fresh clone, so the case passes
 * on the machine that wrote it and fails — or worse, quietly measures less —
 * everywhere else. It is easy to walk into: a case needs a `dist/`, a
 * `node_modules/`, a `.log`, or its own `.gitignore`, and any of those may match
 * a rule in the outer repository.
 *
 * The remedy is `generate`, which materialises such a file into the isolated
 * copy at run time and keeps it visible in the ground truth. This check is what
 * makes the mistake loud instead of silent.
 */
function untrackedFiles(dir) {
  const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--ignored', '--', dir], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (r.status !== 0) return []
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((f) => `${f} is on disk but ignored by this repository — declare it under "generate" instead`)
}

/**
 * Decode a file the way the engine does, and return the buffer its byte offsets
 * index into.
 *
 * This is not a nicety. `src/vendor/text.ts` strips a UTF-8 BOM before handing
 * the text to an extractor, so every span in a BOM file is three bytes off from
 * the raw file — and a UTF-16 file's spans do not address its bytes at all.
 * Searching the raw bytes would silently mislocate every expectation in exactly
 * the files this case exists to test.
 *
 * Returns null for the encodings the engine itself marks non-addressable, so a
 * region expectation on one fails loudly instead of comparing nonsense.
 */
function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)).toString('utf16le'), 'utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return Buffer.from(swapped.toString('utf16le'), 'utf8')
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return Buffer.from(buf.subarray(3))
  }
  if (buf.includes(0)) return null
  // Not valid UTF-8 means the engine fell back to latin1, where a decoded-string
  // offset is not a file-byte offset either. Round-tripping is the exact test.
  if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) return null
  return buf
}

/**
 * Reject a ground-truth file that cannot be trusted.
 *
 * `why` carries the same discipline G5 puts on an exception's justification: an
 * expectation without a reason is a place to hide. `--promote` writes `TODO:`
 * on purpose, so a miss found in the wild stays red until somebody writes down
 * what it proves.
 */
function validateExpected(name, expected, ci) {
  const problems = []
  if (expected.schemaVersion !== 1) problems.push('schemaVersion must be 1')
  if (expected.case !== name) problems.push(`"case" is ${JSON.stringify(expected.case)}, directory is ${name}`)
  if (!expected.title) problems.push('missing "title"')

  const ids = new Set()
  for (const e of expected.expectations ?? []) {
    if (!e.id) problems.push('an expectation has no id')
    else if (ids.has(e.id)) problems.push(`duplicate expectation id ${e.id}`)
    ids.add(e.id)
    if (!e.file) problems.push(`${e.id}: no file`)
    if (!e.find) problems.push(`${e.id}: no find`)
    if (!e.why || !e.why.trim()) problems.push(`${e.id}: no why`)
    else if (ci && /^TODO\b/.test(e.why.trim())) problems.push(`${e.id}: why is still a TODO`)
  }
  for (const c of expected.census ?? []) {
    if (!c.file) problems.push('a census claim has no file')
    if (!c.why || !c.why.trim()) problems.push(`census ${c.file}: no why`)
    else if (ci && /^TODO\b/.test(c.why.trim())) problems.push(`census ${c.file}: why is still a TODO`)
  }
  for (const f of expected.plurals ?? []) {
    if (!f.anchor) problems.push('a plural claim has no anchor')
    if (!f.why || !f.why.trim()) problems.push(`plural ${f.anchor}: no why`)
    else if (ci && /^TODO\b/.test(f.why.trim())) problems.push(`plural ${f.anchor}: why is still a TODO`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Summary and thresholds

function summarise(results, thresholds, opts = {}) {
  const totals = {
    cases: results.length,
    expectations: sum(results, 'expectations'),
    accounted: sum(results, 'accounted'),
    expectationMismatches: sum(results, 'expectationMismatches'),
    trapViolations: sum(results, 'trapViolations'),
    censusMismatches: sum(results, 'censusMismatches'),
    gateMismatches: sum(results, 'gateMismatches'),
    determinismFailures: sum(results, 'determinismFailures'),
    malformed: results.filter((r) => r.malformed).length,
    crashed: results.filter((r) => r.crashed).length,
  }
  const accountingCoverage = totals.expectations === 0 ? 1 : totals.accounted / totals.expectations

  // The catalog ratchet. `neverExercisedRules` may only ever SHRINK: a rule that
  // falls off the list without being exercised is a new dead rule, and a listed
  // rule that starts firing means somebody fixed it and the list is stale.
  const exercised = new Set(results.flatMap((r) => r.rulesExercised ?? []))
  const allowed = new Set(thresholds.neverExercisedRules ?? [])
  const dead = (thresholds.allRules ?? []).filter((id) => !exercised.has(id))
  const newlyDead = opts.partial ? [] : dead.filter((id) => !allowed.has(id))
  const revived = opts.partial ? [] : [...allowed].filter((id) => exercised.has(id))

  const hard = thresholds.hard ?? {}
  const breaches = []
  if (accountingCoverage < (hard.accountingCoverage ?? 1)) {
    breaches.push(`accountingCoverage ${fmt(accountingCoverage)} < ${fmt(hard.accountingCoverage ?? 1)}`)
  }
  for (const key of [
    'expectationMismatches', 'trapViolations', 'censusMismatches',
    'gateMismatches', 'determinismFailures',
  ]) {
    if (hard[key] !== undefined && totals[key] > hard[key]) {
      breaches.push(`${key} ${totals[key]} > ${hard[key]}`)
    }
  }
  for (const id of newlyDead) {
    breaches.push(`catalog rule ${id} decided nothing in the whole corpus — write a case for it, or allowlist it and say why`)
  }
  for (const id of revived) {
    breaches.push(`catalog rule ${id} is exercised now — remove it from neverExercisedRules`)
  }
  if (totals.malformed) breaches.push(`${totals.malformed} case(s) have a malformed expected.json`)
  if (totals.crashed) breaches.push(`${totals.crashed} case(s) crashed the engine`)
  // A finding that breached no threshold is still a finding: the committed
  // REPORT.md is diff-gated, so it shows up in review either way.
  const otherFindings = results.flatMap((r) => r.findings ?? []).length -
    totals.expectationMismatches - totals.trapViolations -
    totals.censusMismatches - totals.gateMismatches

  // No engine version and no timings in here. Both are committed artifacts that
  // CI diff-gates, and either field would churn them on every release or every
  // run — turning the one signal worth having, "what the tool finds changed",
  // into noise nobody reads.
  return {
    schemaVersion: 1,
    totals: { ...totals, accountingCoverage: round(accountingCoverage), otherFindings },
    thresholds: hard,
    catalog: {
      partial: !!opts.partial,
      exercised: [...exercised].sort(),
      neverExercised: dead.sort(),
      allowlisted: [...allowed].sort(),
    },
    breaches,
    ok: breaches.length === 0,
    cases: results.map((r) => ({
      case: r.name,
      title: r.title,
      ...(r.malformed ? { malformed: r.malformed } : {}),
      ...(r.crashed ? { crashed: r.crashed } : {}),
      ...(r.expectations !== undefined
        ? {
            expectations: r.expectations,
            accounted: r.accounted,
            sites: r.sites,
            tracked: r.tracked,
            gates: r.gates,
            knownGaps: r.knownGaps,
            findings: r.findings,
          }
        : {}),
    })),
  }
}

function formatReport(report) {
  const t = report.totals
  const lines = []
  lines.push(`# ultrai18n bench — ${t.cases} case(s), ${t.expectations} expectation(s)`)
  lines.push('')
  lines.push('```')
  lines.push(row('accounting coverage', `${t.accounted}/${t.expectations}`, fmt(t.accountingCoverage), t.accounted === t.expectations))
  lines.push(row('expectation mismatches', String(t.expectationMismatches), '', t.expectationMismatches === 0))
  lines.push(row('trap violations', String(t.trapViolations), '', t.trapViolations === 0))
  lines.push(row('census mismatches', String(t.censusMismatches), '', t.censusMismatches === 0))
  lines.push(row('gate mismatches', String(t.gateMismatches), '', t.gateMismatches === 0))
  lines.push(row('determinism', `${t.cases - t.determinismFailures}/${t.cases}`, '', t.determinismFailures === 0))
  lines.push('```')
  lines.push('')

  if (report.catalog) {
    const c = report.catalog
    lines.push(
      `## catalog coverage — ${c.exercised.length} rule(s) exercised, ${c.neverExercised.length} never` +
        (c.partial ? ' (partial run: the ratchet is a whole-corpus claim and is not applied)' : ''),
    )
    lines.push('')
    if (c.neverExercised.length) {
      lines.push('```')
      for (const id of c.neverExercised) {
        lines.push(`  ${id.padEnd(38)}${c.allowlisted.includes(id) ? 'allowlisted' : 'NOT ALLOWLISTED'}`)
      }
      lines.push('```')
      lines.push('')
    }
  }

  lines.push('## by case')
  lines.push('')
  for (const c of report.cases) {
    if (c.malformed) {
      lines.push(`### ${c.case} — MALFORMED`)
      for (const p of c.malformed) lines.push(`  - ${p}`)
      lines.push('')
      continue
    }
    if (c.crashed) {
      lines.push(`### ${c.case} — CRASHED`)
      lines.push(`  ${c.crashed}`)
      lines.push('')
      continue
    }
    const gates = Object.entries(c.gates).map(([id, v]) => `${id} ${v}`).join('  ')
    lines.push(`### ${c.case} — ${c.title}`)
    lines.push('')
    lines.push('```')
    lines.push(`  ${c.accounted}/${c.expectations} accounted   ${c.sites} site(s)   ${c.tracked} tracked path(s)`)
    lines.push(`  ${gates}`)
    lines.push('```')
    if (c.findings.length) {
      lines.push('')
      for (const f of c.findings) lines.push(`  - **${f.kind}** \`${f.id}\` — ${f.detail}`)
    }
    if (c.knownGaps?.length) {
      lines.push('')
      lines.push('  Known gaps, gated by nothing:')
      for (const g of c.knownGaps) lines.push(`  - ${g}`)
    }
    lines.push('')
  }

  if (report.breaches.length) {
    lines.push('## breaches')
    lines.push('')
    for (const b of report.breaches) lines.push(`- ${b}`)
  } else {
    lines.push('Every floor held.')
  }
  return lines.join('\n')
}

function row(label, value, ratio, ok) {
  return `  ${label.padEnd(24)}${value.padEnd(12)}${ratio.padEnd(8)}${ok ? 'ok' : 'FAIL'}`
}

// ---------------------------------------------------------------------------
// Plumbing

function engine(args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr}`)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path} is not readable JSON: ${err.message}`)
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// Declarations, not `const` arrows: `main()` runs at the top of this file, so an
// arrow down here is still in its temporal dead zone when `summarise` calls it.
function sum(rows, key) {
  return rows.reduce((n, r) => n + (r[key] ?? 0), 0)
}
function round(n) {
  return Math.round(n * 1000) / 1000
}
function fmt(n) {
  return n.toFixed(3)
}
