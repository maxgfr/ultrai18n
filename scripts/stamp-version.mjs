#!/usr/bin/env node
// Keep three version strings in lockstep: package.json, the engine's VERSION
// constant, and SKILL.md's metadata.version. A drift between them makes bug
// reports unactionable, so semantic-release stamps all three from one source.
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`stamp-version: expected a semver argument, got ${JSON.stringify(process.argv[2])}`)
  process.exit(1)
}

const edits = [
  {
    file: 'src/version.ts',
    re: /^export const VERSION = '.*'$/m,
    to: `export const VERSION = '${version}'`,
  },
  {
    file: 'skills/ultrai18n/SKILL.md',
    re: /^ {2}version: .*$/m,
    to: `  version: ${version}`,
  },
]

for (const { file, re, to } of edits) {
  const before = readFileSync(file, 'utf8')
  if (!re.test(before)) {
    console.error(`stamp-version: no version line matching ${re} in ${file}`)
    process.exit(1)
  }
  writeFileSync(file, before.replace(re, to))
  console.log(`stamp-version: ${file} -> ${version}`)
}
