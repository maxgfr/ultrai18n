// The plural-shape table in `fixture-i18n/README.md`, generated from ground
// truth instead of retyped beside it.
//
// The table used to be maintained by hand next to a test asserting the same
// facts, which is two places to be wrong and one of them silent. What a human
// still owns is the `proves` column — the reason a row is in the fixture at all
// — and that lives in its own human-fenced region and is never rewritten.
import type { Inventory } from '../src/types'
import type { PluralFamily } from '../src/plural'

const GEN_OPEN = '<!-- ul:gen key=shapes -->'
const GEN_CLOSE = '<!-- /ul:gen key=shapes -->'
const HUMAN_OPEN = '<!-- ul:human key=proves -->'
const HUMAN_CLOSE = '<!-- /ul:human key=proves -->'

export interface ShapeRow {
  anchor: string
  where: string
  shape: string
  targetNeeds: string
  state: string
  proves: string
}

export function shapeRows(inv: Inventory, proves: Map<string, string>): ShapeRow[] {
  const families = (inv.plurals ?? []) as PluralFamily[]
  return families
    .map((f) => ({
      anchor: f.anchor,
      where: `\`${f.file}\` \`${f.base}\``,
      shape: f.shape,
      targetNeeds: (f.targetRequired ?? f.sourceCategories).join(', '),
      // Derived, so "missing `few` and `many`" is computed rather than retyped
      // — the exact claim a hand-maintained table gets wrong first.
      state: f.missing.length
        ? `**missing ${f.missing.map((c) => `\`${c}\``).join(' and ')}**`
        : f.extra.length
          ? `**extra ${f.extra.map((c) => `\`${c}\``).join(' and ')}**`
          : 'complete',
      proves: proves.get(f.anchor) ?? '',
    }))
    .sort((a, b) => (a.anchor < b.anchor ? -1 : 1))
}

export function renderShapeTable(rows: ShapeRow[]): string {
  return [
    GEN_OPEN,
    '',
    '_Generated from the fixture itself. Edit the `proves` region below, never this table._',
    '',
    '| where | shape | target needs | state | what it is there to prove |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.where} | ${r.shape} | ${r.targetNeeds} | ${r.state} | ${r.proves || '—'} |`),
    '',
    GEN_CLOSE,
  ].join('\n')
}

/** The human-owned column, read back out of its own fenced region. */
export function readProves(readme: string): Map<string, string> {
  const out = new Map<string, string>()
  const from = readme.indexOf(HUMAN_OPEN)
  const to = readme.indexOf(HUMAN_CLOSE)
  if (from === -1 || to === -1) return out
  for (const line of readme.slice(from, to).split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells.length < 4) continue
    const [, anchor, why] = cells
    if (!anchor || !why || anchor === 'anchor' || /^-+$/.test(anchor)) continue
    out.set(anchor.replace(/^`|`$/g, ''), why)
  }
  return out
}

/**
 * Replace the generated region, or append it.
 *
 * Never touches a byte outside the fences — the same convention `glossary.md`
 * has, and for the same reason: a tool that rewrites the file its user curates
 * gets curated once and then abandoned.
 */
export function spliceGenerated(existing: string, body: string): string {
  const from = existing.indexOf(GEN_OPEN)
  const to = existing.indexOf(GEN_CLOSE)
  if (from === -1 || to === -1) return existing.trimEnd() + '\n\n' + body + '\n'
  return existing.slice(0, from) + body + existing.slice(to + GEN_CLOSE.length)
}
