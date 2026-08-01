// Two arms of one construct are one editorial decision.
//
// `classify` answers one site at a time, which is right for everything it
// decides structurally and wrong for the last step it takes. The language
// detector is a measurement with a confidence floor, and a floor applied
// independently to two halves of the same sentence-shaped pair will sometimes
// clear on one and not the other:
//
//   switch (message.kind) {
//     case 'sync':  return 'Synchronisation en cours'    → needs-judgment/no-rule
//     case 'reset': return 'Réinitialisation demandée'   → translate
//   }
//
// Nothing distinguishes those two except that `Synchronisation` is a near
// cognate and scored below 0.7. Reporting them differently is not a refusal —
// a refusal is a claim that the engine could not tell, and here it plainly
// could, because it told for the sibling.
//
// So this pass is deliberately narrow. It only ever RAISES a refusal to the
// answer its sibling already got, never the reverse, and it only looks at
// sites the detector decided: anything settled structurally — an identifier, a
// persisted value, a dual-use hazard, a grammar hole — is settled before the
// detector runs and is not reconsidered here.
import type { RawSite } from './extract/raw'
import type { NeedsJudgmentReason, Site } from './types'

/**
 * The reasons that mean "the detector could not reach the bar", as opposed to
 * "the engine refuses on principle".
 *
 * `dual-use`, `grammar-hole`, `symbol-set` and `label-without-prose` are
 * absent on purpose. Each of those is a considered refusal that a sibling's
 * verdict has no bearing on, and lifting one would hand a persisted value to a
 * translator because the string beside it happened to be copy.
 */
const DETECTOR_REASONS = new Set<NeedsJudgmentReason>(['no-rule', 'ambiguous-role', 'short-string'])

export interface Harmonised {
  /** Sites lifted from a refusal to the verdict a sibling already carried. */
  lifted: number
  /** Constructs that contained a disagreement, for the advisory. */
  groups: number
}

/**
 * Raise detector-only refusals to the verdict a sibling arm already carries.
 *
 * `pairs` must be raw sites beside the sites they produced, because the
 * grouping key lives on the container and the verdict lives on the site.
 */
export function harmoniseBranches(pairs: { raw: RawSite; site: Site }[]): Harmonised {
  const groups = new Map<string, { raw: RawSite; site: Site }[]>()
  for (const pair of pairs) {
    const group = pair.raw.container.branchGroup
    if (!group) continue
    const key = `${pair.raw.file}\0${group}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(pair)
    else groups.set(key, [pair])
  }

  let lifted = 0
  let disagreeing = 0
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue
    if (!bucket.some(({ site }) => site.verdict === 'translate')) continue

    const candidates = bucket.filter(
      ({ site }) =>
        site.verdict === 'needs-judgment' &&
        site.reason !== null &&
        DETECTOR_REASONS.has(site.reason as NeedsJudgmentReason) &&
        // Still require words. A sibling being copy says nothing about a
        // stray `'--'` in the other arm.
        /\p{L}{2,}/u.test(site.value),
    )
    if (candidates.length === 0) continue

    disagreeing++
    for (const { site } of candidates) {
      site.verdict = 'translate'
      site.reason = null
      // Never `high`: this is inherited, not measured, and the distinction is
      // what a reviewer needs in order to spot-check the pass itself.
      site.confidence = 'medium'
      if (!site.flags.includes('branch-sibling')) site.flags.push('branch-sibling')
      lifted++
    }
  }

  return { lifted, groups: disagreeing }
}
