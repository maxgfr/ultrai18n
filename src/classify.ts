// The classification cascade.
//
// First match wins, and the order is the argument: identifier positions are
// settled before anything looks at the words, because a string that is compared
// or persisted is not copy no matter how much it reads like a sentence. The
// language detector runs LAST, on what is left.
//
// Where two rules both apply and disagree in kind rather than in degree, the
// engine does not pick. It reports. A text that is both a rendered label and a
// persisted enum value has two correct answers and one of them destroys user
// data; guessing there is worse than stopping.
import type { DoNotTranslateReason, NeedsJudgmentReason, Site, Surface, Verdict } from './types'
import type { RawSite, TokenIndex } from './extract/raw'
import type { Rule } from './catalog/types'
import { matchRules } from './catalog/match'
import { RULES } from './catalog/rules'
import { detect, isCognate, type Lang } from './lang/detect'
import { contentHash, dupKey, siteId, anchor } from './identity'

export interface ClassifyOptions {
  from: string | null
  to: string
  tokens: TokenIndex
  rules?: Rule[]
  /** Locale a file's path declares, e.g. `locales/fr/common.json` — French there is correct. */
  fileLocale?: (file: string) => string | null
}

const STYLE_ATTRS = /^(className|class|style|part|slot|data-[\w-]+|key|ref|id|htmlFor|for|name|type|role)$/
const STYLE_CALLEES = /^(clsx|cn|classNames|cva|tw|twMerge|styled)$/
const URL_SHAPE = /^(https?:\/\/|\/\/|\.{0,2}\/|#\/|mailto:|tel:|data:|[a-z][a-z0-9+.-]*:\/\/)/i
const SLUG_SHAPE = /^[a-z0-9]+([:._\-/][a-z0-9]+)+$/
const ARIA_VOCAB = /^(aria-(live|current|pressed|sort|haspopup|autocomplete|relevant|orientation|expanded|hidden|checked|modal|busy|atomic|disabled|selected|multiline|readonly|required|invalid))$/
const ARIA_TEXT = /^(aria-(label|description|roledescription|valuetext|placeholder|details))$/
const TEXT_ATTRS = /^(alt|title|placeholder|label|summary|abbr|download|content|srcdoc)$/
const LABEL_KEY = /^(label|title|name|text|message|description|caption|placeholder|summary|heading|alt|tooltip|hint|prompt|subtitle|body|content)$/i
const CALENDAR_NAME = /(WEEKDAY|WEEKDAYS|DAY|DAYS|MONTH|MONTHS|QUARTER|INITIAL|ABBR|SHORT)/i
const TEST_MATCHER = /^(toBe|toEqual|toContain|toMatch|toHaveTextContent|toHaveAttribute|toMatchObject|getByRole|getByText|getByLabelText|getByTitle|getByPlaceholderText|findByRole|findByText|queryByText|getByTestId)$/

export function classify(raw: RawSite, opts: ClassifyOptions): Site {
  const rules = opts.rules ?? RULES
  const c = raw.container
  const siteKey = anchor(raw.file, raw.path)
  const fileLocale = opts.fileLocale?.(raw.file) ?? null

  const decided = decide(raw, opts, rules, fileLocale)

  const lang = decided.skipDetection
    ? {
        detected: null,
        confidence: 0,
        method: 'none' as const,
        signals: ['not detected: verdict decided structurally'],
        alternatives: [],
        letters: 0,
        bucket: 'none' as const,
        mixed: false,
        inheritedFrom: null,
      }
    : detect(raw.value, opts.from ? { candidates: candidatesFor(opts.from, opts.to) } : {})

  return {
    id: siteId(siteKey),
    siteKey,
    contentHash: contentHash(raw.value),
    dupKey: dupKey(raw.value),
    file: raw.file,
    line: raw.line,
    col: raw.col,
    endLine: raw.endLine,
    endCol: raw.endCol,
    span: raw.span,
    valueSpan: raw.valueSpan,
    raw: raw.raw,
    value: raw.value,
    quote: raw.quote,
    escapes: raw.escapes,
    asciiOnlyFile: false,
    holes: raw.holes,
    ...(raw.prefix !== undefined ? { prefix: raw.prefix } : {}),
    ...(raw.suffix !== undefined ? { suffix: raw.suffix } : {}),
    ...(raw.linePrefix !== undefined ? { linePrefix: raw.linePrefix } : {}),
    kind: raw.kind,
    surface: decided.surface,
    verdict: decided.verdict,
    reason: decided.reason ?? null,
    decidedBy: 'engine',
    confidence: decided.confidence,
    rule: decided.rule ?? null,
    hard: decided.hard ?? false,
    extractor: raw.extractor,
    tier: raw.tier,
    degraded: raw.tier === 'regex',
    lang,
    flags: decided.flags ?? [],
    constraints: {
      maxLength: decided.maxLength ?? null,
      mustKeepHoles: raw.holes.map((h) => h.index),
    },
    evidence: {
      nearestComment: c.nearestComment ?? null,
      siblingKeys: c.siblingKeys ?? [],
      enumOrigins: opts.tokens.enums.get(raw.value) ?? [],
    },
    links: {
      duplicateOf: null,
      producedBy: null,
      pairedTests: [],
      mirrors: [],
      resolvedFrom: null,
      parentSiteId: null,
    },
  }
}

interface Decision {
  surface: Surface
  verdict: Verdict
  reason?: DoNotTranslateReason | NeedsJudgmentReason
  confidence: 'high' | 'medium' | 'low'
  rule?: string
  hard?: boolean
  flags?: string[]
  maxLength?: number
  /** Structural verdicts do not need the detector, and running it would only add noise. */
  skipDetection?: boolean
}

function decide(raw: RawSite, opts: ClassifyOptions, rules: Rule[], fileLocale: string | null): Decision {
  const c = raw.container
  const value = raw.value
  const key = raw.path.split('/').pop() ?? ''

  const matches = matchRules(rules, {
    file: raw.file,
    path: raw.path,
    value,
    attr: c.attrName,
    element: c.element,
    key,
    isKey: c.isKey,
  })

  // 1 — hard catalog rules (vendored legal). No agent verdict overrides these.
  const hard = matches.find((m) => m.emit.hard)
  if (hard) {
    return {
      surface: hard.emit.surface,
      verdict: hard.emit.verdict,
      reason: hard.emit.reason,
      confidence: 'high',
      rule: hard.rule.id,
      hard: true,
      skipDetection: true,
    }
  }

  // 2 — a grammar rule baked into an interpolation. The target language may
  // need a different NUMBER of agreement sites, so no translated string can be
  // correct here; it needs a code edit. Refusing early keeps it out of every
  // batch rather than letting it look translatable.
  if (raw.holes.some((h) => h.grammar)) {
    return { surface: 'ui.template-literal', verdict: 'needs-judgment', reason: 'grammar-hole', confidence: 'high' }
  }

  // 3 — identifier positions, proved by the AST rather than guessed from shape.
  if (c.moduleSpecifier) {
    return { surface: 'identifier.binding', verdict: 'do-not-translate', reason: 'module-specifier', confidence: 'high', skipDetection: true }
  }
  if (c.isKey) {
    return { surface: 'identifier.object-key', verdict: 'do-not-translate', reason: 'identifier', confidence: 'high', skipDetection: true }
  }

  // 3 — compared, not rendered. The strongest single signal that a string is a
  // token: code that tests a value for equality is not showing it to anyone.
  if (c.compared) {
    return { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'api-contract', confidence: 'high', skipDetection: true }
  }

  // 4 — persisted. Getting this wrong costs users their stored data.
  if (c.persisted) {
    return { surface: 'token.storage-key', verdict: 'do-not-translate', reason: 'persisted-value', confidence: 'high', skipDetection: true }
  }

  // 5 — enum member, and the dual-use hazard.
  const enumOrigins = opts.tokens.enums.get(value) ?? []
  if (c.enumMember) {
    return { surface: 'token.enum-member', verdict: 'do-not-translate', reason: 'enum-member', confidence: 'high', skipDetection: true }
  }
  if (enumOrigins.length > 0 && looksRendered(raw) && /\p{L}{2,}/u.test(value)) {
    // The same text is a persisted enum somewhere and a rendered label here.
    // Both readings are correct and one of them silently invalidates stored
    // data, so the engine refuses and hands over the evidence.
    return { surface: 'ui.string-literal', verdict: 'needs-judgment', reason: 'dual-use', confidence: 'high' }
  }

  // 6 — catalog rules.
  const ruled = matches.find((m) => !m.emit.hard)
  if (ruled) {
    // A locale bundle already in its own language is correct as it stands.
    if (fileLocale && fileLocale !== opts.to && ruled.emit.verdict === 'translate') {
      return {
        surface: ruled.emit.surface,
        verdict: 'do-not-translate',
        reason: 'already-target-language',
        confidence: 'high',
        rule: ruled.rule.id,
        skipDetection: true,
      }
    }
    return {
      surface: ruled.emit.surface,
      verdict: ruled.emit.verdict,
      reason: ruled.emit.reason,
      confidence: 'high',
      rule: ruled.rule.id,
      flags: ruled.emit.flags,
      maxLength: ruled.emit.maxLength,
      skipDetection: ruled.emit.verdict !== 'translate',
    }
  }

  // 7 — style, URL and ARIA vocabulary, by shape.
  if (c.attrName && STYLE_ATTRS.test(c.attrName)) {
    return { surface: 'token.style', verdict: 'do-not-translate', reason: 'style-token', confidence: 'high', skipDetection: true }
  }
  if (c.callee && STYLE_CALLEES.test(c.callee)) {
    return { surface: 'token.style', verdict: 'do-not-translate', reason: 'style-token', confidence: 'medium', skipDetection: true }
  }
  if (c.attrName && ARIA_VOCAB.test(c.attrName)) {
    return { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'aria-vocabulary', confidence: 'high', skipDetection: true }
  }
  if (URL_SHAPE.test(value) || (SLUG_SHAPE.test(value) && !value.includes(' '))) {
    return { surface: 'token.url-slug', verdict: 'do-not-translate', reason: 'url-or-slug', confidence: 'medium', skipDetection: true }
  }

  // 8 — test fixtures. Individually untouchable; jointly they must follow the
  // production string they mirror, which is the grouping stage's problem.
  if (c.inTest && c.callee && TEST_MATCHER.test(c.callee.split('.').pop() ?? '')) {
    return { surface: 'test.fixture', verdict: 'do-not-translate', reason: 'test-fixture', confidence: 'medium' }
  }

  // 9 — no words at all.
  if (!/\p{L}{2,}/u.test(value)) {
    // A `label` whose value has no word is still a label. Saying so out loud
    // beats being right by accident: the real risk is a model "helpfully"
    // expanding '25 / 5' to '25 min / 5 min' and breaking the layout.
    if (LABEL_KEY.test(key)) {
      return { surface: 'ui.string-literal', verdict: 'needs-judgment', reason: 'label-without-prose', confidence: 'high' }
    }
    return { surface: 'token.url-slug', verdict: 'do-not-translate', reason: 'numeric-or-symbolic', confidence: 'high', skipDetection: true }
  }

  // 10 — calendar vocabulary disguised as symbols.
  if (isCalendarSymbol(raw)) {
    return { surface: 'ui.string-literal', verdict: 'needs-judgment', reason: 'symbol-set', confidence: 'high' }
  }

  const surface = surfaceFor(raw)

  // 11 — language. A cognate is a genuine ambiguity, not a missing translation.
  const lang = detect(value, opts.from ? { candidates: candidatesFor(opts.from, opts.to) } : {})
  if (lang.detected && lang.detected === opts.to && lang.confidence >= 0.7) {
    return { surface, verdict: 'do-not-translate', reason: 'already-target-language', confidence: 'medium' }
  }
  if (lang.detected === null && !isCognate(value)) {
    return { surface, verdict: 'needs-judgment', reason: lang.bucket === 'short' ? 'short-string' : 'ambiguous-role', confidence: 'low' }
  }
  if (lang.detected && opts.from && lang.detected === opts.from) {
    return { surface, verdict: 'translate', confidence: 'high' }
  }

  return { surface, verdict: 'needs-judgment', reason: 'no-rule', confidence: 'low' }
}

/** Would this string plausibly reach a screen? */
function looksRendered(raw: RawSite): boolean {
  const c = raw.container
  if (raw.kind === 'jsx-text') return true
  if (c.attrName && (ARIA_TEXT.test(c.attrName) || TEXT_ATTRS.test(c.attrName))) return true
  if (c.enclosingSymbol && /^(format|label|render|display|describe|title|text|message)/i.test(c.enclosingSymbol)) {
    return true
  }
  return false
}

/**
 * Seven or twelve short strings in one array is calendar vocabulary.
 *
 * `['M','T','W','T','F','S','S']` reads as symbols and is not: those are
 * English weekday initials, and French needs `['L','M','M','J','V','S','D']`.
 * A rule that only asks "does this have letters" gets it exactly backwards.
 */
function isCalendarSymbol(raw: RawSite): boolean {
  if (raw.value.length > 3) return false
  const match = /\/\[(\d+)\]$/.exec(raw.path)
  if (!match) return false
  const binding = raw.container.enclosingSymbol ?? ''
  return CALENDAR_NAME.test(binding)
}

function surfaceFor(raw: RawSite): Surface {
  switch (raw.kind) {
    case 'jsx-text': return 'ui.jsx-text'
    case 'attr': return 'ui.attribute-text'
    case 'template': return 'ui.template-literal'
    case 'comment': return raw.raw.startsWith('/*') ? 'comment.block' : 'comment.line'
    case 'block-scalar':
    case 'prose-run': return 'doc.markdown-prose'
    case 'key': return 'identifier.object-key'
    case 'scalar': return 'ui.string-literal'
    default: return 'ui.string-literal'
  }
}

/**
 * Narrow the detector to the pair actually in play.
 *
 * Deciding "French or English" is a far easier question than "which of fourteen
 * languages", and on short UI strings the difference between the two is the
 * difference between an answer and a refusal.
 */
function candidatesFor(from: string, to: string): Lang[] {
  const set = new Set<string>([from, to, 'en'])
  return [...set] as Lang[]
}
