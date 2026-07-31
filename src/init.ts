// init: turn a one-off pass into a standing guard.
//
// The problem this addresses is that the problem comes back. A repository can
// be swapped cleanly today and take a new hardcoded French string in three
// weeks, and nothing about the original pass prevents that.
//
// A baseline is what makes the guard usable. Failing on every pre-existing
// finding would mean failing on day one for reasons nobody intends to fix, so
// today's state is frozen and only what is NEW blocks a pull request.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CheckReport } from './check'
import { fingerprint } from './check'

export interface Baseline {
  schemaVersion: 1
  from: string | null
  to: string
  /** Fingerprints of findings accepted as the starting point. */
  accepted: string[]
}

export function buildBaseline(report: CheckReport): Baseline {
  const accepted = report.gates
    .flatMap((gate) => gate.findings.map((f) => fingerprint(gate.id, f)))
    .sort()
  return { schemaVersion: 1, from: report.from, to: report.to, accepted }
}

export function loadBaseline(baseline: Baseline): Set<string> {
  return new Set(baseline.accepted)
}

export interface InitOptions {
  repo: string
  out: string
  ci?: boolean
  hook?: boolean
  baseline?: CheckReport
}

export interface InitResult {
  written: string[]
  notes: string[]
}

export function init(opts: InitOptions): InitResult {
  const written: string[] = []
  const notes: string[] = []

  if (opts.baseline) {
    const path = join(opts.out, 'baseline.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(buildBaseline(opts.baseline), null, 2) + '\n')
    written.push(path)
    notes.push(
      `froze ${opts.baseline.gates.reduce((n, g) => n + g.count, 0)} existing finding(s) — from here only new ones block`,
    )
  }

  if (opts.ci) {
    const path = join(opts.repo, '.github/workflows/ultrai18n.yml')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, WORKFLOW)
    written.push(path)
  }

  if (opts.hook) {
    const path = join(opts.repo, '.git/hooks/pre-commit')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, HOOK, { mode: 0o755 })
    written.push(path)
    notes.push('a local hook is bypassable and does not see other people\'s commits; --ci is the durable guard')
  }

  return { written, notes }
}

const WORKFLOW = `name: ultrai18n

on:
  pull_request:
  push:
    branches: [main]

jobs:
  language:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # The census denominator is \`git ls-files\`, so the checkout has to be real.
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install ultrai18n
        run: npx -y skills add maxgfr/ultrai18n

      - name: Inventory every human-readable string
        run: node .agents/skills/ultrai18n/scripts/ultrai18n.mjs scan --repo .

      # Fails on anything NOT in the frozen baseline: a new hardcoded string in
      # the old language, a locale marker left behind, a placeholder dropped.
      - name: Check
        run: node .agents/skills/ultrai18n/scripts/ultrai18n.mjs check --repo .
`

const HOOK = `#!/bin/sh
# Installed by \`ultrai18n init --hook\`.
#
# Only new findings block: the baseline in .ultrai18n/baseline.json holds what
# was already there when the guard went up.
set -e
ENGINE=.agents/skills/ultrai18n/scripts/ultrai18n.mjs
[ -f "$ENGINE" ] || exit 0
node "$ENGINE" scan --repo . >/dev/null
node "$ENGINE" check --repo . || {
  echo
  echo "ultrai18n: commit blocked. Fix the findings above, or record a justified"
  echo "exception in .ultrai18n/exceptions.json, or re-baseline with:"
  echo "  node $ENGINE init --baseline"
  exit 1
}
`
