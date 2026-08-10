#!/usr/bin/env node
// The codeindex pin. codeindex (https://github.com/maxgfr/codeindex) enters this
// repository twice, and both entries have to move together or the shipped engine
// is a mixture of two versions:
//
//   1. FOUR SOURCE FILES ARE FORKED into src/vendor/ — walk.ts, ignore.ts,
//      glob.ts and util.ts, with the documented ULTRAI18N deltas. They are a
//      fork, not a copy, so a byte-identical drift check is impossible; what CAN
//      be gated is the FORK BASE — the upstream bytes we forked FROM. This
//      script records their hashes, and refuses a re-pin whose base moved,
//      because a moved base means a delta has to be re-applied by a human.
//   2. THE NPM PACKAGE IS A BUILD INPUT — src/ast/parse.ts imports it for
//      grammar provisioning and tsup inlines it (noExternal), so codeindex code
//      ships INSIDE skills/ultrai18n/scripts/ultrai18n.mjs, and its .wasm
//      grammars are committed beside it. The dependency is therefore pinned
//      EXACTLY, never with a caret: a silent minor bump would change bytes that
//      were never reviewed.
//
//   node scripts/sync-engine.mjs --ref v2.27.1   # re-pin to a release tag
//   node scripts/sync-engine.mjs --check         # offline consistency gate (CI)
//   node scripts/sync-engine.mjs --accept        # re-record a deliberate local edit
//   node scripts/sync-engine.mjs --list          # what is pinned, for the workflow
//
// Running --ref against the tag ALREADY pinned is the audit: it re-fetches the
// base and fails if upstream's bytes at that tag have changed under us.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = join(root, 'src', 'vendor')
const metaPath = join(vendorDir, 'engine.meta.json')

// The fork base: upstream path -> the vendored files derived from it. text.ts is
// listed under walk.ts because it is upstream's readText() lifted out of walk.ts
// (delta #3); an upstream change to walk.ts can therefore land in either file.
const BASE = [
  { remote: 'src/walk.ts', derived: ['walk.ts', 'text.ts'] },
  { remote: 'src/ignore.ts', derived: ['ignore.ts'] },
  { remote: 'src/glob.ts', derived: ['glob.ts'] },
  { remote: 'src/util.ts', derived: ['util.ts'] },
]

const VENDORED = BASE.flatMap((b) => b.derived).sort()

// Files carrying a `... codeindex v<x.y.z> ...` line that must name the pin. A
// stale stamp is how a reader ends up reasoning about the wrong upstream.
const STAMPED = [...VENDORED.map((f) => join('src', 'vendor', f)), join('src', 'vendor', 'README.md')]

const PKG = '@maxgfr/codeindex'
const REPO = 'maxgfr/codeindex'
const SEMVER = /\bv(\d+\.\d+\.\d+)\b/g

// The oldest codeindex release this repo's source is written against. Bump it in
// the same commit that starts depending on something a newer release added.
//
// Why this exists, in the words of the sibling repos that had it first: --check
// re-hashes the vendored bytes against the pin, so it catches a TAMPERED vendor
// but not a STALE one. A repo pinned three releases back passes cleanly — and
// because tsup INLINES the package into the shipped bundle, it then ships the
// old behaviour with every test green, measuring the wrong code.
const MIN_REF = 'v2.27.1'

// Numeric per component: "v1.10.0" is NEWER than "v1.9.0", which a string
// compare gets backwards, and backwards here silently disarms the gate at
// exactly the release where it starts to matter.
function cmpTag(a, b) {
  const parts = (t) =>
    String(t)
      .replace(/^v/, '')
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const read = (abs) => readFileSync(abs, 'utf8')
const fail = (msg) => {
  process.stderr.write(`sync-engine: ${msg}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const mode = args[0]
if (mode === '--check') check()
else if (mode === '--accept') accept()
else if (mode === '--list') list()
else if (mode === '--ref' || mode === '--engine') await repin()
else {
  process.stderr.write('usage: sync-engine.mjs [--engine codeindex] --ref <tag> [--base-reviewed] | --check | --accept | --list\n')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// --list: `<name> <repo> <pinned-tag>`, one line per engine. The daily re-pin
// workflow reads this instead of carrying its own copy of what is pinned where,
// so the automation cannot drift from the thing it is watching. One line here,
// several in the repos that vendor two engines — same contract either way.

function list() {
  const meta = readMeta({ optional: true })
  process.stdout.write(`codeindex ${REPO} ${meta?.tag ?? '-'}\n`)
}

// ---------------------------------------------------------------------------
// --check: offline. Everything that can be proved without the network.

function check() {
  const meta = readMeta()
  const errors = []

  // 1. The vendored fork is what was reviewed. These five files are a fork of
  //    someone else's code; an unrecorded edit to them is the one change that
  //    review is least likely to catch, because they read like upstream.
  for (const f of VENDORED) {
    const actual = sha256(readFileSync(join(vendorDir, f)))
    const expected = meta.vendored[f]
    if (!expected) errors.push(`src/vendor/${f} is not recorded in engine.meta.json`)
    else if (actual !== expected) {
      errors.push(
        `src/vendor/${f} differs from the recorded fork — if the edit is deliberate, ` +
          'document it in src/vendor/README.md and run `node scripts/sync-engine.mjs --accept`',
      )
    }
  }
  for (const f of Object.keys(meta.vendored)) {
    if (!VENDORED.includes(f)) errors.push(`engine.meta.json records src/vendor/${f}, which this script does not vendor`)
  }

  // 2. The pin names one version, everywhere. tag, engineVersion, every file
  //    stamp and the dependency have to agree; a mismatch means part of the
  //    repo is describing an upstream it is not using.
  if (meta.tag !== `v${meta.engineVersion}`) errors.push(`engine.meta.json: tag ${meta.tag} does not match engineVersion ${meta.engineVersion}`)
  for (const rel of STAMPED) errors.push(...stampErrors(rel, meta.engineVersion))

  // 3. The pin is not older than what the source needs. A tampered vendor is
  //    caught above by its hash; a stale one would sail through it.
  if (cmpTag(meta.tag, MIN_REF) < 0) {
    errors.push(
      `STALE pin — vendored ${meta.tag}, but this repo's source needs at least ${MIN_REF}. ` +
        `Run: node scripts/sync-engine.mjs --ref ${MIN_REF}   (or newer)`,
    )
  }

  const dep = JSON.parse(read(join(root, 'package.json'))).devDependencies?.[PKG]
  if (dep !== meta.engineVersion) {
    errors.push(
      `package.json pins ${PKG} at ${dep ?? '(absent)'}, but the engine pin is ${meta.engineVersion}. ` +
        'The package is inlined into the shipped bundle — it must be an EXACT version, equal to the pin.',
    )
  }

  if (errors.length) {
    for (const e of errors) process.stderr.write(`sync-engine: ${e}\n`)
    process.exit(1)
  }
  process.stdout.write(`sync-engine: pinned to codeindex ${meta.tag} — fork, stamps and dependency agree\n`)
}

// Every version mentioned in a stamped file must BE the pin. Asserting "the pin
// appears somewhere" is not enough: a file that names both v2.22.0 and the pin
// still tells the reader two different stories.
function stampErrors(rel, version) {
  const text = read(join(root, rel))
  const found = [...text.matchAll(SEMVER)].map((m) => m[1])
  if (found.length === 0) return [`${rel} carries no codeindex version stamp`]
  const wrong = [...new Set(found.filter((v) => v !== version))]
  return wrong.length ? [`${rel} names codeindex v${wrong.join(', v')} but the pin is v${version}`] : []
}

// ---------------------------------------------------------------------------
// --accept: re-record the fork after a deliberate, reviewed local edit.

function accept() {
  const meta = readMeta()
  const before = { ...meta.vendored }
  meta.vendored = hashVendored()
  const changed = VENDORED.filter((f) => before[f] !== meta.vendored[f])
  if (!changed.length) {
    process.stdout.write('sync-engine: nothing to accept — the fork already matches engine.meta.json\n')
    return
  }
  writeMeta(meta)
  for (const f of changed) process.stdout.write(`sync-engine: accepted src/vendor/${f}\n`)
}

// ---------------------------------------------------------------------------
// --ref <tag>: fetch the fork base at a tag, gate it, and move the pin.

async function repin() {
  // `--engine codeindex` is accepted and ignored: this repo vendors one engine,
  // but the fleet's re-pin workflow passes the name it read from --list, and a
  // script that rejected it would be a script the shared workflow cannot drive.
  const engineIdx = args.indexOf('--engine')
  if (engineIdx !== -1 && args[engineIdx + 1] !== 'codeindex') {
    fail(`unknown engine "${args[engineIdx + 1] ?? ''}" — this repo vendors codeindex only`)
  }
  const refIdx = args.indexOf('--ref')
  const ref = refIdx === -1 ? undefined : args[refIdx + 1]
  if (!ref || !/^v\d+\.\d+\.\d+$/.test(ref)) fail(`--ref expects a release tag like v2.27.1, got ${JSON.stringify(ref)}`)
  const version = ref.slice(1)
  const baseReviewed = args.includes('--base-reviewed')

  const meta = readMeta({ optional: true })
  const fetched = new Map()
  for (const b of BASE) fetched.set(b.remote, await fetchUpstream(ref, b.remote))

  // The gate. The vendored files are a fork; when the bytes they were forked
  // from move, the deltas have to be re-applied by hand. Re-pinning anyway would
  // ship a fork of v2.22.0 wearing a v2.27.1 label.
  if (meta && !baseReviewed) {
    const moved = BASE.filter((b) => meta.base[b.remote] !== sha256(fetched.get(b.remote)))
    if (moved.length) {
      process.stderr.write(`sync-engine: the fork base moved between ${meta.tag} and ${ref} — the pin was NOT changed.\n\n`)
      for (const b of moved) {
        process.stderr.write(`  ${b.remote}  (forked into ${b.derived.map((d) => `src/vendor/${d}`).join(', ')})\n`)
      }
      process.stderr.write('\n')
      for (const b of moved) await printUpstreamDiff(meta.tag, ref, b.remote, fetched.get(b.remote))
      process.stderr.write(
        'Re-apply the ULTRAI18N deltas onto the new upstream by hand, update src/vendor/README.md if a\n' +
          `delta changed, then re-run with --base-reviewed to record the new base:\n\n` +
          `  node scripts/sync-engine.mjs --ref ${ref} --base-reviewed\n`,
      )
      process.exit(1)
    }
  }

  const base = {}
  for (const b of BASE) base[b.remote] = sha256(fetched.get(b.remote))

  // Stamps first: they are part of the vendored bytes we are about to hash.
  const from = meta?.engineVersion
  for (const rel of STAMPED) restamp(rel, version)
  setDependency(version)

  // Only stamped when the pin actually moves: re-running --ref against the tag
  // already pinned is an audit, and an audit must leave the tree clean.
  const syncedAt = meta?.tag === ref ? meta.syncedAt : new Date().toISOString()
  writeMeta({ tag: ref, engineVersion: version, syncedAt, base, vendored: hashVendored() })
  process.stdout.write(`sync-engine: pinned codeindex ${ref}${from && from !== version ? ` (was v${from})` : ''}\n`)
  process.stdout.write(`sync-engine: fork base unchanged — the ULTRAI18N deltas still apply as written\n`)
  process.stdout.write('sync-engine: run `pnpm install` to move the lockfile, then `pnpm build`\n')
}

async function fetchUpstream(ref, remote) {
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${remote}`
  const res = await fetch(url)
  if (!res.ok) fail(`${url} -> HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// Show what moved, not just that something did. The reviewer's next action is
// re-applying deltas onto this diff, so print it rather than a hash pair.
async function printUpstreamDiff(oldRef, newRef, remote, newBuf) {
  const dir = mkdtempSync(join(tmpdir(), 'ultrai18n-repin-'))
  try {
    // Written under <tmp>/<ref>/<remote> and diffed from <tmp>, so the headers
    // read `a/v2.22.0/src/walk.ts` instead of a pair of mktemp paths.
    const rel = (ref) => join(ref, remote)
    for (const [ref, buf] of [
      [oldRef, await fetchUpstream(oldRef, remote)],
      [newRef, newBuf],
    ]) {
      mkdirSync(join(dir, ref, dirname(remote)), { recursive: true })
      writeFileSync(join(dir, rel(ref)), buf)
    }
    const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--', rel(oldRef), rel(newRef)], { cwd: dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    process.stderr.write(`${r.stdout || `  (git diff unavailable: ${r.stderr.trim() || 'not found'})`}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function restamp(rel, version) {
  const abs = join(root, rel)
  const before = read(abs)
  if (!before.match(SEMVER)) fail(`${rel} carries no codeindex version stamp to update`)
  const after = before.replace(SEMVER, `v${version}`)
  if (after !== before) {
    writeFileSync(abs, after)
    process.stdout.write(`sync-engine: ${rel} -> v${version}\n`)
  }
}

// Rewritten as text, not via JSON.stringify: package.json is hand-maintained and
// a reformat would bury the one-line change this makes in a whole-file diff.
function setDependency(version) {
  const abs = join(root, 'package.json')
  const before = read(abs)
  const re = new RegExp(`("${PKG.replace('/', '\\/')}"\\s*:\\s*")[^"]+(")`)
  if (!re.test(before)) fail(`package.json has no ${PKG} dependency to pin`)
  const after = before.replace(re, `$1${version}$2`)
  if (after !== before) {
    writeFileSync(abs, after)
    process.stdout.write(`sync-engine: package.json ${PKG} -> ${version}\n`)
  }
}

// ---------------------------------------------------------------------------

function hashVendored() {
  const out = {}
  for (const f of VENDORED) out[f] = sha256(readFileSync(join(vendorDir, f)))
  return out
}

function readMeta({ optional = false } = {}) {
  let meta
  try {
    meta = JSON.parse(read(metaPath))
  } catch {
    if (optional) return null
    fail('no src/vendor/engine.meta.json — run `node scripts/sync-engine.mjs --ref <tag>` first')
  }
  for (const key of ['tag', 'engineVersion', 'base', 'vendored']) {
    if (!meta[key]) fail(`src/vendor/engine.meta.json is missing "${key}"`)
  }
  return meta
}

function writeMeta({ tag, engineVersion, syncedAt, base, vendored }) {
  writeFileSync(metaPath, `${JSON.stringify({ tag, engineVersion, syncedAt, base, vendored }, null, 2)}\n`)
}
