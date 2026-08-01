// Verifying a claim that an edit was made.
//
// `adjudicate --apply` parses an adjudicator's ruling and folds it in. The
// `pluralist` and `structuralist` phases have the same shape and had no such
// path — but the gap is a DIFFERENT one and must not be fixed the same way.
//
// Those two phases WRITE FILES themselves (`PhaseStatus.writes`). Their return
// is therefore not a decision the engine has to fold in; it is a claim that an
// edit was made. Both joins already re-scan, and the re-scan was never compared
// against what the agent said it did — so an agent that reported a family it
// never touched, or touched wrongly, produced a green pipeline.
//
// So this is a VERIFIER, not a parser. It answers one question per claim: does
// the repository, read fresh, show the edit?
import type { Category } from './cldr'
import type { PluralFamily } from './index'
import type { Inventory } from '../types'

/** What the `pluralist` returns, one per family it was handed. */
export interface PluralReturn {
  familyId: string
  file?: string
  note?: string
}

export interface PluralClaim {
  familyId: string
  file: string
  ok: boolean
  /** Present when the claim failed. */
  detail?: string
  note: string
}

export interface PluralVerifyResult {
  schemaVersion: 1
  ok: boolean
  counts: { claimed: number; verified: number; failed: number; unclaimed: number }
  claims: PluralClaim[]
  /** Families the worklist handed out and nobody reported back on. */
  unclaimed: string[]
  problems: string[]
}

/** One entry of `PLURALS.todo.json`, as `commands.writeFamily` writes it. */
interface TodoFamily {
  familyId: string
  file: string
  anchor: string
  targetCategories: string[]
  forms: Record<string, string>
}

export function parsePluralReturns(raw: unknown): PluralReturn[] | null {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { returns?: unknown })?.returns)
      ? (raw as { returns: unknown[] }).returns
      : Array.isArray((raw as { families?: unknown })?.families)
        ? (raw as { families: unknown[] }).families
        : null
  if (!list) return null
  return list.map((e) => e as PluralReturn)
}

/**
 * Check each claimed family against a FRESH inventory.
 *
 * The assertion is the one the worklist made possible: the family now has every
 * form its target locale selects, and nothing its own locale requires is
 * missing.
 *
 * A code edit may legitimately DISSOLVE a family — the whole point of the phase
 * is often to replace a hand-rolled conditional with the platform's plural API,
 * and the old anchor stops existing. So a vanished id is not a failure by
 * itself: what is required is that some family in the same file now covers the
 * categories that were handed out. What IS a failure is a claim the re-scan
 * cannot see at all.
 */
export function verifyPluralReturns(opts: {
  returns: PluralReturn[]
  todo: { families: TodoFamily[] }
  inventory: Inventory
}): PluralVerifyResult {
  const problems: string[] = []
  const claims: PluralClaim[] = []

  const wanted = new Map(opts.todo.families.map((f) => [f.familyId, f]))
  const families = (opts.inventory.plurals ?? []) as PluralFamily[]
  const byId = new Map(families.map((f) => [f.id, f]))

  const seen = new Set<string>()
  for (const entry of opts.returns) {
    const familyId = String(entry.familyId ?? '')
    const todo = wanted.get(familyId)
    if (!todo) {
      problems.push(
        `${familyId || '(no familyId)'}: not a family this run handed out — ` +
          'the worklist is what the phase was asked to do, and a claim outside it verifies nothing',
      )
      continue
    }
    if (seen.has(familyId)) {
      problems.push(`${familyId}: claimed twice`)
      continue
    }
    seen.add(familyId)

    const note = String(entry.note ?? '').trim()
    const target = todo.targetCategories as Category[]
    const family = byId.get(familyId)

    if (family) {
      const present = new Set(family.forms.map((f) => f.category))
      const absent = target.filter((c) => !present.has(c))
      if (absent.length === 0 && family.missing.length === 0) {
        claims.push({ familyId, file: todo.file, ok: true, note })
      } else {
        claims.push({
          familyId,
          file: todo.file,
          ok: false,
          note,
          detail:
            `still has no ${[...new Set([...absent, ...family.missing])].join(' or ')} form. ` +
            `The worklist supplied ${target.join(', ')} already translated, so this is the code edit, not the words.`,
        })
      }
      continue
    }

    // The family is gone. Accept only if the file now covers those categories
    // under some other anchor — which is what replacing a conditional with a
    // real plural API looks like.
    const replacement = families.find(
      (f) => f.file === todo.file && target.every((c) => f.forms.some((form) => form.category === c)),
    )
    claims.push(
      replacement
        ? { familyId, file: todo.file, ok: true, note }
        : {
            familyId,
            file: todo.file,
            ok: false,
            note,
            detail:
              `reported an edit the re-scan cannot see. ${todo.anchor} is gone from the inventory and no family ` +
              `in ${todo.file} covers ${target.join(', ')}.`,
          },
    )
  }

  const unclaimed = opts.todo.families.map((f) => f.familyId).filter((id) => !seen.has(id))
  const failed = claims.filter((c) => !c.ok).length

  return {
    schemaVersion: 1,
    // Silence is not success. A family handed out and never reported on is work
    // nobody did, and passing on it would make the whole phase optional.
    ok: problems.length === 0 && failed === 0 && unclaimed.length === 0,
    counts: { claimed: claims.length, verified: claims.length - failed, failed, unclaimed: unclaimed.length },
    claims,
    unclaimed,
    problems,
  }
}

export function formatPluralVerify(r: PluralVerifyResult): string {
  const lines = ['ultrai18n plurals --apply', '']
  if (r.problems.length) {
    lines.push(`REFUSED (${r.problems.length})`)
    for (const p of r.problems) lines.push(`  ✗ ${p}`)
    lines.push('')
  }
  for (const c of r.claims.filter((c) => !c.ok)) {
    lines.push(`  ✗ ${c.familyId}  ${c.file}`)
    lines.push(`      ${c.detail}`)
  }
  if (r.unclaimed.length) {
    lines.push('')
    lines.push(`UNCLAIMED (${r.unclaimed.length}) — handed out and never reported on`)
    for (const id of r.unclaimed.slice(0, 10)) lines.push(`  ${id}`)
  }
  lines.push(
    '',
    r.ok
      ? `VERDICT  ok — ${r.counts.verified} claimed edit(s) are visible in a fresh scan`
      : `VERDICT  fail — ${r.counts.failed} claim(s) the re-scan cannot see, ${r.counts.unclaimed} never reported`,
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// structural

/** What the `structuralist` returns, one per site it was handed. */
export interface StructuralReturn {
  siteId: string
  file?: string
  note?: string
}

export function readStructuralReturns(raw: unknown): StructuralReturn[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { returns?: unknown })?.returns)
      ? (raw as { returns: unknown[] }).returns
      : []
  return list.map((e) => e as StructuralReturn)
}

/**
 * Which claimed structural edits a fresh inventory contradicts.
 *
 * A `grammar-hole` site is one the engine refused because a plural or agreement
 * rule is baked into the expression: no translated string can be correct there,
 * and the target language may need a different NUMBER of agreement sites. The
 * structuralist's job is to make that hole go away.
 *
 * The site ID is derived from the ANCHOR, not from the text, so it survives the
 * edit unless the construct itself moved — which is exactly why it can be
 * checked. A hole still there is an edit that did not happen.
 */
export function unverifiedStructural(
  returns: StructuralReturn[],
  inventory: Inventory,
): { siteId: string; file: string; note: string }[] {
  const holes = new Map(
    inventory.sites
      .filter((s) => s.reason === 'grammar-hole')
      .map((s) => [s.id, s]),
  )
  const out: { siteId: string; file: string; note: string }[] = []
  for (const entry of returns) {
    const siteId = String(entry.siteId ?? '')
    const site = holes.get(siteId)
    if (!site) continue
    out.push({ siteId, file: site.file, note: String(entry.note ?? '').trim() })
  }
  return out
}
