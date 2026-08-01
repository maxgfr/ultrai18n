// Hazards, and the ruling that resolves one.
//
// A hazard is a text that is both displayed copy and an identifier. Both
// readings are correct and one of them destroys stored data, so the engine
// refuses and hands the evidence over. Until now that refusal had no way back:
// the contract asked an agent for `{groupId, sites:[{siteId, verdict, reason}]}`
// and NOTHING parsed that shape, so the only route into the engine was
// hand-editing `exceptions.json`.
//
// Two things had to change beyond writing the parser.
//
// The contract asked for `reason` as prose — "one line grounded in the code you
// read". `types.ts` opens by saying every vocabulary here is closed, and
// `Exception` needs BOTH a closed `reason` and a free `justification`. A ruling
// in the old shape could not be folded into anything `check` can gate, so the
// contract now asks for both.
//
// And a ruling has to be written twice, to two consumers. An exception excuses
// a gate finding; it does not change a verdict, so exceptions alone would leave
// the group a hazard forever. An adjudication changes what `plan` does; but an
// excluded site is still `translate` in the source language, so G4 would demand
// the very site a human just protected. Both files, or the loop does not close.
import { existsSync, readFileSync } from 'node:fs'
import type { Exception, Exceptions } from './check'
import type { Group, Plan } from './plan'
import type { Inventory, Site } from './types'

export type Ruling = 'translate' | 'exclude'

export interface Adjudication {
  siteKey: string
  siteId: string
  groupId: string
  verdict: Ruling
  /** From the closed vocabulary G5 validates. */
  reason: string
  justification: string
  /** Bound to exact bytes, so a ruling voids itself when the text changes. */
  contentHash: string
  decidedBy: string
}

export interface Adjudications {
  schemaVersion: 1
  entries: Adjudication[]
}

/** A group that could not be separated, which is a finding about the code. */
export interface Unseparable {
  groupId: string
  justification: string
}

export interface AdjudicateResult {
  ok: boolean
  accepted: Adjudication[]
  blocked: Unseparable[]
  problems: string[]
}

/**
 * Parse and validate an adjudicator's return.
 *
 * All-or-nothing: any problem refuses the whole file and writes nothing. A
 * partially applied ruling is the worst of both — some sites decided, some not,
 * and no record of which.
 */
export function parseRulings(
  raw: unknown,
  ctx: { inventory: Inventory; plan: Plan; validReasons: Set<string>; decidedBy?: string },
): AdjudicateResult {
  const problems: string[] = []
  const accepted: Adjudication[] = []
  const blocked: Unseparable[] = []

  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { rulings?: unknown })?.rulings)
      ? (raw as { rulings: unknown[] }).rulings
      : null
  if (!list) {
    return { ok: false, accepted: [], blocked: [], problems: ['expected an array of rulings, or {rulings: [...]}'] }
  }

  const bySiteId = new Map(ctx.inventory.sites.map((s) => [s.id, s]))
  const hazards = new Map(ctx.plan.hazards.map((g) => [g.id, g]))

  for (const entry of list as Record<string, unknown>[]) {
    const groupId = String(entry.groupId ?? '')
    const group = hazards.get(groupId)
    if (!group) {
      problems.push(`${groupId || '(no groupId)'}: not an open hazard in this plan`)
      continue
    }

    if (entry.unseparable === true) {
      const justification = String(entry.justification ?? '').trim()
      if (!justification) {
        problems.push(`${groupId}: unseparable needs a justification — it is a claim about the code`)
        continue
      }
      blocked.push({ groupId, justification })
      continue
    }

    const sites = Array.isArray(entry.sites) ? (entry.sites as Record<string, unknown>[]) : null
    if (!sites) {
      problems.push(`${groupId}: no sites array`)
      continue
    }

    // Every site in the group must be ruled on. A partial ruling is refused
    // because the whole point of this phase is that the label and the
    // identifier get DIFFERENT answers — so an unruled site is not a default,
    // it is the half of the decision nobody made.
    const expected = new Set([...group.sites, ...group.mirrors])
    const ruled = new Set(sites.map((s) => String(s.siteId ?? '')))
    const missing = [...expected].filter((id) => !ruled.has(id))
    if (missing.length) {
      problems.push(
        `${groupId}: ${expected.size} site(s) and ${ruled.size} ruling(s) — ` +
          `${missing.length} unruled. Both roles are legitimate and one of them has to be named.`,
      )
      continue
    }

    const batch: Adjudication[] = []
    let bad = false
    for (const s of sites) {
      const siteId = String(s.siteId ?? '')
      const site = bySiteId.get(siteId)
      if (!site) {
        problems.push(`${groupId}: siteId ${siteId} is not in the inventory`)
        bad = true
        continue
      }
      if (!expected.has(siteId)) {
        problems.push(`${groupId}: siteId ${siteId} does not belong to this group`)
        bad = true
        continue
      }
      const verdict = String(s.verdict ?? '')
      if (verdict !== 'translate' && verdict !== 'exclude') {
        problems.push(`${groupId}/${siteId}: verdict ${JSON.stringify(verdict)} is not translate or exclude`)
        bad = true
        continue
      }
      // No fallback to `reason`. Letting the closed token stand in as its own
      // explanation is exactly the hole G5's message names: "an exception
      // without a reason is a place to hide". A ruling in the OLD contract
      // shape — prose in `reason`, no `justification` — is caught by the
      // vocabulary check below, which says where prose belongs.
      const justification = String(s.justification ?? '').trim()
      if (!justification) {
        problems.push(`${groupId}/${siteId}: no justification — an exception without a reason is a place to hide`)
        bad = true
        continue
      }
      const reason = String(s.reason ?? '')
      if (verdict === 'exclude' && !ctx.validReasons.has(reason)) {
        problems.push(
          `${groupId}/${siteId}: reason ${JSON.stringify(reason)} is outside the closed vocabulary — ` +
            'the justification is where prose belongs',
        )
        bad = true
        continue
      }
      batch.push({
        siteKey: site.siteKey,
        siteId,
        groupId,
        verdict,
        reason,
        justification,
        // Set by the ENGINE, never by the model: this is what makes a ruling
        // void itself when the text it was about is later rewritten.
        contentHash: site.contentHash,
        decidedBy: ctx.decidedBy ?? 'adjudicator',
      })
    }
    if (!bad) accepted.push(...batch)
  }

  return { ok: problems.length === 0, accepted, blocked, problems }
}

/**
 * Merge rulings into the exceptions file without clobbering it.
 *
 * An entry for a siteKey this run did not rule on is never touched, and an
 * identical one is left byte-for-byte alone so the diff stays readable.
 */
export function mergeExceptions(existing: Exceptions, accepted: Adjudication[]): {
  merged: Exceptions
  wrote: number
  unchanged: number
} {
  const byKey = new Map(existing.entries.map((e) => [e.siteKey, e]))
  let wrote = 0
  let unchanged = 0

  for (const a of accepted) {
    if (a.verdict !== 'exclude') continue
    const next: Exception = {
      siteKey: a.siteKey,
      reason: a.reason,
      justification: a.justification,
      contentHash: a.contentHash,
      pin: true,
      decidedBy: a.decidedBy,
    }
    const prev = byKey.get(a.siteKey)
    if (prev && prev.contentHash === next.contentHash && prev.reason === next.reason) {
      unchanged++
      continue
    }
    byKey.set(a.siteKey, next)
    wrote++
  }

  return {
    merged: { ...existing, entries: [...byKey.values()].sort((a, b) => (a.siteKey < b.siteKey ? -1 : 1)) },
    wrote,
    unchanged,
  }
}

export function readAdjudications(path: string): Map<string, Adjudication> {
  if (!existsSync(path)) return new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Adjudications
    return new Map((parsed.entries ?? []).map((e) => [e.siteKey, e]))
  } catch {
    // Loud rather than silent is the rule elsewhere, but this is read on the
    // way into `plan`, which has its own reporting: a malformed file leaves the
    // hazards blocked, which is the safe direction.
    return new Map()
  }
}

/** The worklist an agent is handed. */
export interface HazardTodo {
  schemaVersion: 1
  hazards: {
    groupId: string
    text: string
    blocked: string
    sites: {
      siteId: string
      siteKey: string
      file: string
      line: number
      value: string
      surface: string
      verdict: string
      reason: string | null
      evidence: { enumOrigins: string[]; siblingKeys: string[]; nearestComment: string | null }
    }[]
  }[]
}

export function buildHazardTodo(inv: Inventory, plan: Plan): HazardTodo {
  const bySiteId = new Map(inv.sites.map((s) => [s.id, s]))
  return {
    schemaVersion: 1,
    hazards: plan.hazards.map((g: Group) => ({
      groupId: g.id,
      text: g.text,
      blocked: g.blocked ?? 'both a rendered label and an identifier',
      sites: [...g.sites, ...g.mirrors]
        .map((id) => bySiteId.get(id))
        .filter((s): s is Site => s !== undefined)
        .map((s) => ({
          siteId: s.id,
          siteKey: s.siteKey,
          file: s.file,
          line: s.line,
          value: s.value,
          surface: s.surface,
          verdict: s.verdict,
          reason: s.reason,
          evidence: {
            enumOrigins: s.evidence.enumOrigins,
            siblingKeys: s.evidence.siblingKeys,
            nearestComment: s.evidence.nearestComment,
          },
        })),
    })),
  }
}

export function formatAdjudicate(r: AdjudicateResult, wrote: { exceptions: number; unchanged: number }): string {
  const lines: string[] = ['ultrai18n adjudicate', '']
  if (r.problems.length) {
    lines.push(`REFUSED (${r.problems.length}) — nothing was written`)
    for (const p of r.problems) lines.push(`  ✗ ${p}`)
    lines.push('')
  }
  if (r.accepted.length) {
    const excluded = r.accepted.filter((a) => a.verdict === 'exclude').length
    lines.push(`  ${r.accepted.length} ruling(s): ${excluded} excluded, ${r.accepted.length - excluded} to translate`)
    lines.push(`  ${wrote.exceptions} exception(s) written, ${wrote.unchanged} already current`)
  }
  if (r.blocked.length) {
    lines.push('')
    lines.push(`UNSEPARABLE (${r.blocked.length}) — a finding about the code, not a failure to decide`)
    for (const b of r.blocked) lines.push(`  ${b.groupId}: ${b.justification}`)
  }
  lines.push(
    '',
    r.ok && r.blocked.length === 0
      ? `VERDICT  ok — ${r.accepted.length} ruling(s) folded in`
      : `VERDICT  fail — ${r.problems.length} refused, ${r.blocked.length} unseparable`,
  )
  return lines.join('\n')
}
