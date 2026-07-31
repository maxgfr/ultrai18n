// Site identity: three keys with three different jobs.
//
// Conflating them is the classic mistake in this kind of tool. An identity
// derived from the text cannot survive translating the text — which is the one
// operation the tool performs. An identity derived from the line number cannot
// survive an edit above it. So the durable identity is structural, and the
// content hash exists only to answer "has this changed since it was judged".
import { createHash } from 'node:crypto'

/** Stable, citable site id. Short enough to appear in prose and batch files. */
export function siteId(siteKey: string): string {
  return 'ul_' + sha1(siteKey).slice(0, 12)
}

export function sha1(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex')
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Answers "is this still the text that was adjudicated?" */
export function contentHash(value: string): string {
  return sha1(value.normalize('NFC')).slice(0, 8)
}

/**
 * Groups the same copy appearing at several sites.
 *
 * Case is deliberately PRESERVED. In basilico, `format.ts` reads
 * `focus: 'Focus'` — the key is a persisted enum value and the value is a
 * display label, one token apart. Case-folding merges them, and merging them
 * means one translation for both, which corrupts stored user data.
 */
export function dupKey(value: string): string {
  return sha1(normalizeForGrouping(value)).slice(0, 6)
}

export function normalizeForGrouping(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Anchor paths
// ---------------------------------------------------------------------------

/**
 * Build a siteKey from a file and a structural path.
 *
 * The path grammar is per-extractor but shares three rules:
 *   1. inside a function body, index by STATEMENT ORDINAL, never by line;
 *   2. repeated siblings collapse to `[*]`, disambiguated with `~n` only on
 *      collision, so adding a list item does not renumber its neighbours;
 *   3. the value never appears — see the module comment.
 *
 * Examples:
 *   package.json#/description
 *   apps/web/vite.config.ts#default/plugins[2]/VitePWA(0)/manifest/description
 *   apps/web/.../TaskList.tsx#TaskList/ul/li[*]/button[2]@aria-label
 *   CONTRIBUTING.md#h2[3]/p[2]/text[1]
 */
export function anchor(file: string, path: string): string {
  return `${file}#${path}`
}

/** JSON Pointer (RFC 6901) segment escaping. */
export function pointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

export function pointer(segments: (string | number)[]): string {
  if (segments.length === 0) return ''
  return '/' + segments.map((s) => (typeof s === 'number' ? String(s) : pointerSegment(s))).join('/')
}

/**
 * Disambiguate keys that collide within one file.
 *
 * Two sites legitimately sharing an anchor means the anchor grammar is too
 * coarse for that construct. Rather than silently letting one shadow the other
 * — which loses a site, the one failure mode this tool must not have — the
 * later ones get a `~n` suffix and the collision is reported.
 */
export function disambiguate(keys: string[]): string[] {
  const seen = new Map<string, number>()
  return keys.map((k) => {
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return n === 0 ? k : `${k}~${n + 1}`
  })
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type MatchTier = 'same' | 'moved' | 'renumbered' | 'added' | 'removed'

export interface ReconcileInput {
  siteKey: string
  file: string
  surface: string
  contentHash: string
  dupKey: string
}

export interface Match<T extends ReconcileInput> {
  tier: MatchTier
  previous: T | null
  current: T | null
}

/**
 * Match a previous scan's sites against a current scan's.
 *
 * Four tiers, tried in order. Anything matched below tier 1 is a MIGRATION:
 * an exception or an adjudication that was pinned to the old key still applies,
 * but the fact that it had to move is reported rather than absorbed. A silent
 * re-anchor is how a stale exception ends up laundering a site nobody looked at.
 */
export function reconcile<T extends ReconcileInput>(previous: T[], current: T[]): Match<T>[] {
  const out: Match<T>[] = []
  const unmatchedPrev = new Map(previous.map((p) => [p.siteKey, p]))
  const takenPrev = new Set<string>()

  const remainingCurrent: T[] = []

  // Tier 1 — exact structural identity.
  for (const cur of current) {
    const prev = unmatchedPrev.get(cur.siteKey)
    if (prev && !takenPrev.has(prev.siteKey)) {
      takenPrev.add(prev.siteKey)
      out.push({ tier: 'same', previous: prev, current: cur })
    } else {
      remainingCurrent.push(cur)
    }
  }

  const leftoverPrev = previous.filter((p) => !takenPrev.has(p.siteKey))

  // Tier 2 — same file, same surface, same content: the anchor changed but the
  // text did not. Typical cause: a wrapper element added around it.
  const byContent = index(leftoverPrev, (p) => `${p.file}\0${p.surface}\0${p.contentHash}`)
  const afterTier2: T[] = []
  for (const cur of remainingCurrent) {
    const key = `${cur.file}\0${cur.surface}\0${cur.contentHash}`
    const candidates = byContent.get(key)
    const prev = candidates?.find((p) => !takenPrev.has(p.siteKey))
    if (prev) {
      takenPrev.add(prev.siteKey)
      out.push({ tier: 'moved', previous: prev, current: cur })
    } else {
      afterTier2.push(cur)
    }
  }

  // Tier 3 — same file, same surface, same normalized text, and the ordinals in
  // the anchor moved by no more than 3. Bounded on purpose: an unbounded match
  // on dupKey alone would happily pair the first and the fortieth list item.
  const byDup = index(
    previous.filter((p) => !takenPrev.has(p.siteKey)),
    (p) => `${p.file}\0${p.surface}\0${p.dupKey}`,
  )
  for (const cur of afterTier2) {
    const key = `${cur.file}\0${cur.surface}\0${cur.dupKey}`
    const prev = byDup
      .get(key)
      ?.find((p) => !takenPrev.has(p.siteKey) && ordinalDistance(p.siteKey, cur.siteKey) <= 3)
    if (prev) {
      takenPrev.add(prev.siteKey)
      out.push({ tier: 'renumbered', previous: prev, current: cur })
    } else {
      out.push({ tier: 'added', previous: null, current: cur })
    }
  }

  for (const prev of previous) {
    if (!takenPrev.has(prev.siteKey)) out.push({ tier: 'removed', previous: prev, current: null })
  }

  return out
}

function index<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const list = m.get(k)
    if (list) list.push(it)
    else m.set(k, [it])
  }
  return m
}

/**
 * How far two anchors are apart in ordinal space.
 *
 * Compares the bracketed and parenthesised indices in order. Anchors whose
 * non-numeric structure differs are infinitely far apart — they are different
 * places that happen to hold the same words, not the same place renumbered.
 */
export function ordinalDistance(a: string, b: string): number {
  const shapeA = a.replace(/\d+/g, '#')
  const shapeB = b.replace(/\d+/g, '#')
  if (shapeA !== shapeB) return Infinity
  const numsA = (a.match(/\d+/g) ?? []).map(Number)
  const numsB = (b.match(/\d+/g) ?? []).map(Number)
  if (numsA.length !== numsB.length) return Infinity
  let worst = 0
  for (let i = 0; i < numsA.length; i++) {
    worst = Math.max(worst, Math.abs(numsA[i]! - numsB[i]!))
  }
  return worst
}
