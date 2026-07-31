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

/**
 * A key that does not exist yet, written after one that does.
 *
 * The single case where replacing bytes cannot express the result. Russian
 * needs `few` and `many`; an English source has neither, so there is no span to
 * overwrite. Refusing outright would mean the tool can find the problem and not
 * fix it, and pushing it to an agent would put a model back in charge of
 * writing files — the one thing this design does not do.
 *
 * So: bounded insertion, JSON and YAML locale bundles only. The new entry is a
 * sibling of an existing one, written directly after it, taking its
 * indentation. Anything else refuses.
 */
export interface Insertion {
  /** The site whose entry the new one follows. */
  afterSiteId: string
  /** The key to create — `item_few`, or just `few` inside a forms object. */
  key: string
  text: string
  /** Ordering hint, so two new forms land in a deterministic order. */
  order?: number
}

export interface ApplyOptions {
  repo: string
  inventory: Inventory
  translations: Translation[]
  /** New sibling keys — plural forms the target locale needs and the source lacks. */
  insertions?: Insertion[]
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
  | { id: string; status: 'applied'; file: string; recovered: boolean; inserted?: boolean }
  | { id: string; status: 'skipped'; file: string; why: string }
  | { id: string; status: 'refused'; file: string; why: string }

export interface ApplyReport {
  write: boolean
  ok: boolean
  sites: {
    total: number
    applied: number
    skipped: number
    refused: number
    recovered: number
    inserted: number
  }
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
  /** Reporting id: the site's, or `<site>+<key>` for an inserted sibling. */
  id: string
  /** How many entries this patch writes. Above 1 only for grouped insertions. */
  writes: number
  inserted?: boolean
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
  // Entries written, not patches applied: several new plural keys sharing one
  // anchor are one patch, and reporting them as one write would make the total
  // look short by however many forms the locale needed.
  let appliedWrites = 0

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

  // Every new sibling of one anchor becomes ONE patch. Two zero-width patches
  // at the same offset would otherwise land in whichever order the sort
  // happened to produce, and `few` before `many` is not something to leave to
  // an unstable comparison.
  for (const [afterSiteId, group] of groupBy(opts.insertions ?? [], (i) => i.afterSiteId)) {
    const site = byId.get(afterSiteId)
    if (!site) {
      outcomes.push({
        id: afterSiteId,
        status: 'refused',
        file: '?',
        why: 'the site this new key would follow is not in the inventory',
      })
      continue
    }
    try {
      const patch = buildInsertion(repo, site, group)
      const list = byFile.get(site.file)
      if (list) list.push(patch)
      else byFile.set(site.file, [patch])
    } catch (err) {
      outcomes.push({ id: patch_id(afterSiteId, group), status: 'refused', file: site.file, why: (err as Error).message })
      refusedFiles.add(site.file)
    }
  }

  // Overlapping patches mean the inventory is malformed — most often a template
  // whose fragments were not coalesced. Writing them would interleave bytes.
  for (const [file, patches] of byFile) {
    patches.sort((a, b) => a.start - b.start || Number(a.inserted) - Number(b.inserted))
    for (let i = 0; i + 1 < patches.length; i++) {
      if (patches[i]!.end > patches[i + 1]!.start) {
        refusedFiles.add(file)
        outcomes.push({
          id: patches[i]!.id,
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
        if (!outcomes.some((o) => o.id === p.id)) {
          outcomes.push({ id: p.id, status: 'skipped', file, why: 'another site in this file or group refused' })
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
        outcomes.push({ id: p.id, status: 'refused', file, why: (err as Error).message })
      }
      continue
    }

    written.push({ file, sha256Before: digest(before), sha256After: digest(patched) })
    for (const p of patches) {
      appliedWrites += p.writes
      outcomes.push({
        id: p.id,
        status: 'applied',
        file,
        recovered: p.recovered,
        ...(p.inserted ? { inserted: true } : {}),
      })
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

  const applied = appliedWrites
  const skipped = outcomes.filter((o) => o.status === 'skipped').length
  const refused = outcomes.filter((o) => o.status === 'refused').length
  const inserted = (opts.insertions ?? []).length

  return {
    write,
    ok: refused === 0 && incompleteGroups === 0,
    sites: {
      total: opts.translations.length + inserted,
      applied,
      skipped,
      refused,
      recovered: recoveredCount,
      inserted,
    },
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
  let escaped = escapeFor(syntax, text, {
    quote: site.quote,
    asciiOnly,
    atLineStart: startsItsLine(buf, start),
  })

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
    id: site.id,
    writes: 1,
  }
}

/**
 * Write one or more new sibling entries after an existing one.
 *
 * Deliberately narrow. Only JSON and YAML, only a sibling of a key that is
 * already there, only the indentation that key already uses. Everything about
 * this is checkable from the anchor alone, which is what makes it safe to do at
 * all — the alternative was refusing to complete a Russian family forever.
 */
function buildInsertion(repo: string, site: Site, insertions: Insertion[]): Patch {
  const syntax = syntaxFor(site)
  if (syntax !== 'json-string' && syntax !== 'yaml-scalar') {
    throw new UnknownSyntaxError(
      `${site.file}: a new plural form here would be a ${syntax} edit, and insertion is only supported in JSON and YAML locale bundles`,
    )
  }

  const buf = readFileSync(join(repo, site.file))
  // No recovery path, unlike a replacement. A replacement that has drifted can
  // be relocated by its own text; an insertion has no text yet, and putting a
  // new key after "roughly where that key used to be" is not a thing to guess.
  if (buf.subarray(site.span.start, site.span.end).toString('utf8') !== site.raw) {
    throw new Error(
      `drift at ${site.file}:${site.line} — the anchor for a new key no longer matches, so its position is unknown`,
    )
  }

  const indent = indentOfLine(buf, site.span.start)
  const ordered = [...insertions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.key < b.key ? -1 : 1))
  const entries = ordered.map((ins) => {
    const escaped = escapeFor(syntax, ins.text, { quote: '"', asciiOnly: usesUnicodeEscapes(buf) })
    return syntax === 'json-string'
      ? `,\n${indent}${JSON.stringify(ins.key)}: "${escaped}"`
      : `\n${indent}${ins.key}: "${escaped}"`
  })

  return {
    site,
    syntax,
    // Zero-width, immediately after the anchor's closing delimiter. In JSON the
    // comma leads, so this is correct whether the anchor was the last entry in
    // its object or not.
    start: site.span.end,
    end: site.span.end,
    replacement: Buffer.from(entries.join(''), 'utf8'),
    intended: ordered.map((i) => i.text).join(' / '),
    recovered: false,
    id: patch_id(site.id, ordered),
    writes: ordered.length,
    inserted: true,
  }
}

function patch_id(siteId: string, insertions: Insertion[]): string {
  return `${siteId}+${insertions.map((i) => i.key).sort().join('+')}`
}

/** Is everything before this offset on its line whitespace? */
function startsItsLine(buf: Buffer, at: number): boolean {
  let i = at
  while (i > 0 && buf[i - 1] !== 0x0a) {
    const byte = buf[i - 1]!
    if (byte !== 0x20 && byte !== 0x09) return false
    i--
  }
  return true
}

/** The leading whitespace of the line a byte offset sits on. */
function indentOfLine(buf: Buffer, at: number): string {
  let start = at
  while (start > 0 && buf[start - 1] !== 0x0a) start--
  let end = start
  while (end < buf.length && (buf[end] === 0x20 || buf[end] === 0x09)) end++
  return buf.subarray(start, end).toString('utf8')
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const list = out.get(k)
    if (list) list.push(item)
    else out.set(k, [item])
  }
  return out
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
  if (r.sites.inserted) {
    lines.push(`  ${r.sites.inserted} new plural form(s) written as keys their locale requires and the file did not have`)
  }
  if (r.sites.recovered) lines.push(`  ${r.sites.recovered} site(s) recovered after their file shifted`)
  if (r.groups.incomplete) lines.push(`  ${r.groups.incomplete} group(s) held back so no partial group is written`)
  for (const o of r.outcomes) {
    if (o.status === 'applied') continue
    lines.push(`  ${o.status === 'refused' ? '✗' : '·'} ${o.file}  ${o.id}  ${o.why}`)
  }
  return lines.join('\n')
}

export { UnknownSyntaxError }
