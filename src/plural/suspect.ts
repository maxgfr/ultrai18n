// What LOOKS like a plural to something that knows no library at all.
//
// This is the piece that turns "the LLM handles plurals" from a hope into a loop
// that terminates. Without it, a dialect catalog is only ever as good as the
// arrangements somebody thought to write down, and a repository using a scheme
// nobody anticipated reports clean. With it, the engine can say: here are the
// sites that smell like a plural and that no dialect claimed — and the loop ends
// when that list is empty.
//
// It is the same argument `sweep.ts` makes one level down. The residual sweep
// says no BYTE went unaccounted for; this says no plural ARRANGEMENT did. Both
// err toward false positives on purpose, for the same reason: a false suspicion
// costs one adjudication, once, and is then excused. A false negative is the
// failure the whole tool exists to prevent.
import type { Site } from './../types'
import { CATEGORIES } from './cldr'
import { looksLikeIcu, scanIcu } from './icu'

export type SuspicionSignal =
  /** The leaf key ends in a CLDR category or a native quantity token. */
  | 'category-key'
  /** Two sibling values differing only by a short suffix, one of them counting. */
  | 'sibling-suffix-pair'
  /** A known plural delimiter, with a part that counts. */
  | 'delimited-counting'
  /** A token no arrangement uses for anything else. */
  | 'structural-marker'
  /** An ICU-looking message the parser could not read. */
  | 'broken-icu'

export interface Suspicion {
  siteId: string
  siteKey: string
  file: string
  line: number
  path: string
  value: string
  signals: SuspicionSignal[]
  /** Sibling values, because an arrangement is not recognisable from a path alone. */
  siblings: { path: string; value: string }[]
}

const NATIVE_TOKENS = [...CATEGORIES, 'singular', 'plural']
/** `[one]` is included so Android- and `.xcstrings`-shaped paths trip it too. */
const CATEGORY_KEY = new RegExp(`(?:^|[_.\\-/\\[])(${NATIVE_TOKENS.join('|')})\\]?$`)
const COUNTS = /\d|\{[^}]*\}|%[sd@]|%\{|#/
const DELIMITERS = ['||||', '|']
const STRUCTURAL_MARKER =
  /(?:^|\/)(msgid_plural|msgstr\[\d+\]|numerusform(?:\[\d+\])?|NSStringPluralRuleType|NSStringFormatValueTypeKey)(?:$|\/)|\/variations\/plural\//

/**
 * The same markers, looked for in the TEXT rather than in the path.
 *
 * A format with no extractor has no structural path at all: a `.po` file goes
 * through the residual sweep and comes back as `~sweep[3]` prose-runs. The token
 * that identifies it as a plural catalog is still right there in the bytes, and
 * looking only at paths meant the one format most worth flagging — gettext,
 * which the tool explicitly does not read — produced no suspicion whatsoever.
 *
 * No trailing `\b`: `msgstr[0] "…"` puts a space after the bracket, and a word
 * boundary between `]` and ` ` never matches. That one character was the whole
 * difference between this firing on a `.po` file and not.
 */
const MARKER_IN_TEXT =
  /(?:^|\W)(msgid_plural|msgstr\s*\[\s*\d+\s*\]|numerusform|NSStringPluralRuleType|NSStringLocalizedFormatKey)/

export function suspectPlurals(sites: Site[]): Suspicion[] {
  const byPath = new Map<string, Site[]>()
  for (const site of sites) {
    if (site.kind === 'key') continue
    const key = `${site.file}\0${parentOf(pathOf(site))}`
    const list = byPath.get(key)
    if (list) list.push(site)
    else byPath.set(key, [site])
  }

  const suspicious = new Map<string, Suspicion>()
  const note = (site: Site, signal: SuspicionSignal): void => {
    const existing = suspicious.get(site.id)
    if (existing) {
      if (!existing.signals.includes(signal)) existing.signals.push(signal)
      return
    }
    const path = pathOf(site)
    suspicious.set(site.id, {
      siteId: site.id,
      siteKey: site.siteKey,
      file: site.file,
      line: site.line,
      path,
      value: site.value,
      signals: [signal],
      siblings: (byPath.get(`${site.file}\0${parentOf(path)}`) ?? [])
        .filter((s) => s.id !== site.id)
        .slice(0, 4)
        .map((s) => ({ path: pathOf(s), value: s.value })),
    })
  }

  for (const site of sites) {
    if (site.kind === 'key') continue
    const path = pathOf(site)

    if (STRUCTURAL_MARKER.test(path) || MARKER_IN_TEXT.test(site.value)) note(site, 'structural-marker')
    if (CATEGORY_KEY.test(leafOf(path))) note(site, 'category-key')
    if (isDelimitedCounting(site.value)) note(site, 'delimited-counting')
    // An ICU message the parser cannot read is broken TODAY, with nothing
    // translated. Worth surfacing on its own account.
    if (looksLikeIcu(site.value) && !scanIcu(site.value).ok) note(site, 'broken-icu')
  }

  for (const group of byPath.values()) {
    for (const [a, b] of suffixPairs(group)) {
      note(a, 'sibling-suffix-pair')
      note(b, 'sibling-suffix-pair')
    }
  }

  return [...suspicious.values()].sort((x, y) => (x.siteKey < y.siteKey ? -1 : 1))
}

/**
 * Two siblings where one value is the other plus a short suffix, and at least
 * one of them counts.
 *
 * This is the signal that catches a scheme nobody named: `item`/`items`,
 * `Datei`/`Dateien`, `plik`/`pliki`. No library knowledge, no key convention —
 * just two strings that differ the way a singular differs from a plural.
 */
function suffixPairs(group: Site[]): [Site, Site][] {
  const out: [Site, Site][] = []
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = group[i]!
      const b = group[j]!
      const [shorter, longer] = a.value.length <= b.value.length ? [a, b] : [b, a]
      if (shorter.value.length < 3) continue
      if (!longer.value.startsWith(shorter.value)) continue
      const suffix = longer.value.slice(shorter.value.length)
      if (suffix.length === 0 || suffix.length > 3) continue
      if (!/^\p{L}+$/u.test(suffix)) continue
      if (!COUNTS.test(a.value) && !COUNTS.test(b.value)) continue
      out.push([a, b])
    }
  }
  return out
}

function isDelimitedCounting(value: string): boolean {
  const delimiter = DELIMITERS.find((d) => value.includes(d))
  if (!delimiter) return false
  const parts = value.split(delimiter).map((p) => p.trim())
  if (parts.length < 2) return false
  if (parts.some((p) => !/\p{L}{2,}/u.test(p))) return false
  return parts.some((p) => COUNTS.test(p))
}

function pathOf(site: Site): string {
  return site.siteKey.slice(site.siteKey.indexOf('#') + 1)
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

function leafOf(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * The suspicions no family claimed.
 *
 * This is the worklist, and the thing a gate can be built on: everything here is
 * a place the engine looked, saw something plural-shaped, and could not account
 * for.
 */
export function unclaimedSuspicions(suspicions: Suspicion[], claimedSiteIds: Set<string>): Suspicion[] {
  return suspicions.filter((s) => !claimedSiteIds.has(s.siteId))
}
