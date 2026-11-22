// A scanner for ICU MessageFormat arguments.
//
// Not a general MessageFormat implementation and not trying to be. It answers
// three questions and nothing else: where are the `plural` / `selectordinal` /
// `select` arguments, what are their branch bodies, and where do the simple
// placeholders sit. That is exactly what is needed to hand a translator the
// BRANCH TEXT and keep the syntax in the engine — the same split the whole tool
// runs on one level up, where the engine owns the file and the model owns the
// prose.
//
// Handing a model the raw `{count, plural, one {...} other {...}}` and hoping it
// reproduces the syntax is the failure mode this avoids. It also cannot express
// the case that matters most: en→ru needs FOUR branches where the source has
// two, and a model rewriting a skeleton it does not understand is not how that
// should happen.
import { isCategory, type Category } from './categories'

export type IcuArgType = 'plural' | 'selectordinal' | 'select'

export interface IcuBranch {
  /** `one`, `other`, `=0`, `male` — as written. */
  selector: string
  /** Set when the selector is a CLDR category; null for `=N` and `select` keys. */
  category: Category | null
  /** Character offsets of the branch BODY, excluding its braces. */
  start: number
  end: number
  body: string
}

export interface IcuArgument {
  /** Character offsets of the whole `{…}`. */
  start: number
  end: number
  name: string
  type: IcuArgType
  /** `offset:1`, which shifts the number before the rule is applied. */
  offset: number | null
  branches: IcuBranch[]
  /** 0 for a top-level argument; greater inside another argument's branch. */
  depth: number
}

export interface IcuScan {
  /** plural / selectordinal / select arguments, in document order. */
  arguments: IcuArgument[]
  /** Simple `{name}` arguments, for arity checks. */
  placeholders: string[]
  /** False when braces or quotes do not balance — then nothing here is trusted. */
  ok: boolean
}

const ARG_TYPES = new Set<string>(['plural', 'selectordinal', 'select'])

/** Cheap pre-filter, so the scanner only runs on strings that could be ICU. */
export function looksLikeIcu(text: string): boolean {
  return /\{\s*[\w.]+\s*,\s*(?:plural|selectordinal|select)\s*,/.test(text)
}

export function scanIcu(text: string): IcuScan {
  const args: IcuArgument[] = []
  const placeholders: string[] = []
  let ok = true

  const visit = (from: number, to: number, depth: number): void => {
    let i = from
    while (i < to) {
      const ch = text[i]!
      if (ch === "'") {
        i = skipQuote(text, i)
        continue
      }
      if (ch !== '{') {
        i++
        continue
      }
      const close = matchBrace(text, i)
      if (close === -1 || close > to) {
        ok = false
        return
      }
      const parsed = parseArgument(text, i, close, depth)
      if (parsed) {
        args.push(parsed)
        for (const branch of parsed.branches) visit(branch.start, branch.end, depth + 1)
      } else {
        const inner = text.slice(i + 1, close).trim()
        // `{name}` and `{name, number}` alike: a value spliced in, not a branch.
        if (inner) placeholders.push(inner.split(',')[0]!.trim())
      }
      i = close + 1
    }
  }

  visit(0, text.length, 0)
  return { arguments: args, placeholders, ok }
}

function parseArgument(text: string, open: number, close: number, depth: number): IcuArgument | null {
  const firstComma = findAtTopLevel(text, open + 1, close, ',')
  if (firstComma === -1) return null
  const secondComma = findAtTopLevel(text, firstComma + 1, close, ',')
  if (secondComma === -1) return null

  const name = text.slice(open + 1, firstComma).trim()
  const type = text.slice(firstComma + 1, secondComma).trim()
  if (!ARG_TYPES.has(type)) return null
  if (!/^[\w.$-]+$/.test(name)) return null

  const { offset, branches } = parseBranches(text, secondComma + 1, close)
  if (branches.length === 0) return null

  return { start: open, end: close + 1, name, type: type as IcuArgType, offset, branches, depth }
}

function parseBranches(
  text: string,
  from: number,
  to: number,
): { offset: number | null; branches: IcuBranch[] } {
  const branches: IcuBranch[] = []
  let offset: number | null = null
  let i = from

  while (i < to) {
    while (i < to && /\s/.test(text[i]!)) i++
    if (i >= to) break

    // `offset:1` may appear once, before the first selector.
    const off = /^offset:\s*(-?\d+)/.exec(text.slice(i, to))
    if (off && branches.length === 0) {
      offset = Number(off[1])
      i += off[0].length
      continue
    }

    const selectorStart = i
    while (i < to && !/[\s{]/.test(text[i]!)) i++
    const selector = text.slice(selectorStart, i).trim()
    if (!selector) break

    while (i < to && /\s/.test(text[i]!)) i++
    if (text[i] !== '{') break

    const close = matchBrace(text, i)
    if (close === -1 || close >= to) break

    branches.push({
      selector,
      category: isCategory(selector) ? (selector as Category) : null,
      start: i + 1,
      end: close,
      body: text.slice(i + 1, close),
    })
    i = close + 1
  }

  return { offset, branches }
}

/**
 * The matching `}` for the `{` at `open`, or -1.
 *
 * Quote handling follows ICU 4.8+: a lone apostrophe is literal UNLESS it
 * precedes a syntax character. That rule is why `l'élément` needs no escaping
 * and is not incidental here — French and Italian UI text is full of
 * apostrophes, and the older "always quoting" reading would mangle every one.
 */
export function matchBrace(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const ch = text[i]!
    if (ch === "'") {
      i = skipQuote(text, i)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

function skipQuote(text: string, at: number): number {
  if (text[at + 1] === "'") return at + 2 // '' — a literal apostrophe
  const next = text[at + 1]
  if (next !== '{' && next !== '}' && next !== '#' && next !== '|') return at + 1
  let i = at + 2
  while (i < text.length) {
    if (text[i] === "'") {
      if (text[i + 1] === "'") {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return text.length // unterminated: the remainder is quoted
}

function findAtTopLevel(text: string, from: number, to: number, char: string): number {
  let depth = 0
  let i = from
  while (i < to) {
    const ch = text[i]!
    if (ch === "'") {
      i = skipQuote(text, i)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === char && depth === 0) return i
    i++
  }
  return -1
}

// ---------------------------------------------------------------------------
// What a reader sees
// ---------------------------------------------------------------------------

/**
 * The literal text of a message: what some rendering of it can show a person.
 *
 * Argument names, types, selectors and `#` are syntax, and syntax is not
 * evidence of a language. `{gender, select, female {Kardiologin} other
 * {Kardiologe}}` holds two German words; read raw it holds `other`, which is an
 * English stopword, and a language vote over it calls a correct German catalog
 * English. So every argument contributes its branch BODIES, recursively, and
 * nothing else; a simple `{name}` contributes nothing at all, because what it
 * renders is a value supplied at runtime. Quoted ICU literals are unquoted.
 *
 * Null when the braces or quotes do not balance: nothing about such a string is
 * an ICU reading, and the caller keeps whatever it did before.
 */
export function icuLiteralText(text: string): string | null {
  if (!scanIcu(text).ok) return null
  const out: string[] = []

  const visit = (from: number, to: number, inPlural: boolean): void => {
    let i = from
    while (i < to) {
      const ch = text[i]!
      if (ch === "'") {
        const end = Math.min(skipQuote(text, i), to)
        out.push(unquote(text.slice(i, end)))
        i = end
        continue
      }
      if (ch === '#' && inPlural) {
        out.push(' ')
        i++
        continue
      }
      if (ch !== '{') {
        out.push(ch)
        i++
        continue
      }
      const close = matchBrace(text, i)
      if (close === -1 || close >= to) break
      const parsed = parseArgument(text, i, close, 0)
      out.push(' ')
      if (parsed) {
        for (const branch of parsed.branches) {
          visit(branch.start, branch.end, parsed.type !== 'select')
          out.push(' ')
        }
      }
      i = close + 1
    }
  }

  visit(0, text.length, false)
  return out.join('')
}

/** `''` is one apostrophe, and a quoted run is its content. */
function unquote(quoted: string): string {
  if (quoted === "''") return "'"
  if (quoted.length > 1 && quoted.startsWith("'")) {
    const body = quoted.endsWith("'") ? quoted.slice(1, -1) : quoted.slice(1)
    return body.replace(/''/g, "'")
  }
  return quoted
}

/**
 * The values a message RENDERS, by argument name.
 *
 * This is the placeholder contract between a source message and its
 * translation, read from the ICU arguments rather than from the text: a
 * `\{\w+\}` pattern reads a branch body like `{Arzt}` as a placeholder, and a
 * German noun becomes a variable the English source never had.
 *
 *  - `{name}` and `{name, number, …}` render their value: `{name}`.
 *  - A plural or selectordinal renders its number where a branch holds `#`, so
 *    `{count, plural, one {# item} …}` and `{count} Elemente` both render
 *    `{count}`.
 *  - A `select` renders nothing. It CHOOSES between literals, and which choices
 *    a language makes is the language's business: German inflects a job title
 *    for gender and English does not, and a target that selects on `gender`
 *    where the source has no variable is correct, not broken.
 *
 * Null when the braces or quotes do not balance.
 */
export function renderedArguments(text: string): Set<string> | null {
  const scan = scanIcu(text)
  if (!scan.ok) return null
  const out = new Set(scan.placeholders.map((p) => `{${p}}`))
  for (const argument of scan.arguments) {
    if (argument.type === 'select') continue
    if (argument.branches.some((b) => hasHash(b.body))) out.add(`{${argument.name}}`)
  }
  return out
}

/**
 * Does this branch render its plural's number?
 *
 * A `#` outside quotes does, and so does one inside a nested `select`, which
 * has no number of its own. A nested plural's `#` is that plural's.
 */
function hasHash(body: string): boolean {
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === "'") {
      i = skipQuote(body, i)
      continue
    }
    if (ch === '{') {
      const close = matchBrace(body, i)
      if (close === -1) return false
      const nested = parseArgument(body, i, close, 0)
      if (nested?.type === 'select' && nested.branches.some((b) => hasHash(b.body))) return true
      i = close + 1
      continue
    }
    if (ch === '#') return true
    i++
  }
  return false
}

/**
 * The words around a plural argument, when they can move into its branches.
 *
 * `The directory lists {count, plural, one {# specialist} other {# specialists}}
 * near {place}.` is one sentence, and planned as its branches alone the
 * translator was handed `# specialist` and the engine kept the rest as written:
 * a German catalog with English around every count. Moving the surrounding text
 * into each branch makes every form a whole sentence — the arrangement the ICU
 * user guide recommends, because word order and agreement cross the argument's
 * braces in most languages — and it renders identically.
 *
 * Only when the move is exact. The argument must be the message's one top-level
 * plural or select, and the text around it must hold no `#`, which is literal
 * outside a plural and the number inside one. Anything else returns null and
 * keeps the branch-only reading.
 */
export function sentenceAround(
  text: string,
  argument: IcuArgument,
  scan: IcuScan = scanIcu(text),
): { prefix: string; suffix: string } | null {
  if (!scan.ok || argument.depth !== 0) return null
  if (scan.arguments.some((a) => a.depth === 0 && a.start !== argument.start)) return null
  const prefix = text.slice(0, argument.start)
  const suffix = text.slice(argument.end)
  if (!(prefix + suffix).trim()) return null
  if ((prefix + suffix).includes('#')) return null
  return { prefix, suffix }
}

/**
 * The argument a family was read from, by the family's base.
 *
 * A nested argument carries its offset as `@N` on the base; a top-level one is
 * the message's first plural or selectordinal.
 */
export function argumentFor(scan: IcuScan, base: string): IcuArgument | undefined {
  const at = /@(\d+)$/.exec(base)
  return at
    ? scan.arguments.find((a) => a.start === Number(at[1]))
    : scan.arguments.find((a) => a.type !== 'select')
}

/**
 * The family's argument and the words around it, when those move into its
 * branches — what the plan hands a translator and the writer must agree on.
 */
export function icuSentence(
  text: string,
  base: string,
): { argument: IcuArgument; prefix: string; suffix: string } | null {
  const scan = scanIcu(text)
  if (!scan.ok) return null
  const argument = argumentFor(scan, base)
  if (!argument) return null
  const around = sentenceAround(text, argument, scan)
  return around ? { argument, ...around } : null
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Rebuild a plural argument from a new set of branch bodies.
 *
 * The engine writes the skeleton and the model supplies only the bodies, so a
 * target needing four branches where the source had two costs nothing
 * structural: the whole argument is one span, and this rewrites it.
 *
 * Order follows CLDR, with `=N` exact matches kept ahead of the categories
 * because ICU tries them first and a category placed before them would shadow
 * them.
 */
export function serializeArgument(
  arg: IcuArgument,
  bodies: Record<string, string>,
  order?: string[],
): string {
  const exact = Object.keys(bodies).filter((s) => s.startsWith('='))
  exact.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))

  const rest = order
    ? order.filter((s) => !s.startsWith('=') && bodies[s] !== undefined)
    : Object.keys(bodies).filter((s) => !s.startsWith('='))

  const selectors = [...exact, ...rest]
  const head = `{${arg.name}, ${arg.type}, ${arg.offset !== null ? `offset:${arg.offset} ` : ''}`
  return head + selectors.map((s) => `${s} {${bodies[s] ?? ''}}`).join(' ') + '}'
}

/** Replace character spans in a message. Descending, so offsets stay valid. */
export function splice(
  text: string,
  edits: { start: number; end: number; text: string }[],
): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start)
  let out = text
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return out
}

/**
 * Placeholders a branch body must preserve.
 *
 * `#` is the plural's own number, and dropping it produces "items" where the
 * source said "3 items" — a translation that reads fine and is wrong.
 */
export function branchPlaceholders(body: string): string[] {
  const out: string[] = []
  const scan = scanIcu(body)
  out.push(...scan.placeholders.map((p) => `{${p}}`))
  let i = 0
  while (i < body.length) {
    if (body[i] === "'") {
      i = skipQuote(body, i)
      continue
    }
    if (body[i] === '#') out.push('#')
    i++
  }
  return out.sort()
}
