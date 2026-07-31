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
import { isCategory, type Category } from './cldr'

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
