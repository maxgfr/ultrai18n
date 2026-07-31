// apply: write the translations, by byte offset.
//
// Dry-run by default. Everything that can fail is checked before the first
// write, so a mid-run failure is a disk failure rather than a logic failure —
// and the overwhelmingly common outcome of a bad run is a repository that was
// never touched.
//
// Two guarantees, and both are structural rather than best-effort. Per file:
// one buffer, one rename, so a file is either fully patched or untouched. Per
// group: every file is validated before any file is written, so a translation
// landing in four files never lands in three.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import type { Inventory, Site } from './types'
import { escapeFor, unescapeFor, syntaxFor, UnknownSyntaxError, type HostSyntax } from './escape'

export interface Translation {
  /** Site id. */
  id: string
  text: string
}

export interface ApplyOptions {
  repo: string
  inventory: Inventory
  translations: Translation[]
  write?: boolean
  /**
   * Recover a site whose recorded offsets no longer hold its raw text, when the
   * text occurs exactly once elsewhere in the file. Off means any drift refuses.
   */
  recover?: boolean
  /** Groups whose members must all apply or none: [[siteId, ...], ...]. */
  groups?: string[][]
}

export type SiteOutcome =
  | { id: string; status: 'applied'; file: string; recovered: boolean }
  | { id: string; status: 'skipped'; file: string; why: string }
  | { id: string; status: 'refused'; file: string; why: string }

export interface ApplyReport {
  write: boolean
  ok: boolean
  sites: { total: number; applied: number; skipped: number; refused: number; recovered: number }
  files: { touched: number; written: number; skipped: number }
  groups: { total: number; applied: number; incomplete: number }
  outcomes: SiteOutcome[]
  /** Files that would change, with their before/after digests. */
  written: { file: string; sha256Before: string; sha256After: string }[]
  drift: { hard: number; recovered: number; files: string[] }
}

interface Patch {
  site: Site
  syntax: HostSyntax
  /** Byte span to replace — the VALUE, so delimiters keep their original style. */
  start: number
  end: number
  replacement: Buffer
  intended: string
  recovered: boolean
}

export function apply(opts: ApplyOptions): ApplyReport {
  const { repo, inventory } = opts
  const write = opts.write ?? false
  const recover = opts.recover !== false

  const byId = new Map(inventory.sites.map((s) => [s.id, s]))
  const outcomes: SiteOutcome[] = []
  const byFile = new Map<string, Patch[]>()
  const refusedFiles = new Set<string>()
  let recoveredCount = 0

  for (const t of opts.translations) {
    const site = byId.get(t.id)
    if (!site) {
      outcomes.push({ id: t.id, status: 'refused', file: '?', why: 'no such site in the inventory' })
      continue
    }
    try {
      const patch = buildPatch(repo, site, t.text, recover)
      if (patch.recovered) recoveredCount++
      const list = byFile.get(site.file)
      if (list) list.push(patch)
      else byFile.set(site.file, [patch])
    } catch (err) {
      const why = (err as Error).message
      outcomes.push({ id: t.id, status: 'refused', file: site.file, why })
      // A file with any unresolvable site is skipped whole. Writing the sites
      // that did resolve would leave the file in a state nobody chose.
      refusedFiles.add(site.file)
    }
  }

  // Overlapping patches mean the inventory is malformed — most often a template
  // whose fragments were not coalesced. Writing them would interleave bytes.
  for (const [file, patches] of byFile) {
    patches.sort((a, b) => a.start - b.start)
    for (let i = 0; i + 1 < patches.length; i++) {
      if (patches[i]!.end > patches[i + 1]!.start) {
        refusedFiles.add(file)
        outcomes.push({
          id: patches[i]!.site.id,
          status: 'refused',
          file,
          why: `overlaps the next site at byte ${patches[i + 1]!.start} — the inventory is inconsistent`,
        })
      }
    }
  }

  // Group atomicity, enforced above file atomicity: a group whose members touch
  // a refused file must not apply anywhere, or CI sees a half-translated state.
  const groups = opts.groups ?? []
  let incompleteGroups = 0
  for (const group of groups) {
    const files = new Set<string>()
    for (const id of group) {
      const site = byId.get(id)
      if (site) files.add(site.file)
    }
    if ([...files].some((f) => refusedFiles.has(f))) {
      incompleteGroups++
      for (const f of files) refusedFiles.add(f)
    }
  }

  const written: ApplyReport['written'] = []
  let filesWritten = 0

  for (const [file, patches] of [...byFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (refusedFiles.has(file)) {
      for (const p of patches) {
        if (!outcomes.some((o) => o.id === p.site.id)) {
          outcomes.push({ id: p.site.id, status: 'skipped', file, why: 'another site in this file or group refused' })
        }
      }
      continue
    }

    const abs = join(repo, file)
    const before = readFileSync(abs)
    let patched: Buffer
    try {
      patched = applyPatches(before, patches)
    } catch (err) {
      for (const p of patches) {
        outcomes.push({ id: p.site.id, status: 'refused', file, why: (err as Error).message })
      }
      continue
    }

    written.push({ file, sha256Before: digest(before), sha256After: digest(patched) })
    for (const p of patches) {
      outcomes.push({ id: p.site.id, status: 'applied', file, recovered: p.recovered })
    }

    if (write) {
      // Write to a temporary file in the same directory and rename: rename is
      // atomic, so a reader sees the old file or the new one, never a partial.
      const tmp = join(dirname(abs), `.ultrai18n-${process.pid}-${filesWritten}.tmp`)
      try {
        writeFileSync(tmp, patched)
        renameSync(tmp, abs)
        filesWritten++
      } catch (err) {
        try {
          unlinkSync(tmp)
        } catch {
          /* the temp file may not exist */
        }
        throw err
      }
    }
  }

  const applied = outcomes.filter((o) => o.status === 'applied').length
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const refused = outcomes.filter((o) => o.status === 'refused').length

  return {
    write,
    ok: refused === 0 && incompleteGroups === 0,
    sites: { total: opts.translations.length, applied, skipped, refused, recovered: recoveredCount },
    files: { touched: byFile.size, written: write ? filesWritten : written.length, skipped: refusedFiles.size },
    groups: { total: groups.length, applied: groups.length - incompleteGroups, incomplete: incompleteGroups },
    outcomes: outcomes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.id < b.id ? -1 : 1)),
    written,
    drift: { hard: refusedFiles.size, recovered: recoveredCount, files: [...refusedFiles].sort() },
  }
}

function buildPatch(repo: string, site: Site, text: string, recover: boolean): Patch {
  const buf = readFileSync(join(repo, site.file))
  const syntax = syntaxFor(site)

  let start = site.span.start
  let end = site.span.end
  let recovered = false

  // Three-valued drift. The recorded offsets are checked against the recorded
  // raw text; a mismatch is then given exactly one chance to recover, and only
  // when the answer is unambiguous.
  if (buf.subarray(start, end).toString('utf8') !== site.raw) {
    if (!recover) {
      throw new Error(`drift at ${site.file}:${site.line} — the recorded bytes no longer match, and --no-recover is set`)
    }
    const needle = Buffer.from(site.raw, 'utf8')
    const found = allIndexesOf(buf, needle)
    if (found.length === 1) {
      // Lines were inserted above. The site is where it always was, relative to
      // its own text, so following it is a fact rather than a guess.
      const delta = found[0]! - start
      start += delta
      end += delta
      recovered = true
    } else {
      throw new Error(
        found.length === 0
          ? `drift at ${site.file}:${site.line} — the recorded text is no longer in the file`
          : `drift at ${site.file}:${site.line} — the recorded text occurs ${found.length} times, so its position is ambiguous`,
      )
    }
  }

  // The delimiters keep their original style: only the interior is rewritten.
  const valueStart = start + (site.valueSpan.start - site.span.start)
  const valueEnd = end - (site.span.end - site.valueSpan.end)

  const asciiOnly = usesUnicodeEscapes(buf)
  let escaped = escapeFor(syntax, text, { quote: site.quote, asciiOnly })

  // Put the interpolations back. The translation carries ordinal placeholders,
  // which is what let the translator MOVE them; splicing happens after escaping
  // because the template escaper would otherwise escape the `${` we are about
  // to write.
  if (site.holes.length > 0) {
    escaped = escaped.replace(/\{(\d+)\}/g, (whole, n: string) => {
      const hole = site.holes.find((h) => h.index === Number(n))
      return hole ? '${' + hole.expr + '}' : whole
    })
  }

  // A comment carries its own delimiters, which live INSIDE its span. Writing
  // the text alone over that span deletes the marker and turns the comment into
  // a syntax error, so a site that records a prefix rebuilds itself around the
  // new value rather than replacing itself with it.
  let writeStart = valueStart
  let writeEnd = valueEnd
  if (site.prefix !== undefined || site.suffix !== undefined) {
    const linePrefix = site.linePrefix ?? ''
    const body = linePrefix
      ? escaped.split('\n').map((l, i) => (i === 0 ? l : linePrefix + l)).join('\n')
      : escaped
    escaped = (site.prefix ?? '') + body + (site.suffix ?? '')
    writeStart = start
    writeEnd = end
  }

  // Round-trip self-check. Decoding the bytes we are about to write must give
  // back the translation we meant. An escaper that is wrong for this particular
  // input fails loudly here instead of corrupting the file silently.
  const forCheck = site.holes.length > 0
    ? escaped.replace(/\$\{[^}]*\}/g, (m) => {
        const hole = site.holes.find((h) => '${' + h.expr + '}' === m)
        return hole ? `{${hole.index}}` : m
      })
    : escaped
  const decoded = unescapeFor(
    syntax,
    site.prefix !== undefined
      ? forCheck.slice((site.prefix ?? '').length, forCheck.length - (site.suffix ?? '').length)
          .split('\n')
          .map((l, i) => (i === 0 || !site.linePrefix ? l : l.slice(site.linePrefix.length)))
          .join('\n')
      : forCheck,
    { quote: site.quote },
  )
  if (decoded !== text && !asciiOnly) {
    throw new Error(
      `escaping ${site.file}:${site.line} as ${syntax} did not round-trip: wrote ${JSON.stringify(escaped)}, read back ${JSON.stringify(decoded)}`,
    )
  }

  return {
    site,
    syntax,
    start: writeStart,
    end: writeEnd,
    replacement: Buffer.from(escaped, 'utf8'),
    intended: text,
    recovered,
  }
}

/**
 * Apply patches to one buffer.
 *
 * Descending byte order, so no offset needs adjusting as we go: every patch
 * still refers to the original coordinates when its turn comes. Ascending order
 * with running deltas is the same result and one arithmetic slip away from
 * corruption.
 */
function applyPatches(buf: Buffer, patches: Patch[]): Buffer {
  const ordered = [...patches].sort((a, b) => b.start - a.start)
  let out = buf
  for (const p of ordered) {
    if (p.start < 0 || p.end > out.length || p.start > p.end) {
      throw new Error(`patch span ${p.start}-${p.end} is outside the file`)
    }
    out = Buffer.concat([out.subarray(0, p.start), p.replacement, out.subarray(p.end)])
  }
  return out
}

function allIndexesOf(haystack: Buffer, needle: Buffer): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    out.push(at)
    from = at + 1
    if (out.length > 8) break
  }
  return out
}

/**
 * Does this file escape its non-ASCII characters as \uXXXX?
 *
 * The question is about the file's POLICY, not its current contents. A file
 * with no accented characters usually just has English text in it; concluding
 * from that it wants everything escaped would turn every em dash in a
 * translation into \u2014 and make the diff unreadable. Evidence of a policy is
 * an escape that is actually there.
 */
function usesUnicodeEscapes(buf: Buffer): boolean {
  let hasNonAscii = false
  for (const byte of buf) {
    if (byte > 127) {
      hasNonAscii = true
      break
    }
  }
  if (hasNonAscii) return false
  return /\\u[0-9a-fA-F]{4}/.test(buf.toString('utf8'))
}

function digest(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16)
}

export function formatApply(r: ApplyReport): string {
  const head = r.write
    ? `ultrai18n apply: ${r.ok ? '✓' : '✗'} ${r.sites.applied}/${r.sites.total} applied, ${r.drift.hard} drift, ${r.files.written} files`
    : `ultrai18n apply: dry-run — would apply ${r.sites.applied}/${r.sites.total}, ${r.drift.hard} drift (pass --write)`
  const lines = [head]
  if (r.sites.recovered) lines.push(`  ${r.sites.recovered} site(s) recovered after their file shifted`)
  if (r.groups.incomplete) lines.push(`  ${r.groups.incomplete} group(s) held back so no partial group is written`)
  for (const o of r.outcomes) {
    if (o.status === 'applied') continue
    lines.push(`  ${o.status === 'refused' ? '✗' : '·'} ${o.file}  ${o.id}  ${o.why}`)
  }
  return lines.join('\n')
}

export { UnknownSyntaxError }
