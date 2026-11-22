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
import { readTextEx } from './text'
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
  /**
   * Blanked, length-preserving, BEFORE the row is applied.
   *
   * An oracle has to be independent of the extractor's implementation, not of
   * the format's rules. A markdown line that is entirely a code span is not
   * prose, and the extractor is right to skip it — so a row that reads the
   * backticks as text accuses the extractor of exactly the thing it correctly
   * did. On the two reference repositories that was 113 of 119 findings, every
   * one of them a line like `` - `npm test` ``.
   */
  mask?: RegExp[]
  /**
   * Blanked like `mask`, but by a function, and only for the extractors named.
   *
   * For a construct a pattern cannot delimit and only some of a row's formats
   * have: a JavaScript regex literal is told from a division by the token
   * before its slash, which is state, and Python has no regex literal at all.
   */
  blank?: { extractors: string[]; fn: (line: string) => string }
  /** Why a hit here is text. Required, and printed with every finding. */
  why: string
}

/** Markdown constructs whose text is not prose, or whose target is not. */
const MD_CODE = /`[^`\n]*`/g
const MD_LINK_TARGET = /\]\([^)]*\)/g
const MD_AUTOLINK = /<https?:\/\/[^>]+>|https?:\/\/\S+/g

/** Words after which a JavaScript `/` begins an expression, so a regex literal. */
const REGEX_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
])

/**
 * Blank the BODY of every JavaScript regex literal on a line, preserving length.
 *
 * A regex literal is not copy — nothing a translator is handed lives in one —
 * and the quotes inside it delimit nothing: `/content="noindex, nofollow"/` is a
 * pattern matching an HTML attribute, and the `quoted-prose` row read it as a
 * string. Worse, a lone quote in a pattern (`/"/`) paired with the next real
 * string's opening quote, so the row reported the code between them as text.
 *
 * Whether a `/` opens a pattern or divides is the classic lexer question, and
 * it is answered the classic way: by the last significant token before it. An
 * operand — an identifier, a number, a string, `)` or `]` — means division;
 * anything else, a keyword like `return`, or the start of the line means a
 * pattern. This is a few lines of state on one line of text, not the
 * extractor's grammar, so the oracle stays independent of what it audits.
 *
 * Every mistake it can make is in one direction. It only ever REMOVES bytes a
 * row may read, and only between two slashes it closed on the same line, so a
 * misread costs at worst a missed finding — never an accusation.
 */
export function blankRegexLiterals(line: string): string {
  let out = ''
  // What the last significant token allows a `/` to be.
  let regexAllowed = true
  let i = 0
  const n = line.length
  while (i < n) {
    const c = line[i]!
    if (c === '"' || c === "'" || c === '`') {
      // A string is copied through untouched: a slash inside one is a path.
      let j = i + 1
      while (j < n && line[j] !== c) j += line[j] === '\\' ? 2 : 1
      j = Math.min(j + 1, n)
      out += line.slice(i, j)
      i = j
      regexAllowed = false
      continue
    }
    if (c === '/' && line[i + 1] === '/') {
      // A line comment: nothing after it is code.
      out += line.slice(i)
      break
    }
    if (c === '/' && line[i + 1] === '*') {
      const end = line.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      out += line.slice(i, j)
      i = j
      continue
    }
    if (c === '/' && regexAllowed) {
      const end = regexEnd(line, i)
      if (end !== -1) {
        out += '/' + ' '.repeat(end - i - 1) + '/'
        i = end + 1
        while (i < n && /[a-z]/i.test(line[i]!)) out += line[i++]
        regexAllowed = false
        continue
      }
    }
    if (/[\p{L}\p{N}_$]/u.test(c)) {
      let j = i + 1
      while (j < n && /[\p{L}\p{N}_$]/u.test(line[j]!)) j++
      const word = line.slice(i, j)
      out += word
      // A property named like a keyword (`x.return`) is still an operand.
      regexAllowed = REGEX_AFTER_WORD.has(word) && line[i - 1] !== '.'
      i = j
      continue
    }
    out += c
    if (!/\s/.test(c)) {
      // `)` and `]` close an operand. `<` and a `>` that is not `=>` are JSX
      // here far more often than a comparison against a pattern, and `</p>`
      // must not open one.
      regexAllowed = !(c === ')' || c === ']' || c === '<' || (c === '>' && line[i - 1] !== '='))
    }
    i++
  }
  return out
}

/** The index of the slash closing the regex literal opened at `start`, or -1. */
function regexEnd(line: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i]!
    if (c === '\\') i++
    else if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) return i
  }
  return -1
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
    blank: { extractors: ['ts-ast'], fn: blankRegexLiterals },
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
    mask: [MD_CODE, MD_LINK_TARGET, MD_AUTOLINK],
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
    extractors: ['ts-ast', 'python-ast', 'css', 'sql', 'dockerfile', 'json', 'yaml'],
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
  {
    // Its own row because `--` is not a comment in sh: on a line of its own it
    // is the body of a heredoc (SQL fed to `psql`) or an argument, and the shell
    // reader emits neither. Heredoc bodies are skipped before any row runs.
    id: 'shell-comment',
    extractors: ['shell-ast'],
    re: /^\s*#+\s*(.+?)\s*$/,
    not: /^\s*#!|shellcheck|shfmt|https?:\/\//,
    why: 'A shell comment on its own line. In an install or init script these are the instructions written for a person, and the only text the shell reader emits.',
  },
  {
    // Its own row because `#` starts an attribute in Rust, and the `comment` row
    // would read `#[allow(dead_code, unused)]` as a sentence.
    id: 'rust-comment',
    extractors: ['rust'],
    re: /^\s*(?:\/\/+[!/]?|\/\*+!?)\s*(.+?)(?:\*\/)?\s*$/,
    not: /rustfmt::|clippy::|cargo:|https?:\/\//,
    why: 'A Rust comment on its own line, doc comments included: the prose a Rust codebase keeps closest to the code.',
  },
  {
    // Only `"`, because `'` is a lifetime here. A byte or C string is masked:
    // the reader claims those without emitting them.
    id: 'rust-string',
    extractors: ['rust'],
    re: /"(?<text>(?:[^"\\\n]|\\.)*)"/g,
    mask: [/\b(?:b|br|c|cr)#*"(?:[^"\\\n]|\\.)*"#*/g],
    why: 'A double-quoted Rust literal holding two or more words. A line the lexer read past without a site is the signature of a lost sync.',
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
    const heredoc = extractor === 'shell-ast' ? heredocLines(lines) : null

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // A heredoc body is a string: input to another program, which the shell
      // reader never emits, and whose `#` or `--` lines are that program's.
      if (heredoc?.has(i)) continue
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
        const hit = firstProse(row.re, maskFor(row, line, extractor))
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

/**
 * The 0-based indices of every heredoc BODY line in a shell script, the
 * delimiter line included.
 *
 * Line state, like a markdown fence, and the same size of claim: `<<WORD`,
 * `<<-WORD`, `<<'WORD'` and `<<"WORD"` open one, and the first line that is the
 * word alone — after tabs, for `<<-` — closes it. Several on one line are read
 * in order. `<<<` is a here-string, and a `<<` after a `#` is in a comment. A
 * misread only ever removes lines from the audit, so it can cost a finding and
 * never invent one.
 */
export function heredocLines(lines: string[]): Set<number> {
  const out = new Set<number>()
  const opener = /(?<!<)<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][\w-]*))/g
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const code = line.replace(/(^|\s)#.*$/, '$1')
    const pending: { word: string; tabs: boolean }[] = []
    for (const m of code.matchAll(opener)) {
      if (code[m.index! + 2] === '<') continue
      pending.push({ word: (m[2] ?? m[3] ?? m[4])!, tabs: m[1] === '-' })
    }
    i++
    for (const { word, tabs } of pending) {
      while (i < lines.length) {
        const body = lines[i]!
        out.add(i)
        i++
        if ((tabs ? body.replace(/^\t+/, '') : body) === word) break
      }
    }
  }
  return out
}

/**
 * Blank what this row is not entitled to read, preserving length.
 *
 * Length-preserving so the reported text still lines up with the source, and so
 * a row's own regex sees the line at the offsets it actually has.
 */
function maskFor(row: TextLocator, line: string, extractor: string): string {
  let out = row.blank?.extractors.includes(extractor) ? row.blank.fn(line) : line
  for (const re of row.mask ?? []) {
    out = out.replace(new RegExp(re.source, re.flags), (m) => ' '.repeat(m.length))
  }
  return out
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
