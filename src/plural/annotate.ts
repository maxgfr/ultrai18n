// The escape hatch: a plural family declared in place.
//
// Two cases need this, and neither can be inferred without guessing.
//
// The first is a rule baked into an expression. `pomodoro${n > 1 ? 's' : ''}`
// has its forms sitting right there in the ternary, and reading them off looks
// tempting — until you notice that mapping a branch to a category means knowing
// which way the condition runs, that `n !== 1`, `n > 1` and `n >= 2` disagree
// about zero, and that the answer changes per language anyway. The engine has
// always refused this and should keep refusing it. What it lacked was a way for
// someone who DOES know to say so.
//
// The second is any arrangement the shape table does not recognise. A closed
// set of shapes that cannot be extended by the person in front of it is a tool
// that works on the repositories its author happened to see.
//
// An annotation sets `decidedBy: 'inline-pragma'`, which is the provenance slot
// the inventory has always reserved: a family that came from a human or an
// agent must never be indistinguishable from one the engine derived.
import { existsSync, readFileSync } from 'node:fs'
import type { Site } from '../types'
import { isCategory, sortCategories, type Category } from './cldr'
import type { PluralForm } from './shapes'

export const PRAGMA = /(^|\s)ultrai18n:plural\b/

/**
 * How a declared family is written back.
 *
 *  - `auto` — decided by the FORMAT, not by the fact that somebody declared it.
 *    A declaration landing on a JSON or YAML scalar can be inserted; one landing
 *    inside an expression cannot.
 *  - anything else — said explicitly, and taken at its word.
 */
export type DeclaredWrite = 'auto' | 'insert' | 'replace' | 'code-edit'

export interface AnnotatedFamily {
  /** The site the annotation applies to. */
  siteKey: string
  siteId: string
  file: string
  /** The counting expression, when given. Reported, never evaluated. */
  count: string | null
  /** Default `auto`. */
  write: DeclaredWrite
  /** `insert` only: how to spell a new key. `{category}` is the form. */
  keyTemplate: string | null
  /**
   * Which form the annotated site ALREADY IS.
   *
   * Not optional in practice. If a declaration supplies `one` and `other` for a
   * site that is one JSON scalar, insertion has to know which of the two the
   * site holds in order to rewrite it in place and insert only the rest.
   */
  ownCategory: Category | null
  /**
   * Source forms, when the annotation spells them out. Empty when it only
   * declares the site a plural — then the site's own value is the single form
   * and completing the family needs a code edit.
   */
  forms: PluralForm[]
  /** Categories the author asked for, when they overrode CLDR. */
  categories: Category[] | null
  /** The comment site carrying the pragma, so it is not translated as prose. */
  pragmaSiteId: string | null
  origin: 'pragma' | 'sidecar'
}

/**
 * Read pragmas out of the comment sites already in the inventory.
 *
 * An annotation applies to the next site after it in the same file, which is
 * how every comment-based directive in every language reads. Attaching by
 * position rather than by content matters: the text is about to be translated,
 * so an annotation keyed on it would stop matching the moment it worked.
 */
export function readPragmas(sites: Site[]): AnnotatedFamily[] {
  const byFile = new Map<string, Site[]>()
  for (const site of sites) {
    const list = byFile.get(site.file)
    if (list) list.push(site)
    else byFile.set(site.file, [site])
  }

  const out: AnnotatedFamily[] = []
  for (const [file, group] of byFile) {
    const ordered = [...group].sort((a, b) => a.span.start - b.span.start)
    for (let i = 0; i < ordered.length; i++) {
      const comment = ordered[i]!
      if (comment.kind !== 'comment') continue
      if (!PRAGMA.test(comment.value)) continue

      const target = ordered.slice(i + 1).find((s) => s.kind !== 'comment' && s.kind !== 'key')
      if (!target) continue

      // No parser change is needed for the three new fields: `parseFields` has
      // always read arbitrary `k=v`, so `write=insert keyTemplate=item_{category}`
      // works the day the reader below understands it.
      const fields = parseFields(comment.value)
      out.push({
        siteKey: target.siteKey,
        siteId: target.id,
        file,
        count: fields.count ?? null,
        write: writeFrom(fields.write),
        keyTemplate: fields.keyTemplate ?? null,
        ownCategory: isCategory(fields.category ?? '') ? (fields.category as Category) : null,
        forms: formsFrom(fields, target.id),
        categories: categoriesFrom(fields.categories),
        pragmaSiteId: comment.id,
        origin: 'pragma',
      })
    }
  }
  return out
}

/**
 * The sidecar, for formats with no comments and for bulk declarations.
 *
 * Keyed on `siteKey` — structural, and therefore still valid after the text it
 * points at has been translated.
 */
export interface PluralSidecar {
  schemaVersion?: 1
  families?: {
    siteKey: string
    count?: string
    categories?: string[]
    forms?: Record<string, string>
    /** Default `auto` — decided by the format. See `DeclaredWrite`. */
    write?: DeclaredWrite
    /** `insert` only. `{category}` is the form. Derived from the siteKey if absent. */
    keyTemplate?: string
    /** Which form this site already is. Read off the path when absent. */
    category?: string
  }[]
}

export function readSidecar(path: string, sites: Site[]): AnnotatedFamily[] {
  if (!existsSync(path)) return []
  let parsed: PluralSidecar
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PluralSidecar
  } catch (err) {
    throw new Error(`${path} is not readable JSON: ${(err as Error).message}`)
  }

  const bySiteKey = new Map(sites.map((s) => [s.siteKey, s]))
  const out: AnnotatedFamily[] = []
  for (const entry of parsed.families ?? []) {
    const site = bySiteKey.get(entry.siteKey)
    // A declaration pointing at nothing is reported by the gate, not silently
    // dropped: it usually means the code moved and the annotation did not.
    if (!site) continue
    const forms: PluralForm[] = []
    for (const [selector, value] of Object.entries(entry.forms ?? {})) {
      if (!isCategory(selector)) continue
      forms.push({ category: selector, selector, siteId: site.id, value })
    }
    out.push({
      siteKey: entry.siteKey,
      siteId: site.id,
      file: site.file,
      count: entry.count ?? null,
      write: writeFrom(entry.write),
      keyTemplate: entry.keyTemplate ?? null,
      ownCategory: isCategory(entry.category ?? '') ? (entry.category as Category) : null,
      forms: sortForms(forms),
      categories: categoriesFrom(entry.categories?.join(',')),
      pragmaSiteId: null,
      origin: 'sidecar',
    })
  }
  return out
}

/** Declarations naming a site that no longer exists. Reported by the gate. */
export function danglingSidecarKeys(path: string, sites: Site[]): string[] {
  if (!existsSync(path)) return []
  let parsed: PluralSidecar
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as PluralSidecar
  } catch {
    return []
  }
  const known = new Set(sites.map((s) => s.siteKey))
  return (parsed.families ?? []).map((f) => f.siteKey).filter((k) => !known.has(k))
}

// ---------------------------------------------------------------------------

/**
 * `count=done one="1 item" other="{0} items"` → a field map.
 *
 * Values may be bare, single- or double-quoted. Nothing here is evaluated and
 * nothing is executed: an annotation is data.
 */
export function parseFields(text: string): Record<string, string> {
  const body = text.slice(text.search(PRAGMA)).replace(/^\s*/, '').replace(/^ultrai18n:plural\b/, '')
  const fields: Record<string, string> = {}
  const re = /([A-Za-z][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+))/g
  for (const m of body.matchAll(re)) {
    const raw = m[2] ?? m[3] ?? m[4] ?? ''
    fields[m[1]!] = raw.replace(/\\(["'\\])/g, '$1')
  }
  return fields
}

function formsFrom(fields: Record<string, string>, siteId: string): PluralForm[] {
  const forms: PluralForm[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (!isCategory(key)) continue
    forms.push({ category: key, selector: key, siteId, value })
  }
  return sortForms(forms)
}

const WRITE_MODES = new Set<DeclaredWrite>(['auto', 'insert', 'replace', 'code-edit'])

/** An unrecognised value falls back to `auto` rather than being obeyed blindly. */
function writeFrom(spec: string | undefined): DeclaredWrite {
  return spec && WRITE_MODES.has(spec as DeclaredWrite) ? (spec as DeclaredWrite) : 'auto'
}

function categoriesFrom(spec: string | undefined): Category[] | null {
  if (!spec) return null
  const cats = spec
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter(isCategory)
  return cats.length ? sortCategories(cats) : null
}

function sortForms(forms: PluralForm[]): PluralForm[] {
  const byCategory = new Map(forms.map((f) => [f.category, f]))
  return sortCategories(byCategory.keys()).map((c) => byCategory.get(c)!)
}
