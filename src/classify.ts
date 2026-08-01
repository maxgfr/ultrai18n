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
/** Template tags whose body is a stylesheet: translating it breaks the layout. */
const STYLE_TAGS = /^(css|keyframes|createGlobalStyle|injectGlobal|styled\b[\w.()'"`-]*|tw)$/
/** Template tags whose body is a wire-format document: field names, not copy. */
const CONTRACT_TAGS = /^(gql|graphql|sql|Prisma\.sql|bigquery|cypher)$/
const URL_SHAPE = /^(https?:\/\/|\/\/|\.{0,2}\/|#\/|mailto:|tel:|data:|[a-z][a-z0-9+.-]*:\/\/)/i
/**
 * A dotted, dashed or slashed lowercase token.
 *
 * `+` belongs in the separator class because a structured media-type suffix is
 * written with one. Without it `application/json` read as a slug and
 * `application/vnd.atelier+json` — the same thing in the same file — fell
 * through twelve steps to the language detector and came back as a refusal.
 */
const SLUG_SHAPE = /^[a-z0-9]+([:._+\-/][a-z0-9]+)+$/
/**
 * An IANA media type: `application/json`, `text/csv; charset=utf-8`.
 *
 * Recognised as an interop format rather than as a slug, because the reason is
 * the point — another program parses this, and `interop-format` is the label
 * that says so. Matching the slug shape would give the right verdict for the
 * wrong stated reason, which is the defect this replaces.
 */
const MEDIA_TYPE =
  /^(application|audio|font|example|image|message|model|multipart|text|video)\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;.*)?$/i
/**
 * A BCP-47 tag carrying a script or region: `fr-FR`, `zh-Hant`, `es-419`.
 *
 * The subtag is REQUIRED, and that is the whole safety of this pattern. A bare
 * `[a-z]{2,3}` matches `nom`, `les`, `oui` and `the` as readily as it matches
 * `fr`, so shape alone cannot tell a language code from a short word — and this
 * is the one rule that decides whether a value gets REWRITTEN. A bare `lang:
 * "fr"` is not lost by the narrowing: it lives in a manifest, and four catalog
 * rules already claim it by pointer, which is evidence rather than shape.
 */
const LOCALE_TAG = /^([a-z]{2,3})(?=-)(?:-([A-Z][a-z]{3}))?(?:-([A-Z]{2}|\d{3}))?$/
const ARIA_VOCAB = /^(aria-(live|current|pressed|sort|haspopup|autocomplete|relevant|orientation|expanded|hidden|checked|modal|busy|atomic|disabled|selected|multiline|readonly|required|invalid))$/
const ARIA_TEXT = /^(aria-(label|description|roledescription|valuetext|placeholder|details))$/
const TEXT_ATTRS = /^(alt|title|placeholder|label|summary|abbr|download|content|srcdoc)$/
const LABEL_KEY = /^(label|title|name|text|message|description|caption|placeholder|summary|heading|alt|tooltip|hint|prompt|subtitle|body|content)$/i
const CALENDAR_NAME = /(WEEKDAY|WEEKDAYS|DAY|DAYS|MONTH|MONTHS|QUARTER|INITIAL|ABBR|SHORT)/i
/**
 * Date/time field letters, as every formatter spells them.
 *
 * Restricted to the common subset rather than the full CLDR alphabet, which is
 * nearly every letter and would match ordinary words.
 */
const DATE_FIELD = /^[yYuMLdDEecawWkKhHmsSAzZGqQ]$/
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
    ...(raw.whyUnclaimed !== undefined ? { whyUnclaimed: raw.whyUnclaimed } : {}),
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

  // The sweep found this; no extractor understood the span it came from. It is
  // deliberately NOT given a verdict — an unclassified site fails `check` until
  // a person looks at it, which is the mechanism that makes a miss impossible
  // to ignore.
  if (raw.tier === 'sweep') {
    return { surface: 'residual.unclassified', verdict: 'unclassified', reason: 'residual', confidence: 'low' }
  }

  const matches = matchRules(rules, {
    file: raw.file,
    path: raw.path,
    value,
    attr: c.attrName,
    element: c.element,
    key,
    isKey: c.isKey,
  })

  // 0 — the host format said so.
  //
  // `<string translatable="false">` is Android's own machine-readable exception,
  // and the catalog rule for `strings.xml` says out loud that it must win over
  // any heuristic. It is checked before the rules, not after, because the rule
  // it has to beat is the file-level one that marks every string in that file
  // translatable — including a URL somebody deliberately fenced off.
  if (c.untranslatable) {
    return {
      surface: 'token.api-contract',
      verdict: 'do-not-translate',
      reason: 'explicitly-marked',
      confidence: 'high',
      hard: true,
      skipDetection: true,
    }
  }

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
    // A locale bundle answers to the locale its own PATH declares.
    //
    // The verdict here is right and stays: the TARGET locale's bundle is where
    // translations are written, and every other bundle is left alone, because a
    // bundle's locale is its path and rewriting `locales/fr/` in place would
    // destroy the source the other catalogs are diffed against.
    //
    // What was wrong is what the engine SAID. One reason covered every bundle
    // that was not the target's, so `locales/fr/common.json` on a fr→en run —
    // the source of truth — was reported as `already-target-language`, which is
    // the opposite of the situation and the one thing about it that is not so.
    if (fileLocale && fileLocale !== opts.to && ruled.emit.verdict === 'translate') {
      return {
        surface: ruled.emit.surface,
        verdict: 'do-not-translate',
        // Three cases, three names. The source's own bundle is the text
        // everything else is measured against; a third locale's is copy this
        // run has no opinion about.
        reason: fileLocale === opts.from ? 'source-locale-bundle' : 'other-locale-bundle',
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
  // A tagged template's tag says what the body IS. Without this a `css` block
  // reads as an ordinary template literal full of words, and a translated
  // stylesheet is a broken one.
  if (c.tag && STYLE_TAGS.test(c.tag)) {
    return { surface: 'token.style', verdict: 'do-not-translate', reason: 'style-token', confidence: 'high', skipDetection: true }
  }
  if (c.tag && CONTRACT_TAGS.test(c.tag)) {
    return { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'api-contract', confidence: 'high', skipDetection: true }
  }
  if (c.attrName && ARIA_VOCAB.test(c.attrName)) {
    return { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'aria-vocabulary', confidence: 'high', skipDetection: true }
  }
  // A media type is a wire format another program parses, and saying that is
  // the point. Matching it as a slug gave the right verdict for the wrong
  // stated reason — and only for the plain ones: `application/json` read as a
  // slug while `application/vnd.atelier+json`, the same thing in the same file,
  // fell through to the language detector and came back as a refusal.
  if (MEDIA_TYPE.test(value)) {
    return { surface: 'token.api-contract', verdict: 'do-not-translate', reason: 'interop-format', confidence: 'high', skipDetection: true }
  }
  if (URL_SHAPE.test(value) || (SLUG_SHAPE.test(value) && !value.includes(' '))) {
    return { surface: 'token.url-slug', verdict: 'do-not-translate', reason: 'url-or-slug', confidence: 'medium', skipDetection: true }
  }

  // 8 — test fixtures. Individually untouchable; jointly they must follow the
  // production string they mirror, which is the grouping stage's problem.
  if (c.inTest && c.callee && TEST_MATCHER.test(c.callee.split('.').pop() ?? '')) {
    return { surface: 'test.fixture', verdict: 'do-not-translate', reason: 'test-fixture', confidence: 'medium' }
  }

  // 9 — a bare single-word value in a configuration format.
  //
  // YAML and JSON are key-value: an unquoted one-word value with no catalog
  // rule behind it is an enum, a schedule, a package manager — not copy. Every
  // format whose values ARE copy (issue forms, manifests, locale bundles) has a
  // rule that already matched above, so this only ever catches the residue.
  if (
    raw.tier === 'structural' &&
    (raw.extractor === 'yaml' || raw.extractor === 'json') &&
    raw.kind !== 'comment' &&
    raw.kind !== 'block-scalar' &&
    !/[\s]/.test(value)
  ) {
    return {
      surface: 'token.api-contract',
      verdict: 'do-not-translate',
      reason: 'code-token',
      confidence: 'medium',
      skipDetection: true,
    }
  }

  // 10 — no words at all.
  if (!/\p{L}{2,}/u.test(value)) {
    // A `label` whose value has no word is still a label. Saying so out loud
    // beats being right by accident: the real risk is a model "helpfully"
    // expanding '25 / 5' to '25 min / 5 min' and breaking the layout.
    if (LABEL_KEY.test(key)) {
      return { surface: 'ui.string-literal', verdict: 'needs-judgment', reason: 'label-without-prose', confidence: 'high' }
    }
    return { surface: 'token.url-slug', verdict: 'do-not-translate', reason: 'numeric-or-symbolic', confidence: 'high', skipDetection: true }
  }

  // 11 — calendar vocabulary disguised as symbols, and its close cousin, a
  // date/time PATTERN.
  //
  // Both are locale-dependent despite looking symbolic, and both are refused
  // rather than decided: `dd/MM/yyyy` and `MM/dd/yyyy` are the same pattern in
  // two locales, so leaving it alone is as wrong as rewriting it, and only a
  // person knows which. The engine's job is to say so.
  //
  // A long pattern is the dangerous one. `'EEEE d MMMM yyyy \'à\' HH:mm'` used
  // to reach the language detector, read as French because of the quoted word
  // inside it, and come back `translate` — where a model would happily render
  // the field letters into another language and break every date on the site.
  if (isCalendarSymbol(raw) || isDatePattern(value)) {
    return { surface: 'ui.string-literal', verdict: 'needs-judgment', reason: 'symbol-set', confidence: 'high' }
  }

  // 11b — a locale tag, which is RETARGETED rather than translated.
  //
  // `'fr-FR'` in an `Accept-Language` header on a fr→en swap is the one value
  // in that file that genuinely has to change, and it used to read as
  // `ambiguous-role` — refused, so nothing broke, but by a generic hesitation
  // rather than by recognising what it is. Until now `locale-marker` was
  // reachable only through four catalog rules on manifest files, so a tag
  // sitting in ordinary code was invisible to the one verdict built for it.
  //
  // Only the SOURCE language's own tag is retargeted. A `'de-DE'` in a list of
  // supported locales is data, and rewriting it would invent a change nobody
  // asked for — so every other well-formed tag is protected instead.
  const tag = LOCALE_TAG.exec(value)
  if (tag && opts.from) {
    if (tag[1] === opts.from) {
      return { surface: 'locale.declaration', verdict: 'locale-marker', confidence: 'high', skipDetection: true }
    }
    return { surface: 'locale.declaration', verdict: 'do-not-translate', reason: 'code-token', confidence: 'medium', skipDetection: true }
  }

  const surface = surfaceFor(raw)

  // 12 — language. A cognate is a genuine ambiguity, not a missing translation.
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

/**
 * A date/time format pattern — `dd/MM/yyyy`, `EEEE d MMMM yyyy 'à' HH:mm`.
 *
 * Three conditions, and all three are load-bearing:
 *
 *  - Every character outside a quoted literal is a date field letter or a
 *    separator. Ordinary prose fails this on its first `n` or `t`.
 *  - At least two DISTINCT field letters, so `'aaa'` is not a pattern.
 *  - A pattern either SEPARATES its fields (`dd/MM/yyyy`, `hh:mm a`) or PACKS
 *    them as repeated runs (`yyyyMMdd`). Without this last condition the French
 *    words `masse`, `assez` and `Sammy` all read as patterns: they happen to be
 *    spelled entirely from field letters and to contain one doubled pair.
 *
 * Quoted literals are stripped first, because that is exactly where a formatter
 * puts the one human word a pattern may contain, and it is what let
 * `EEEE d MMMM yyyy 'à' HH:mm` read as French and come back translatable.
 *
 * What still gets through is a hyphenated token spelled entirely from field
 * letters — `AAA-SSS`. That is a product code, `needs-judgment` is the right
 * answer for one anyway, and the cost of being wrong here is one adjudication
 * rather than a corrupted format string.
 */
export function isDatePattern(value: string): boolean {
  const body = value.replace(/'[^']*'/g, '')
  if (body.trim().length < 3) return false

  const fields = new Set<string>()
  let separated = false
  for (const ch of body) {
    if (DATE_FIELD.test(ch)) fields.add(ch)
    else if (/[\s./:,\-–—[\]()+]/.test(ch)) separated = true
    else return false
  }
  if (fields.size < 2) return false
  if (!/([yYuMLdDEecawWkKhHmsSAzZGqQ])\1/.test(body)) return false
  return separated || everyCharInARun(body)
}

/** True when the string is nothing but runs of two or more identical letters. */
function everyCharInARun(body: string): boolean {
  for (let i = 0; i < body.length; ) {
    let j = i
    while (j < body.length && body[j] === body[i]) j++
    if (j - i < 2) return false
    i = j
  }
  return true
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
