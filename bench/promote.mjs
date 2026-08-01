#!/usr/bin/env node
// Turn a confirmed miss from the wild into a corpus case somebody has to
// explain.
//
// A confirmed miss is the strongest thing the sweep says: the file's extractor
// asserted it accounted for every byte, and a human-looking line no site
// covered contradicts that. Losing one to a nightly log is how a real finding
// becomes folklore, so this promotes it into `bench/corpus/` — with its
// provenance, and with a `why` that starts `TODO:` so `pnpm bench --ci` stays
// red until somebody writes down what it proves.
//
// It never clones and never re-sweeps. Promotion is curation over a report a
// human has just read, and keeping the network out of it keeps it out of the
// nightly's failure modes too.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Licences whose code may be excerpted into an MIT repository with attribution.
 *
 * Anything else — INCLUDING an unrecognised or missing string — takes the
 * refusal branch. A licence this script does not know is not a licence it may
 * copy under, so it fails closed. `MPL-2.0` is deliberately absent: it is
 * file-level copyleft, and this would be copying a file.
 */
const PERMISSIVE = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|Unlicense|Zlib)\b/

const CONTEXT_LINES = 15
const MAX_LINES = 30
const MAX_BYTES = 4096

export class PromoteError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

/**
 * `<slug>:<n>` or `<slug>:<file>:<line>`.
 *
 * The second form is the durable one — it survives a re-sweep, where an index
 * does not — so it is the one the report tells people to use.
 */
export function parseSelector(spec) {
  const parts = spec.split(':')
  if (parts.length < 2) throw new PromoteError(`--promote ${spec} is not <slug>:<n> or <slug>:<file>:<line>`, 2)
  if (parts.length === 2) {
    const [slug, n] = parts
    if (!/^\d+$/.test(n)) throw new PromoteError(`--promote ${spec}: ${n} is not an index`, 2)
    return { slug, index: Number(n) }
  }
  const line = parts[parts.length - 1]
  if (!/^\d+$/.test(line)) throw new PromoteError(`--promote ${spec}: ${line} is not a line number`, 2)
  return { slug: parts[0], file: parts.slice(1, -1).join(':'), line: Number(line) }
}

export function promote({ findings, repos, selector, root, cloneDir, write = true }) {
  const sel = parseSelector(selector)
  const repo = (repos.repos ?? []).find((r) => r.slug === sel.slug)
  if (!repo) throw new PromoteError(`no pinned repository named ${sel.slug}`, 2)

  const result = (findings ?? []).find((f) => f.slug === sel.slug)
  if (!result) {
    throw new PromoteError(`${sel.slug} has no findings — run \`pnpm sweep --only ${sel.slug}\` first`, 1)
  }

  const misses = result.confirmedMisses ?? []
  const miss =
    sel.index !== undefined
      ? misses.find((m) => m.id === sel.index)
      : misses.find((m) => m.file === sel.file && m.line === sel.line)
  if (!miss) {
    throw new PromoteError(
      `${selector}: no confirmed miss there. This repository has ${misses.length}` +
        (misses.length ? `: ${misses.slice(0, 5).map((m) => `[${m.id}] ${m.file}:${m.line}`).join(', ')}` : ''),
      2,
    )
  }

  const name = `sweep-${sel.slug.replace(/\//g, '-')}-${miss.locator}`
  const permissive = PERMISSIVE.test(String(repo.license ?? ''))

  return permissive
    ? promoteExcerpt({ repo, miss, name, root, cloneDir, write })
    : promoteReproduce({ repo, miss, name, root, write })
}

// ---------------------------------------------------------------------------

function promoteExcerpt({ repo, miss, name, root, cloneDir, write }) {
  const dir = join(root, 'bench', 'corpus', name)
  if (existsSync(dir)) throw new PromoteError(`${dir} already exists — a case is never overwritten`, 1)

  const abs = join(cloneDir, repo.slug.replace('/', '__'), miss.file)
  if (!existsSync(abs)) throw new PromoteError(`${abs} is not in the clone — re-run the sweep`, 1)

  const lines = readFileSync(abs, 'utf8').split('\n')
  const from = Math.max(0, miss.line - 1 - CONTEXT_LINES)
  const to = Math.min(lines.length, from + MAX_LINES)
  let excerpt = lines.slice(from, to).join('\n')
  if (Buffer.byteLength(excerpt) > MAX_BYTES) excerpt = excerpt.slice(0, MAX_BYTES)

  const basename = miss.file.split('/').pop()
  const text = String(miss.text ?? '').trim()
  if (!text) throw new PromoteError(`${miss.file}:${miss.line} has no text to key an expectation on`, 1)
  // `locate()` requires an occurrence when the text appears more than once, or
  // the case is malformed on its very first run.
  const occurrences = excerpt.split(text).length - 1

  const expected = {
    schemaVersion: 1,
    case: name,
    title: 'TODO: what this case proves',
    expectations: [
      {
        id: 'promoted-1',
        file: basename,
        find: text,
        ...(occurrences > 1 ? { occurrence: 1 } : {}),
        // No `expect` block, deliberately. The observed verdict is what the
        // engine does TODAY and that is the behaviour under suspicion; writing
        // it in would pin the bug. With no covering site the case fails on
        // accountingCoverage, which is the correct red.
        why:
          `TODO: promoted from ${repo.slug}@${repo.sha} ${miss.file}:${miss.line} by locator ` +
          `${miss.locator}. Say what this proves, or delete the case.`,
      },
    ],
  }

  const provenance = [
    `# Provenance`,
    ``,
    `| | |`,
    `|---|---|`,
    `| source | \`${repo.slug}\` — ${repo.url} |`,
    `| commit | \`${repo.sha}\` |`,
    `| path | \`${miss.file}\` |`,
    `| line | ${miss.line} |`,
    `| licence | ${repo.license} |`,
    `| locator | \`${miss.locator}\` |`,
    `| claimRatio at promotion | ${miss.claimRatio} |`,
    `| extractor at promotion | ${miss.extractor} |`,
    ``,
    `## Why an excerpt is permitted`,
    ``,
    `\`${repo.license}\` is permissive, so ${MAX_LINES} lines with attribution is fine. A copyleft`,
    `source takes the other branch and gets a \`REPRODUCE.md\` instead: reading one to`,
    `measure is fine, vendoring it into an MIT repository is not a licensing question`,
    `this benchmark gets to answer.`,
    ``,
    `## What this case must NOT do`,
    ``,
    `There is no \`expect\` block, and adding one before the behaviour is understood`,
    `would pin the bug rather than the finding. The case is red on`,
    `\`accountingCoverage\` — no site covers the region — and that is the correct red.`,
    `Its \`why\` starts \`TODO:\`, so \`pnpm bench --ci\` stays red until somebody writes`,
    `down what it proves.`,
    ``,
  ].join('\n')

  if (write) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, basename), excerpt + '\n')
    writeFileSync(join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n')
    writeFileSync(join(dir, 'PROVENANCE.md'), provenance)
  }
  return { kind: 'excerpt', dir, files: [basename, 'expected.json', 'PROVENANCE.md'], name }
}

function promoteReproduce({ repo, miss, name, root, write }) {
  // NOT under `bench/corpus/`, so `discoverCases` never picks it up.
  const dir = join(root, 'bench', 'reproduce', name)
  if (existsSync(dir)) throw new PromoteError(`${dir} already exists — nothing is overwritten`, 1)

  const body = [
    `# Reproduce: ${repo.slug} ${miss.file}:${miss.line}`,
    ``,
    `**No source was copied.** \`${repo.license ?? '(no licence recorded)'}\` is not on the permissive`,
    `allowlist, and an unrecognised licence takes this branch too — a licence this`,
    `benchmark does not know is not one it may copy under. Vendoring copyleft into an`,
    `MIT repository is not a licensing question a benchmark gets to answer.`,
    ``,
    `| | |`,
    `|---|---|`,
    `| source | \`${repo.slug}\` — ${repo.url} |`,
    `| commit | \`${repo.sha}\` |`,
    `| path | \`${miss.file}\` |`,
    `| line | ${miss.line} |`,
    `| locator | \`${miss.locator}\` |`,
    `| claimRatio at promotion | ${miss.claimRatio} |`,
    `| extractor at promotion | ${miss.extractor} |`,
    ``,
    `## See it yourself`,
    ``,
    '```sh',
    `git clone --depth 1 ${repo.url} /tmp/${name}`,
    `git -C /tmp/${name} checkout ${repo.sha}`,
    `node skills/ultrai18n/scripts/ultrai18n.mjs scan --repo /tmp/${name} --out /tmp/${name}-out --to en`,
    `sed -n '${miss.line}p' /tmp/${name}/${miss.file}`,
    '```',
    ``,
    `## Turning it into a case`,
    ``,
    `Write a CLEAN-ROOM fixture: the same construct, your own words. An excerpt`,
    `would carry the licence with it; a fixture carries only the shape, which is`,
    `the part that was interesting.`,
    ``,
  ].join('\n')

  if (write) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'REPRODUCE.md'), body)
  }
  return { kind: 'reproduce', dir, files: ['REPRODUCE.md'], name }
}
