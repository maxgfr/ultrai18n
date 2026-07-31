// Validators, run before anything touches disk.
//
// V1 is the one that earns the "100% accuracy" framing, and it is worth being
// precise about what it proves. It proves a placeholder SURVIVED — that the
// translation carries exactly the same set of holes as its source, none
// dropped, none duplicated, none invented. It does not prove the translation is
// correct; nothing mechanical can. Conflating those two is how a tool claims
// more than it delivers.
//
// Failure is per item, never per batch: one bad translation out of eight must
// not discard seven good ones.
import type { Group } from './plan'
import { isCognate } from './lang/detect'

export type ValidatorId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V8' | 'V9'

export interface Violation {
  validator: ValidatorId
  message: string
  /** A warning is reported and kept; a rejection is re-queued for repair. */
  severity: 'reject' | 'warn'
}

export interface ValidateOptions {
  /** Terms the user pinned: present in the source, required in the target. */
  glossary?: Map<string, { text: string; pin: boolean }>
}

const HOLE = /\{(\d+)\}/g

export function validate(group: Group, translation: string, opts: ValidateOptions = {}): Violation[] {
  const out: Violation[] = []
  const source = group.text

  // V1 — placeholder multiset equality. The hard gate.
  const want = holeCounts(source)
  const got = holeCounts(translation)
  for (const [index, n] of want) {
    const have = got.get(index) ?? 0
    if (have === 0) {
      out.push({ validator: 'V1', severity: 'reject', message: `placeholder {${index}} was dropped` })
    } else if (have !== n) {
      out.push({
        validator: 'V1',
        severity: 'reject',
        message: `placeholder {${index}} appears ${have} time(s), source has ${n}`,
      })
    }
  }
  for (const [index] of got) {
    if (!want.has(index)) {
      out.push({ validator: 'V1', severity: 'reject', message: `placeholder {${index}} was invented` })
    }
  }

  // V2 — brace structure, measured against the SOURCE.
  //
  // The point is still `{O}` with a letter O, which is the classic near-miss
  // and renders literally. But "any brace left over is a reject" was the wrong
  // way to catch it: an ICU message is nothing but braces, and so is a bundle
  // string carrying `{{count}}`. Every one of them was rejected outright, which
  // meant no repository using ICU could ship a translation through this tool at
  // all. Comparing the brace skeleton instead catches the typo — `{0}` is a
  // hole and `{O}` is not, so the skeletons differ — and leaves correct syntax
  // alone.
  const wantBraces = braceSkeleton(source)
  const gotBraces = braceSkeleton(translation)
  if (wantBraces !== gotBraces) {
    out.push({
      validator: 'V2',
      severity: 'reject',
      message:
        `brace structure changed: the source has ${wantBraces.length || 'none'}` +
        `${wantBraces ? ` (${wantBraces})` : ''} and the translation has ${gotBraces.length || 'none'}` +
        `${gotBraces ? ` (${gotBraces})` : ''}`,
    })
  }

  // V3 — host syntax leaking out of the model. A translator that emits `${x}`
  // or a backtick has started writing code.
  for (const [pattern, what] of [
    [/\$\{/, 'a JavaScript interpolation'],
    [/`/, 'a backtick'],
    [/\{\{/, 'a template interpolation'],
    [/<%/, 'a template tag'],
  ] as const) {
    if (pattern.test(translation) && !pattern.test(source)) {
      out.push({ validator: 'V3', severity: 'reject', message: `the translation introduced ${what}` })
    }
  }

  // V4 — identical to the source. This must NOT cry wolf: "Notifications" is
  // the correct French for "Notifications", and a validator that flags every
  // cognate is one users learn to ignore, which costs more than it saves. So it
  // warns, never rejects, and stays silent on cognates and wordless strings.
  if (translation === source && /\p{L}{2,}/u.test(source)) {
    const pinned = opts.glossary?.get(source)?.pin === true
    if (!pinned && !isCognate(source) && !isMostlyPlaceholders(source)) {
      out.push({
        validator: 'V4',
        severity: 'warn',
        message: 'the translation is identical to the source — correct for a cognate or a product name, suspect otherwise',
      })
    }
  }

  // V5 — length. A French button label that overflows its container is a
  // visible regression the translator cannot see.
  if (group.max !== null && translation.length > group.max) {
    out.push({
      validator: 'V5',
      severity: 'reject',
      message: `${translation.length} characters exceeds the ${group.max} available for a ${group.role}`,
    })
  }

  // V6 — control characters and whitespace the source did not have.
  if (/\n/.test(translation) && !/\n/.test(source)) {
    out.push({ validator: 'V6', severity: 'reject', message: 'the translation added a line break' })
  }
  if (translation !== translation.trim() && source === source.trim()) {
    out.push({ validator: 'V6', severity: 'warn', message: 'the translation has leading or trailing whitespace' })
  }
  if (translation.trim() === '' && source.trim() !== '') {
    out.push({ validator: 'V6', severity: 'reject', message: 'the translation is empty' })
  }

  // V8 — pinned glossary terms present in the source must appear in the target.
  for (const [term, entry] of opts.glossary ?? []) {
    if (!entry.pin) continue
    if (!containsWord(source, term)) continue
    if (!translation.includes(entry.text)) {
      out.push({
        validator: 'V8',
        severity: 'reject',
        message: `the pinned term ${JSON.stringify(term)} must appear as ${JSON.stringify(entry.text)}`,
      })
    }
  }

  return out
}

/**
 * The braces a text has once its ordinal placeholders are removed.
 *
 * `Move {0} up` → `` (the hole is not structure). `{{count}} items` → `{{}}`.
 * `{n, plural, one {#} other {#}}` → `{{}{}}`. Two texts with the same
 * skeleton have the same syntax, whatever their words.
 */
export function braceSkeleton(text: string): string {
  return text.replace(HOLE, '').replace(/[^{}]/g, '')
}

function holeCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of text.matchAll(HOLE)) {
    const key = m[1]!
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function isMostlyPlaceholders(text: string): boolean {
  return text.replace(HOLE, '').trim().length < 3
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\P{L})${escaped}(\\P{L}|$)`, 'iu').test(haystack)
}

export function rejects(violations: Violation[]): boolean {
  return violations.some((v) => v.severity === 'reject')
}

// ---------------------------------------------------------------------------
// Plurals
// ---------------------------------------------------------------------------

/**
 * V9 — a plural answer has to have exactly the forms the target locale uses.
 *
 * Both directions are failures and only one of them is obvious. A MISSING form
 * is a string the runtime cannot find, so it falls back — usually to the key
 * itself, in front of a user. An EXTRA form is quieter and just as wrong: a
 * `few` key in an English bundle is dead weight the runtime will never select,
 * and it reads to the next person as though English had a `few` form.
 *
 * The placeholder rule is deliberately one-sided. A target form may legitimately
 * drop the number — English writes "One item", not "1 item" — so a form
 * carrying FEWER placeholders than the source is fine. Inventing one that
 * appears in no source form is not: nothing will substitute it and it renders
 * raw.
 */
export function validatePlural(
  forms: Record<string, string>,
  expected: readonly string[],
  sourcePlaceholders: readonly string[],
): Violation[] {
  const out: Violation[] = []
  const got = Object.keys(forms)

  for (const category of expected) {
    if (forms[category] === undefined) {
      out.push({
        validator: 'V9',
        severity: 'reject',
        message: `the ${category} form is missing, and the target locale selects it`,
      })
    } else if (!forms[category]!.trim()) {
      out.push({ validator: 'V9', severity: 'reject', message: `the ${category} form is empty` })
    }
  }
  for (const category of got) {
    if (category.startsWith('=')) continue
    if (!expected.includes(category)) {
      out.push({
        validator: 'V9',
        severity: 'reject',
        message: `there is a ${category} form, and the target locale never selects it`,
      })
    }
  }

  const allowed = new Set(sourcePlaceholders)
  for (const [category, text] of Object.entries(forms)) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      if (!allowed.has(m[0])) {
        out.push({
          validator: 'V9',
          severity: 'reject',
          message: `the ${category} form introduced ${m[0]}, which no source form has — nothing will substitute it`,
        })
      }
    }
    for (const [pattern, what] of [
      [/\$\{/, 'a JavaScript interpolation'],
      [/`/, 'a backtick'],
    ] as const) {
      if (pattern.test(text)) {
        out.push({ validator: 'V3', severity: 'reject', message: `the ${category} form introduced ${what}` })
      }
    }
  }

  return out
}

const PLACEHOLDER = /\{\{\s*[\w.]+\s*\}\}|\{\d+\}|\{[\w.]+\}|%\{[\w.]+\}|%\d*\$?[sd@]|#/g
