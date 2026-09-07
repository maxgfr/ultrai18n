// A fresh view for post-write gates, leaving the source inventory and plan intact.
import { scan, type ScanOptions } from './scan'
import type { Inventory } from './types'
import type { Plan } from './plan'

export function scanOptionsFor(repo: string, inventory: Inventory): ScanOptions {
  return {
    ...inventory.scanOptions,
    repo,
    from: inventory.sourceLanguage,
    to: inventory.targetLanguage,
  }
}

export async function refreshInventory(repo: string, inventory: Inventory): Promise<Inventory> {
  return scan(scanOptionsFor(repo, inventory))
}

/** Never let a disappearing selection shrink the work that the gates expect. */
export function requirePlannedSites(live: Inventory, plan: Plan, original?: Inventory): void {
  const ids = new Set(live.sites.map((site) => site.id))
  const source = new Map(original?.sites.map((site) => [site.id, site]))
  for (const group of plan.groups) {
    if (group.status !== 'pending' && group.status !== 'memo') continue
    for (const id of [...group.sites, ...group.mirrors]) {
      if (!ids.has(id)) throw new Error(`${id}: selected site is no longer in the repository; review the changed structure`)
      const before = source.get(id)
      // Shell comments use ordinal anchors. An insertion or removal renumbers
      // siblings, so the same id alone cannot establish correspondence.
      if (before?.siteKey.includes('#comment[')) {
        const siblings = (inventory: Inventory) => inventory.sites.filter((site) =>
          site.file === before.file && site.siteKey.includes('#comment[')).length
        if (siblings(original!) !== siblings(live)) {
          throw new Error(`${id}: comment structure changed; selected site correspondence is ambiguous`)
        }
      }
    }
  }
}
