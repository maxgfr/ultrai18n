// The census: every tracked path, in exactly one bucket, with a reason.
//
// This is the load-bearing half of the recall claim. "We found every string" is
// unfalsifiable. "Every tracked path is accounted for, and here is why each one
// was or was not read" is a gate that fails loudly.
//
// The denominator is `git ls-files`, NOT the walker — because the walker's own
// exclusions are precisely what needs auditing. Asking the walker which files
// exist and then asking it whether it read them is a tautology.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { walk, TEXT_BEARING_BINARY_EXT, type Skipped } from './vendor/walk'
import { readTextEx } from './vendor/text'
import type { CensusEntry } from './types'

export interface CensusResult {
  /** 'git' when the denominator came from git ls-files; 'filesystem' weakens the claim. */
  source: 'git' | 'filesystem'
  entries: CensusEntry[]
  totals: {
    tracked: number
    scanned: number
    scannedZero: number
    skipped: number
    unscannable: number
    unaccounted: number
  }
  /** Tracked paths in zero buckets. Any entry here fails gate G1. */
  unaccounted: string[]
  ok: boolean
}

export function gitLsFiles(root: string): string[] | null {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 28 })
  if (r.status !== 0 || !r.stdout) return null
  const files = r.stdout.toString('utf8').split('\0').filter(Boolean).sort()
  // An empty result is not an empty repository — it is a directory whose files
  // git does not track. Using it as the denominator would report every file as
  // skipped while declaring the census complete, which is the worst of both.
  return files.length > 0 ? files : null
}

export function runCensus(root: string): CensusResult {
  const tracked = gitLsFiles(root)
  const source: 'git' | 'filesystem' = tracked ? 'git' : 'filesystem'

  const scan = walk(root)
  const walked = new Map(scan.files.map((f) => [f.rel, f]))
  const skippedByRel = new Map(scan.skipped.map((s) => [s.rel, s]))

  // Paths under a directory the walk refused to descend into are still tracked,
  // and a repo may well track `dist/` or `vendor/`. Without attributing them the
  // census reports them as unaccounted with no explanation, which is worse than
  // useless — it makes G1 fail for a reason nobody can act on.
  const skippedDirs = scan.skippedDirs

  const denominator =
    tracked ??
    [...scan.files.map((f) => f.rel), ...scan.skipped.map((s) => s.rel)].sort()

  const entries: CensusEntry[] = []
  const unaccounted: string[] = []

  for (const rel of denominator) {
    const file = walked.get(rel)
    if (file) {
      const read = readTextEx(file.abs)
      if (!read.ok) {
        entries.push({ file: rel, bucket: 'skipped', reason: 'unreadable' })
        continue
      }
      if (read.binary) {
        entries.push({
          file: rel,
          bucket: 'skipped',
          reason: 'nul-byte',
          mustVerifyManually: false,
          bytesTotal: read.bytes,
        })
        continue
      }
      // Until the extractors land, a readable file is `scanned` with an unknown
      // site count. `claimRatio` stays undefined rather than being reported as
      // 0 — claiming "0% of this file was accounted for" would be a measurement
      // we have not made.
      entries.push({
        file: rel,
        bucket: read.text.trim() === '' ? 'scanned-zero' : 'scanned',
        bytesTotal: read.bytes,
        degraded: !read.byteAddressable,
        ...(read.byteAddressable ? {} : { reason: `encoding:${read.encoding}` }),
      })
      continue
    }

    const skipped = skippedByRel.get(rel)
    if (skipped) {
      entries.push(skippedEntry(rel, skipped))
      continue
    }

    const dir = skippedDirs.find((d) => rel === d.rel || rel.startsWith(d.rel + '/'))
    if (dir) {
      entries.push({
        file: rel,
        bucket: 'skipped',
        reason: dir.reason,
        mustVerifyManually: false,
      })
      continue
    }

    // The path is tracked by git and the walk neither read it nor explained it.
    // That is exactly the class of silent miss this tool exists to prevent, so
    // it is a hard failure rather than a warning.
    unaccounted.push(rel)
    entries.push({ file: rel, bucket: 'skipped', reason: 'unaccounted' })
  }

  entries.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))

  const totals = {
    tracked: denominator.length,
    scanned: entries.filter((e) => e.bucket === 'scanned').length,
    scannedZero: entries.filter((e) => e.bucket === 'scanned-zero').length,
    skipped: entries.filter((e) => e.bucket === 'skipped').length,
    unscannable: entries.filter((e) => e.mustVerifyManually).length,
    unaccounted: unaccounted.length,
  }

  return {
    source,
    entries,
    totals,
    unaccounted,
    ok: unaccounted.length === 0 && totals.scanned + totals.scannedZero + totals.skipped === totals.tracked,
  }
}

function skippedEntry(rel: string, s: Skipped): CensusEntry {
  const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
  const textBearing = s.textBearing ?? TEXT_BEARING_BINARY_EXT.has(ext)
  return {
    file: rel,
    bucket: 'skipped',
    reason: s.reason,
    // An image or a PDF is unreadable by the engine but perfectly readable by a
    // person. Reporting it identically to a font file tells the user nothing,
    // and that is how a translated app ships with English screenshots.
    mustVerifyManually: textBearing,
    ...(s.size !== undefined ? { bytesTotal: s.size } : {}),
  }
}

export function formatCensus(r: CensusResult, root: string): string {
  const lines: string[] = []
  lines.push(
    `ultrai18n census  ${root}  (${r.source === 'git' ? 'git ls-files' : 'filesystem — weaker claim'})`,
  )
  lines.push('')
  lines.push(
    `  ${r.totals.tracked} tracked = ${r.totals.scanned} scanned + ${r.totals.scannedZero} empty + ${r.totals.skipped} skipped`,
  )

  const unscannable = r.entries.filter((e) => e.mustVerifyManually)
  if (unscannable.length) {
    lines.push('')
    lines.push(`UNSCANNABLE — carries text a person can read, but the engine cannot (${unscannable.length})`)
    for (const e of unscannable) lines.push(`  ${e.file}${e.producedBy ? `   regenerable: ${e.producedBy}` : ''}`)
  }

  if (r.unaccounted.length) {
    lines.push('')
    lines.push(`UNACCOUNTED — tracked, neither read nor explained (${r.unaccounted.length})`)
    for (const f of r.unaccounted) lines.push(`  ${f}`)
  }

  lines.push('')
  lines.push(r.ok ? 'G1 census-complete  ok' : 'G1 census-complete  FAIL')
  return lines.join('\n')
}

export { join }
