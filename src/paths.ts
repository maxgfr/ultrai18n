// File and directory names as a text surface.
//
// Found by accident and worth its own module: in the reference repository the
// translation commit renamed `docs/images/reglages.png` to `settings.png` and
// `timer-clair.png` to `timer-light.png`. The FILENAME was in the source
// language, and a tool that treats every path as an untouchable slug reports
// that repository as clean.
//
// A path is genuinely dual-use. It is an identifier — referenced from markdown,
// from an import, from a script constant, possibly indexed by a search engine —
// and it is also text somebody wrote in a language. So this reports and never
// renames: a rename that misses one referrer is a broken build or a dead link,
// and no static tool can be sure it found the last referrer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Site } from './types'
import { detect, pathWordLanguage, type Lang } from './lang/detect'
import { siteId, anchor, contentHash, dupKey } from './identity'

export interface PathFinding {
  path: string
  /** The segment that reads as source-language text. */
  segment: string
  language: string
  confidence: number
  /** Every place in the repository that names this path. */
  referrers: { file: string; line: number }[]
}

export interface PathScanOptions {
  repo: string
  /** Tracked paths, from the census denominator. */
  files: string[]
  from: string
  to: string
  /** Identifiers the repository declares, so a code-shaped segment is not prose. */
  identifiers: Set<string>
}

const IGNORED_SEGMENTS = new Set([
  'src', 'lib', 'dist', 'test', 'tests', 'docs', 'doc', 'assets', 'public', 'static',
  'index', 'main', 'app', 'types', 'utils', 'config', 'scripts', 'e2e', 'images', 'img',
  'components', 'features', 'pages', 'styles', 'hooks', 'api', 'server', 'client',
])

export function scanPaths(opts: PathScanOptions): PathFinding[] {
  const findings: PathFinding[] = []
  const seen = new Set<string>()

  for (const file of opts.files) {
    for (const segment of segmentsOf(file)) {
      if (seen.has(`${file}\0${segment}`)) continue
      const words = splitWords(segment)
      if (words.length === 0) continue
      if (words.every((w) => IGNORED_SEGMENTS.has(w) || opts.identifiers.has(w))) continue

      // A single short word is not enough to call. `reglages` is; `img` is not.
      const probe = words.join(' ')
      if (probe.replace(/\s/g, '').length < 5) continue

      // Statistics are the wrong tool at this length, so the filename
      // vocabulary is consulted first and the general detector second.
      const named = words.map(pathWordLanguage).find((l) => l === opts.from)
      const guess = detect(probe, { candidates: [opts.from, opts.to] as Lang[] })
      const language = named ?? (guess.detected === opts.from && guess.confidence >= 0.6 ? guess.detected : null)
      if (!language) continue

      seen.add(`${file}\0${segment}`)
      findings.push({
        path: file,
        segment,
        language,
        confidence: named ? 0.85 : guess.confidence,
        referrers: findReferrers(opts.repo, opts.files, file),
      })
    }
  }
  return findings.sort((a, b) => (a.path < b.path ? -1 : 1))
}

function segmentsOf(file: string): string[] {
  const parts = file.split('/')
  const last = parts.pop() ?? ''
  const base = last.replace(/\.[^.]+$/, '')
  return [...parts, base].filter(Boolean)
}

function splitWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => /^\p{L}{2,}$/u.test(w))
}

/**
 * Everywhere in the repository that names this path.
 *
 * The referrer list is the actionable part of the finding. It is also the
 * reason the tool does not rename: it can show what it found, but it cannot
 * prove it found everything — a path can be assembled at runtime, and a
 * rename that misses one referrer is a 404 nobody notices until later.
 */
function findReferrers(repo: string, files: string[], target: string): { file: string; line: number }[] {
  const base = target.split('/').pop() ?? target
  const out: { file: string; line: number }[] = []
  for (const file of files) {
    if (file === target) continue
    if (!/\.(md|mdx|html?|[cm]?[jt]sx?|json|ya?ml|css|txt)$/.test(file)) continue
    let text: string
    try {
      text = readFileSync(join(repo, file), 'utf8')
    } catch {
      continue
    }
    if (!text.includes(base)) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(base)) out.push({ file, line: i + 1 })
      if (out.length >= 20) return out
    }
  }
  return out
}

/**
 * Turn a path finding into an inventory site.
 *
 * The verdict is `needs-judgment`, never `translate`. Renaming a path is a
 * decision with consequences the engine cannot see, so it hands over the
 * evidence and stops.
 */
export function pathSites(findings: PathFinding[], targetLanguage: string): Site[] {
  return findings.map((f) => {
    const siteKey = anchor(f.path, `~path/${f.segment}`)
    return {
      id: siteId(siteKey),
      siteKey,
      contentHash: contentHash(f.segment),
      dupKey: dupKey(f.segment),
      file: f.path,
      line: 0,
      col: 0,
      endLine: 0,
      endCol: 0,
      span: { start: 0, end: 0 },
      valueSpan: { start: 0, end: 0 },
      raw: f.path,
      value: f.segment,
      quote: null,
      escapes: false,
      asciiOnlyFile: true,
      holes: [],
      kind: 'key' as const,
      surface: 'token.url-slug' as const,
      verdict: 'needs-judgment' as const,
      reason: 'dual-use' as const,
      decidedBy: 'engine' as const,
      confidence: 'medium' as const,
      rule: 'path.segment',
      hard: false,
      extractor: 'paths',
      tier: 'structural' as const,
      degraded: false,
      lang: {
        detected: f.language,
        confidence: f.confidence,
        method: 'combined' as const,
        signals: [`path segment reads as ${f.language}`],
        alternatives: [],
        letters: f.segment.length,
        bucket: 'medium' as const,
        mixed: false,
        inheritedFrom: null,
      },
      flags: ['path-segment', ...(f.referrers.length ? ['has-referrers'] : [])],
      constraints: { maxLength: null, mustKeepHoles: [] },
      evidence: {
        nearestComment: `renaming this path means updating ${f.referrers.length} referrer(s); the engine reports and never renames, because it cannot prove it found the last one`,
        siblingKeys: [],
        enumOrigins: f.referrers.map((r) => `${r.file}:${r.line}`),
      },
      links: {
        duplicateOf: null,
        producedBy: null,
        pairedTests: [],
        mirrors: [],
        resolvedFrom: null,
        parentSiteId: null,
      },
    } satisfies Site
  })
}

export function formatPaths(findings: PathFinding[], from: string): string {
  if (findings.length === 0) return ''
  const lines = [
    `PATH SEGMENTS IN ${from.toUpperCase()} (${findings.length}) — reported, never renamed`,
  ]
  for (const f of findings.slice(0, 12)) {
    lines.push(
      `  ${f.path}  (${f.segment})  ${f.referrers.length} referrer(s)` +
        (f.referrers.length ? `: ${f.referrers.slice(0, 3).map((r) => `${r.file}:${r.line}`).join(', ')}` : ''),
    )
  }
  return lines.join('\n')
}
