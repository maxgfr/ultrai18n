// The audit that proves it: an oracle the extractors do not share.
//
// `sweep` already makes the strongest claim this project makes — a file whose
// `claimRatio` is 1.0 has an extractor ASSERTING it accounted for every byte,
// so a human-looking line no site covers contradicts a recorded claim. That
// logic lived only in `bench/sweep.mjs`: it needs the network, it needs
// `codeindex` on PATH, and it only ever ran against nine pinned repositories.
// The numbers it produced were therefore numbers nobody else could reproduce,
// which is not evidence.
//
// The same check works offline, on the user's own repository, with no oracle at
// all — provided the oracle is INDEPENDENT of the thing under audit. Asking an
// extractor whether the extractor found everything is a tautology, and a
// generic "does this line look human" predicate is the opposite failure: most
// lines of a TypeScript module read as human and legitimately hold no text.
//
// So the oracle is a small table of LOCATORS, one row per way a format writes
// text down, each citing what it points at — the same shape `catalog/rules.ts`
// and `bench/locators.json` already use. A row can be wrong, and when it is,
// the fix is a row rather than an argument.
import { join } from 'node:path'
import { readTextEx } from './vendor/text'
import type { CensusEntry, Inventory, Site } from './types'

/**
 * Two or more words, separated the way prose separates them.
 *
 * The floor `humanLookingRuns` already applies, and it is what keeps an
 * identifier, a version and a path segment out of the oracle. Two details are
 * load-bearing, and both were added after the first run of this audit against
 * this repository reported code as text:
 *
 *  - the separator must contain WHITESPACE, so `s.span.start` and `foo(bar)`
 *    are two identifiers rather than two words;
 *  - it may hold at most two other characters, so `start && hit` — an operator
 *    with a word either side — is not a sentence.
 */
const TWO_WORDS = /\p{L}{2,}[^\p{L}\n]{0,2}\s\p{L}{2,}/u

export interface TextLocator {
  id: string
  /** Extractors whose output this row is entitled to contradict. */
  extractors: string[]
  /**
   * Applied per line. The text is the named group `text`, else group 1, else
   * the whole match.
   *
   * Named rather than positional because a row that has to backreference its
   * own delimiter — a quoted literal — spends group 1 on the quote, and reading
   * the quote as the text is a row that silently never fires.
   */
  re: RegExp
  /** Lines this row must not fire on, whatever `re` says. */
  not?: RegExp
  /** Why a hit here is text. Required, and printed with every finding. */
  why: string
}

/**
 * What a person reading each format would point at and call text.
 *
 * Deliberately narrow. Every row is entitled to ACCUSE an extractor of missing
 * something, so a row that fires on code costs the whole audit its credibility —
 * the failure mode of a noisy gate is that people stop reading it.
 */
export const LOCATORS: TextLocator[] = [
  {
    id: 'quoted-prose',
    extractors: ['ts-ast', 'python-ast'],
    re: /(['"`])(?<text>(?:[^'"`\\\n]|\\.)*)\1/g,
    why: 'A quoted literal holding two or more words. This is where a code file keeps its copy, and an extractor claiming every byte has no excuse for one.',
  },
  {
    id: 'jsx-text',
    extractors: ['ts-ast'],
    // A COMPLETE open tag, text, and the start of a closing tag. A bare
    // `>` … `<` pair matched `Map<string, Site[]>` and `a >= b && c`, which is
    // most of a TypeScript file.
    re: /<[a-zA-Z][^<>]*>([^<>{}\n]+)<\//g,
    why: 'Text between two JSX tags on one line — the visible label of a component, and the one thing a symbol indexer never sees.',
  },
  {
    id: 'json-value',
    extractors: ['json'],
    re: /:\s*"((?:[^"\\]|\\.)*)"/g,
    why: 'A string VALUE in an object. A key is an identifier; a value with two words in it is copy until something says otherwise.',
  },
  {
    id: 'yaml-scalar',
    extractors: ['yaml'],
    re: /^\s*(?:[\w.@/-]+\s*:\s*|-\s+)(.+)$/,
    not: /^\s*#|^\s*[\w.@/-]+\s*:\s*[|>]/,
    why: 'A mapping value or sequence item. Block scalars are excluded here because their body is read line by line by the row above them.',
  },
  {
    id: 'markdown-prose',
    extractors: ['markdown', 'text'],
    re: /^(.*)$/,
    not: /^\s{4,}|^\s*[|>]|^\s*```|^\s*~~~|^\s*\[[^\]]+\]:\s|^\s*<|^\s*$/,
    why: 'A prose line in a document. Hard-wrapped paragraphs are the normal way markdown is written, and losing all but the last line of one was the largest recall hole this project has had.',
  },
  {
    id: 'markup-text',
    extractors: ['html'],
    re: />([^<>\n]*)</g,
    why: 'Text between two tags. Includes an SVG <title> and <desc>, which carry the accessible name of every icon in an interface.',
  },
  {
    id: 'comment',
    extractors: ['ts-ast', 'python-ast', 'shell-ast', 'css', 'sql', 'dockerfile', 'json', 'yaml'],
    // Anchored at the start of the line, and `--` must be followed by a space.
    // Unanchored, a regex literal holding `\/\/` read as a comment marker and a
    // CSS custom property `--color-ink-950` read as a SQL comment. A TRAILING
    // comment is therefore outside this oracle — a real gap, and the safe one:
    // the alternative to anchoring is lexing the line, and an oracle that needs
    // a lexer is the extractor it is supposed to be independent of.
    re: /^\s*(?:\/\/+|#+|--\s|\/\*)\s*(.+?)(?:\*\/)?\s*$/,
    not: /^\s*#!|shellcheck|eslint-|prettier-|@ts-|noqa|pylint|type:\s|https?:\/\//,
    why: 'A comment on its own line. The file of comments nobody opened is the classic residue of a translation pass, and four French ones in a stylesheet survived two separate human passes on the reference repository.',
  },
]

export interface AuditFinding {
  file: string
  line: number
  locator: string
  text: string
  claimRatio: number
  extractor: string
}

export interface AuditView {
  /** Files whose extractor asserted it accounted for every byte. */
  audited: number
  /** Files this audit is not entitled to question, by why. */
  excused: { measured: number; unaddressable: number; noLocator: number }
  linesChecked: number
  findings: AuditFinding[]
  ok: boolean
}

/**
 * Is this file's `claimRatio` a MEASUREMENT the audit may contradict?
 *
 * The one place this check can slander the engine, so the predicate is narrow
 * on purpose — the same three conditions `bench/sweep.mjs` applies, and for the
 * same reasons.
 *
 *  - `claimRatio === 1` is the assertion itself: "what I did not emit, I looked
 *    at and judged non-textual".
 *  - It does not hold for a file the residual sweep read: `scan` sets
 *    `bytesClaimed = read.bytes` unconditionally there, so the ratio is 1 by
 *    construction rather than by measurement. Counting those would turn every
 *    format with no reader into an accusation, when "this format has no reader"
 *    is a limit stated out loud that G2 already refuses to pass on.
 *  - It does not hold for a file whose decoded offsets are not file-byte
 *    offsets. An accounted-for-every-byte claim is exactly what a file the
 *    engine cannot address by byte is unable to make.
 */
function asserts(entry: CensusEntry): boolean {
  if (entry.bucket !== 'scanned') return false
  if (entry.byteAddressable === false) return false
  if (entry.claimRatio !== 1) return false
  const extractor = entry.extractors?.[0] ?? ''
  return extractor !== '' && extractor !== 'residual-sweep' && extractor !== 'none' && extractor !== 'empty'
}

/**
 * Every human-looking line a site does not cover, in a file claiming it read
 * all of them.
 *
 * The join is LINE-INTERVAL CONTAINMENT rather than byte overlap, because a
 * block scalar, a template literal and a prose run all span several lines and a
 * locator only ever knows the one it matched on.
 */
export function auditCoverage(inv: Inventory, repo: string): AuditView {
  const sitesByFile = new Map<string, Site[]>()
  for (const site of inv.sites) {
    const list = sitesByFile.get(site.file)
    if (list) list.push(site)
    else sitesByFile.set(site.file, [site])
  }

  const findings: AuditFinding[] = []
  const excused = { measured: 0, unaddressable: 0, noLocator: 0 }
  let audited = 0
  let linesChecked = 0

  for (const entry of inv.census) {
    if (!asserts(entry)) {
      if (entry.bucket !== 'scanned') continue
      if (entry.byteAddressable === false) excused.unaddressable++
      else excused.measured++
      continue
    }

    const extractor = entry.extractors![0]!
    const rows = LOCATORS.filter((l) => l.extractors.includes(extractor))
    if (rows.length === 0) {
      excused.noLocator++
      continue
    }

    // The DECODED text, because that is what the engine's spans and line
    // numbers index: a UTF-8 BOM is stripped before extraction, so reading the
    // raw bytes here would put every line one off in exactly the files a BOM
    // appears in.
    let text: string
    try {
      const read = readTextEx(join(repo, entry.file))
      if (!read.ok || read.binary) continue
      text = read.text
    } catch {
      continue
    }

    audited++
    const covered = coveredLines(sitesByFile.get(entry.file) ?? [])
    const lines = text.split('\n')
    let inFence = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // A fenced block is code the document itself declares as code. Tracked
      // here rather than in the markdown row, because the row is a regex and a
      // fence is state.
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        continue
      }
      if (inFence) continue

      const number = i + 1
      if (covered.has(number)) continue
      linesChecked++

      for (const row of rows) {
        if (row.not?.test(line)) continue
        const hit = firstProse(row.re, line)
        if (hit === null) continue
        findings.push({
          file: entry.file,
          line: number,
          locator: row.id,
          text: hit.length > 100 ? hit.slice(0, 99) + '…' : hit,
          claimRatio: entry.claimRatio!,
          extractor,
        })
        break
      }
    }
  }

  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
  return { audited, excused, linesChecked, findings, ok: findings.length === 0 }
}

/** The first match of this row holding two or more words, or null. */
function firstProse(re: RegExp, line: string): string | null {
  if (re.global) {
    // A fresh regex per call: a global one carries `lastIndex` between calls
    // and would skip every other line.
    const local = new RegExp(re.source, re.flags)
    for (const m of line.matchAll(local)) {
      const body = textOf(m)
      if (TWO_WORDS.test(body)) return body
    }
    return null
  }
  const m = re.exec(line)
  if (!m) return null
  const body = textOf(m)
  return TWO_WORDS.test(body) ? body : null
}

function textOf(m: RegExpMatchArray | RegExpExecArray): string {
  return (m.groups?.text ?? m[1] ?? m[0]).trim()
}

function coveredLines(sites: Site[]): Set<number> {
  const out = new Set<number>()
  for (const site of sites) {
    for (let n = site.line; n <= site.endLine; n++) out.add(n)
  }
  return out
}

export function formatAudit(v: AuditView): string {
  const lines = [
    `ultrai18n sites --audit  ${v.audited} file(s) asserting full coverage, ${v.linesChecked} uncovered line(s) checked`,
    '',
  ]

  if (v.findings.length) {
    lines.push(
      'CONTRADICTED — the extractor recorded a claimRatio of 1.0 for this file, meaning it',
      'accounted for every byte. These lines hold text and no site covers them.',
      '',
    )
    for (const f of v.findings.slice(0, 40)) {
      lines.push(`  ${f.file}:${f.line}  [${f.locator}]  ${JSON.stringify(f.text)}`)
      lines.push(`      extractor ${f.extractor}, claimRatio ${f.claimRatio}`)
    }
    if (v.findings.length > 40) lines.push(`  … and ${v.findings.length - 40} more`)
    lines.push('')
  }

  lines.push(
    `  ${v.excused.measured} file(s) not audited: their ratio was set rather than measured`,
    `  ${v.excused.unaddressable} not byte-addressable, ${v.excused.noLocator} with no locator for their format`,
    '',
    v.ok
      ? `VERDICT  ok — no site is missing from ${v.audited} file(s) claiming to have read all of themselves`
      : `VERDICT  fail — ${v.findings.length} line(s) contradict a recorded claim of full coverage`,
  )
  return lines.join('\n')
}

/** Every locator, for `sites --audit --json` and for anybody auditing the auditor. */
export function locatorTable(): { id: string; extractors: string[]; why: string }[] {
  return LOCATORS.map((l) => ({ id: l.id, extractors: l.extractors, why: l.why }))
}
