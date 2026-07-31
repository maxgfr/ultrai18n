// scan: walk, extract, classify, account.
//
// Two passes, and the reason is the whole design. Classification asks questions
// like "is this value an enum member somewhere else in the repo?" — which
// cannot be answered while still reading the repo. Classifying as we go would
// make a site's verdict depend on file order, and a verdict that depends on
// file order is not a verdict.
import { extname, join } from 'node:path'
import { walk, type WalkedFile } from './vendor/walk'
import { readTextEx, OffsetMap } from './vendor/text'
import { extractTs } from './extract/ts'
import { extractJson } from './extract/json'
import { extractYaml } from './extract/yaml'
import { extractMarkdown } from './extract/markdown'
import { extractCss } from './extract/css'
import { extractHtml } from './extract/html'
import { extractText, isPlainText } from './extract/text'
import { sweepFile, merge as mergeSpans, complement } from './sweep'
import { scanPaths, pathSites } from './paths'
import { emptyTokenIndex, type RawSite, type TokenIndex } from './extract/raw'
import { prepareGrammars, parserForExt, AST_EXTENSIONS, grammarStatus } from './ast/parse'
import { classify } from './classify'
import { detect } from './lang/detect'
import { matchRules } from './catalog/match'
import { RULES } from './catalog/rules'
import { assembleFamilies, pluralTier, type PluralFamily } from './plural'
import type { Advisory, CensusEntry, Inventory, Site } from './types'
import { gitLsFiles } from './census'

const JSON_EXT = new Set(['.json', '.jsonc', '.json5', '.webmanifest', '.arb'])
const YAML_EXT = new Set(['.yml', '.yaml'])
const MARKDOWN_EXT = new Set(['.md', '.mdx', '.markdown'])
const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl'])
// SVG is here on purpose: it is text, and <title>/<desc> carry the accessible
// name of every icon in the interface.
const HTML_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.vue', '.svelte', '.astro', '.ejs', '.hbs', '.handlebars', '.njk', '.erb', '.twig', '.liquid'])

export interface ScanOptions {
  repo: string
  from?: string | null
  to?: string
  /** Skip the AST tier even when grammars are available, to exercise degradation. */
  noAst?: boolean
  /** Where plural declarations live. Defaults to `<repo>/.ultrai18n/plurals.json`. */
  pluralSidecar?: string
}

interface FileResult {
  file: WalkedFile
  sites: RawSite[]
  extractor: string | null
  degraded: boolean
  bytesTotal: number
  bytesClaimed: number
  complete: boolean
  reason?: string
}

export async function scan(opts: ScanOptions): Promise<Inventory> {
  const { repo } = opts
  const to = opts.to ?? 'en'
  const walked = walk(repo)

  const exts = new Set(walked.files.map((f) => f.ext))
  if (!opts.noAst) await prepareGrammars(exts)

  // Pass 1 — extract, and merge every file's contribution to the cross-reference
  // indexes.
  const tokens: TokenIndex = emptyTokenIndex()
  const results: FileResult[] = []

  for (const file of walked.files) {
    results.push(await extractFile(file, tokens, opts))
  }

  // Two sites may not share an anchor. See disambiguatePaths — this runs
  // before classification because the site id is derived from the anchor.
  let collisions = 0
  for (const result of results) collisions += disambiguatePaths(result.sites)

  // Pass 2 — classify against the now-complete indexes.
  const from = opts.from === 'auto' || opts.from === undefined ? inferSourceLanguage(results, to) : opts.from
  const sites: Site[] = []
  for (const result of results) {
    for (const raw of result.sites) {
      sites.push(classify(raw, { from, to, tokens, fileLocale }))
    }
  }
  sites.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.span.start - b.span.start,
  )

  // Paths are text too. The reference repository renamed reglages.png to
  // settings.png as part of its language change, and a tool that treats every
  // path as an untouchable slug reports that repository as clean.
  const tracked = gitLsFiles(repo) ?? walked.files.map((f) => f.rel)
  if (from && from !== to) {
    sites.push(
      ...pathSites(
        scanPaths({ repo, files: tracked, from, to, identifiers: tokens.identifiers }),
        to,
      ),
    )
  }

  sites.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.span.start - b.span.start,
  )
  linkDuplicates(sites)

  // Pass 3 — plural families, which are cross-site by nature: `item_one` and
  // `item_other` are one unit of work living at two sites, and neither of them
  // means anything on its own.
  const plurals = attachPlurals(sites, {
    repo,
    to,
    from,
    ...(opts.pluralSidecar !== undefined ? { sidecarPath: opts.pluralSidecar } : {}),
  })

  return {
    schemaVersion: 1,
    repo,
    sourceLanguage: from,
    targetLanguage: to,
    sites,
    census: buildCensus(repo, walked, results),
    advisories: [
      ...advisoriesFor(results, sites),
      ...pluralAdvisories(plurals),
      ...(collisions
        ? [
            {
              id: 'anchor-collision',
              file: null,
              message:
                `${collisions} site(s) shared an anchor with another site and were suffixed \`~n\` to keep their ` +
                `ids distinct. The suffix is stable for a given file but shifts if a sibling is inserted above, ` +
                `so an exception pinned to one of these is worth re-checking. Anonymous nodes are already ` +
                `anchored by position, so reaching this means a construct the anchor grammar cannot name at all.`,
              sites: [],
            },
          ]
        : []),
    ],
    limits: LIMITS,
    recallClaim: 'full',
    plurals,
  }
}

/**
 * Force every site in a file onto a distinct anchor.
 *
 * Returns how many moves were SURPRISING — a key sharing its own value's
 * pointer is expected and silent.
 *
 * Two sites sharing an anchor share a site id, and a site id is what `apply`
 * resolves a translation against — with a Map, so the last one wins and the
 * other's translation lands on the wrong bytes. `identity.ts` has always said
 * this must not happen and shipped `disambiguate` to prevent it; nothing ever
 * called it, and the collisions are not rare. Four sites in one small file
 * share an anchor today: `anchorPath` promises statement ordinals inside a
 * function body and does not emit them, and a JSON key sits on the same
 * pointer as its own value.
 *
 * The VALUE keeps the bare path rather than whichever site came first. `sync`
 * and the plural shapes both read a key name straight out of the pointer, and
 * a `~2` buried in the middle of one would make `item_one` unrecognisable as a
 * plural form.
 */
export function disambiguatePaths(sites: RawSite[]): number {
  const byPath = new Map<string, RawSite[]>()
  for (const site of sites) {
    const list = byPath.get(site.path)
    if (list) list.push(site)
    else byPath.set(site.path, [site])
  }

  const taken = new Set(byPath.keys())
  let surprising = 0
  for (const group of byPath.values()) {
    if (group.length < 2) continue
    const ordered = [...group].sort(
      (a, b) => Number(a.kind === 'key') - Number(b.kind === 'key') || a.span.start - b.span.start,
    )
    // A key and its own value share a JSON Pointer by construction — the
    // pointer names the pair. That is resolved here and NOT reported: an
    // advisory that fires on every object in every repository is one people
    // learn to scroll past, which costs more than it saves. What is worth
    // reporting is an anchor grammar that could not tell two real sites apart.
    const structural = group.length === 2 && group.filter((s) => s.kind === 'key').length === 1
    for (const site of ordered.slice(1)) {
      let n = 2
      while (taken.has(`${site.path}~${n}`)) n++
      const next = `${site.path}~${n}`
      taken.add(next)
      site.path = next
      if (!structural) surprising++
    }
  }
  return surprising
}

/**
 * Is this file a locale catalog?
 *
 * The weaker shapes need this context and would be unusable without it: a key
 * ending in `_one` is a plural form in a message bundle and a coincidence
 * anywhere else, and `'Save | Cancel'` is a vue-i18n plural only if it is
 * sitting in a vue-i18n catalog.
 */
export function isBundleFile(file: string): boolean {
  if (fileLocale(file) !== null) return true
  return matchRules(RULES, { file, path: '', value: '' }).some((m) => m.rule.ecosystem === 'i18n')
}

function attachPlurals(
  sites: Site[],
  opts: { repo: string; to: string; from: string | null; sidecarPath?: string },
): PluralFamily[] {
  const sidecar = opts.sidecarPath ?? join(opts.repo, '.ultrai18n', 'plurals.json')
  const { families, memberSites, pragmaSites } = assembleFamilies({
    sites,
    targetLanguage: opts.to,
    sourceLanguage: opts.from,
    fileLocale,
    isBundle: isBundleFile,
    sidecarPath: sidecar,
  })

  const byId = new Map(sites.map((s) => [s.id, s]))
  for (const [siteId, member] of memberSites) {
    const site = byId.get(siteId)
    if (!site) continue
    site.plural = { familyId: member.familyId, category: member.category, shape: '' }
  }
  for (const family of families) {
    for (const id of family.sites) {
      const site = byId.get(id)
      if (!site?.plural) continue
      site.plural.shape = family.shape
      // The surface exists to make a plural findable as a plural: `sites
      // --surface i18n.plural-family` is how an agent asks the question, and a
      // form indistinguishable from any other bundle string cannot answer it.
      site.surface = 'i18n.plural-family'
      if (family.declaredBy === 'annotation') site.decidedBy = 'inline-pragma'
    }
  }

  // The pragma comment is a directive addressed to this tool. Translating it
  // would be absurd, and leaving it as prose puts it in a batch.
  for (const id of pragmaSites) {
    const site = byId.get(id)
    if (!site) continue
    site.verdict = 'do-not-translate'
    site.reason = 'explicitly-marked'
    site.decidedBy = 'inline-pragma'
  }

  return families
}

function pluralAdvisories(families: PluralFamily[]): Advisory[] {
  const out: Advisory[] = []

  const tier = pluralTier()
  if (tier.tier !== 'icu' && families.length > 0) {
    out.push({ id: 'degraded-plural-tier', file: null, message: tier.reason ?? '', sites: [] })
  }

  // The finding worth more than anything the translation half of this tool
  // does: a bundle that renders the wrong string today, with nothing
  // translated and no locale added.
  const broken = families.filter((f) => f.missing.length > 0 || f.extra.length > 0)
  if (broken.length) {
    out.push({
      id: 'plural-incomplete',
      file: broken[0]!.file,
      message:
        `${broken.length} plural family(ies) do not have the forms their own locale requires. This is a live ` +
        `rendering bug rather than a missing translation: ${broken
          .slice(0, 3)
          .map((f) => `${f.file}#${f.base} (${f.locale ?? '?'} needs ${f.ownRequired?.join(', ') ?? '?'}, has ${f.sourceCategories.join(', ')})`)
          .join('; ')}.`,
      sites: broken.flatMap((f) => f.sites).slice(0, 10),
    })
  }

  return out
}

async function extractFile(file: WalkedFile, tokens: TokenIndex, opts: ScanOptions): Promise<FileResult> {
  const read = readTextEx(file.abs)
  const base = {
    file,
    sites: [] as RawSite[],
    extractor: null as string | null,
    degraded: false,
    bytesTotal: read.bytes,
    bytesClaimed: 0,
    complete: true,
  }
  if (!read.ok) return { ...base, reason: 'unreadable', complete: false }
  if (read.binary) return { ...base, reason: 'nul-byte', complete: false }
  if (read.text === '') return { ...base, extractor: 'empty', bytesClaimed: 0 }

  const map = new OffsetMap(read.text)
  const ext = file.ext

  if (!opts.noAst && AST_EXTENSIONS.has(ext)) {
    const parser = await parserForExt(ext)
    if (parser) {
      const tree = parser.parse(read.text)
      if (tree) {
        const { sites, tokens: contributed, errorSpans, hasError } = extractTs(
          file.rel,
          read.text,
          tree,
          map,
        )
        merge(tokens, contributed)
        if (!hasError) {
          // The visitor reaches every node, so a clean parse genuinely did look
          // at every byte.
          return { ...base, sites, extractor: 'ts-ast', bytesClaimed: read.bytes }
        }
        // It did not. Sweep exactly the regions the grammar failed on, so a
        // parse that broke down halfway produces `unclassified` sites rather
        // than a thinner result reporting full coverage — the one place this
        // tier could otherwise lose text without saying so.
        const unreadable = mergeSpans(errorSpans)
        const claimed = [...complement(unreadable, read.bytes), ...sites.map((s) => s.span)]
        const residual = sweepFile(file.rel, read.text, map, claimed, {
          identifiers: tokens.identifiers,
          extractor: 'ts-ast',
          reason: `the ${ext} grammar could not parse this span; found by the residual sweep`,
        })
        const unreadableBytes = unreadable.reduce((n, s) => n + (s.end - s.start), 0)
        return {
          ...base,
          sites: [...sites, ...residual].sort((a, b) => a.span.start - b.span.start),
          extractor: 'ts-ast',
          degraded: true,
          bytesClaimed: Math.max(0, read.bytes - unreadableBytes),
          complete: false,
          reason: `the ${ext} grammar reported ${errorSpans.length} unparseable region(s); container semantics are unavailable there`,
        }
      }
    }
    // The AST tier is unavailable. Say so per file rather than quietly
    // producing a thinner result that reads identically.
    return {
      ...base,
      extractor: 'none',
      degraded: true,
      reason: grammarStatus().reason ?? 'no grammar for this extension',
    }
  }

  if (JSON_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete } = extractJson(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'json', bytesClaimed: claimedBytes, complete }
  }

  if (YAML_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete } = extractYaml(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'yaml', bytesClaimed: claimedBytes, complete }
  }

  if (MARKDOWN_EXT.has(ext)) {
    const { sites, claimedBytes } = extractMarkdown(file.rel, read.text, map)
    return { ...base, sites, extractor: 'markdown', bytesClaimed: claimedBytes }
  }

  if (CSS_EXT.has(ext)) {
    const { sites, claimedBytes, identifiers } = extractCss(file.rel, read.text, map)
    for (const id of identifiers) tokens.identifiers.add(id)
    return { ...base, sites, extractor: 'css', bytesClaimed: claimedBytes }
  }

  if (HTML_EXT.has(ext)) {
    const { sites, claimedBytes, identifiers } = extractHtml(file.rel, read.text, map)
    for (const id of identifiers) tokens.identifiers.add(id)
    return { ...base, sites, extractor: 'html', bytesClaimed: claimedBytes }
  }

  if (isPlainText(file.rel, ext)) {
    const { sites, claimedBytes } = extractText(file.rel, read.text, map)
    return { ...base, sites, extractor: 'text', bytesClaimed: claimedBytes }
  }

  // No extractor for this format. NOT silently clean: the residual sweep reads
  // the whole file and forces anything human-looking into the inventory as
  // `unclassified`, which fails `check` until somebody looks at it.
  //
  // Files that DO have an extractor are not swept: those extractors scan the
  // whole file and assert that what they did not emit, they looked at and
  // judged non-textual. That assertion is what `claimRatio` records.
  const residual = sweepFile(file.rel, read.text, map, [], {
    identifiers: tokens.identifiers,
    extractor: 'none',
    reason: `no extractor for ${ext || 'extensionless file'}; found by the residual sweep`,
  })
  return {
    ...base,
    sites: residual,
    extractor: 'residual-sweep',
    bytesClaimed: read.bytes,
    reason: `no extractor for ${ext || 'extensionless file'}`,
  }
}

function merge(into: TokenIndex, from: ReturnType<typeof extractTs>['tokens']): void {
  for (const [k, v] of from.enums) into.enums.set(k, [...(into.enums.get(k) ?? []), ...v])
  for (const [k, v] of from.compared) into.compared.set(k, [...(into.compared.get(k) ?? []), ...v])
  for (const [k, v] of from.persisted) into.persisted.set(k, [...(into.persisted.get(k) ?? []), ...v])
  for (const id of from.identifiers) into.identifiers.add(id)
}

/**
 * Read the locale a file's own path declares.
 *
 * `locales/fr/common.json` full of French is correct, not a missed
 * translation. Without this, every gate on an already-internationalised repo is
 * a wall of false failures — and a tool that cries wolf on a correct repo does
 * not get used on an incorrect one.
 */
export function fileLocale(file: string): string | null {
  const patterns = [
    /(?:^|\/)(?:locales?|i18n|lang|langs|translations|messages)\/([a-z]{2}(?:[-_][A-Z]{2})?)(?:\/|\.)/,
    /(?:^|\/)_locales\/([a-z]{2}(?:[-_][A-Z]{2})?)\//,
    /(?:^|\/)(?:locales?|i18n|lang|messages)\/([a-z]{2}(?:[-_][A-Z]{2})?)\.(?:json|ya?ml|arb|ftl|po)$/,
    /(?:^|\/)res\/values-([a-z]{2})\//,
    /(?:^|\/)([a-z]{2})\.lproj\//,
  ]
  for (const re of patterns) {
    const m = re.exec(file)
    if (m) return m[1]!.split(/[-_]/)[0]!
  }
  return null
}

/**
 * The repo's dominant language, weighted by how much text each site carries.
 *
 * Weighting matters: a hundred one-word labels should not outvote the README.
 * Long strings are both more numerous in prose and far more reliably detected.
 */
function inferSourceLanguage(results: FileResult[], to: string): string | null {
  const weights = new Map<string, number>()
  for (const result of results) {
    for (const raw of result.sites) {
      const guess = detectFor(raw)
      if (!guess) continue
      weights.set(guess.lang, (weights.get(guess.lang) ?? 0) + guess.weight)
    }
  }
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1])
  const top = ranked[0]
  if (!top) return null
  // If the repo already reads as the target language, there is no source to
  // swap FROM, and saying `en -> en` would be nonsense.
  return top[0] === to && ranked.length === 1 ? top[0] : top[0]
}

function detectFor(raw: RawSite): { lang: string; weight: number } | null {
  const guess = detect(raw.value)
  if (!guess.detected || guess.confidence < 0.6) return null
  return { lang: guess.detected, weight: guess.letters }
}

/** Same text at several sites must end up with one translation. */
function linkDuplicates(sites: Site[]): void {
  const byDup = new Map<string, Site[]>()
  for (const site of sites) {
    if (site.verdict !== 'translate') continue
    const list = byDup.get(site.dupKey)
    if (list) list.push(site)
    else byDup.set(site.dupKey, [site])
  }
  for (const group of byDup.values()) {
    if (group.length < 2) continue
    const [first, ...rest] = group
    for (const site of rest) {
      site.links.duplicateOf = first!.id
      first!.links.mirrors.push(site.id)
    }
  }
}

function buildCensus(
  repo: string,
  walked: ReturnType<typeof walk>,
  results: FileResult[],
): CensusEntry[] {
  const tracked = gitLsFiles(repo)
  const byFile = new Map(results.map((r) => [r.file.rel, r]))
  const entries: CensusEntry[] = []

  const denominator = tracked ?? results.map((r) => r.file.rel)
  for (const rel of denominator) {
    const result = byFile.get(rel)
    if (!result) {
      const skipped = walked.skipped.find((s) => s.rel === rel)
      const dir = walked.skippedDirs.find((d) => rel.startsWith(d.rel + '/'))
      entries.push({
        file: rel,
        bucket: 'skipped',
        reason: skipped?.reason ?? dir?.reason ?? 'unaccounted',
        mustVerifyManually: skipped?.textBearing ?? false,
      })
      continue
    }
    entries.push({
      file: rel,
      bucket: result.sites.length > 0 ? 'scanned' : 'scanned-zero',
      sites: result.sites.length,
      extractors: result.extractor ? [result.extractor] : [],
      degraded: result.degraded,
      bytesTotal: result.bytesTotal,
      bytesClaimed: result.bytesClaimed,
      claimRatio: result.bytesTotal ? round(result.bytesClaimed / result.bytesTotal) : 1,
      ...(result.reason ? { reason: result.reason } : {}),
    })
  }
  entries.sort((a, b) => (a.file < b.file ? -1 : 1))
  return entries
}

/**
 * Findings that belong to no single site.
 *
 * The most consequential ones often have no location: "this repo formats dates
 * by hand with no Intl" is true of a module and false of every line in it.
 * Without this channel it cannot be said at all, and a per-site tool reports a
 * clean run on a repo it cannot actually localize.
 */
function advisoriesFor(results: FileResult[], sites: Site[]): Advisory[] {
  const out: Advisory[] = []

  const hasIntl = results.some((r) => r.sites.some((s) => /\bIntl\./.test(s.raw)))
  const timeWords = sites.filter((s) =>
    /\b(minute|minutes|hour|hours|day|days|ago|just now|less than)\b/i.test(s.value),
  )
  if (!hasIntl && timeWords.length >= 3) {
    out.push({
      id: 'no-intl',
      file: timeWords[0]!.file,
      message:
        'Dates and durations are formatted by hand with no Intl usage. Translating these strings does not localize the logic: plural rules, weekday order and 12/24-hour time stay as they are.',
      sites: timeWords.slice(0, 10).map((s) => s.id),
    })
  }

  const degraded = results.filter((r) => r.degraded && r.extractor !== 'ts-ast')
  if (degraded.length) {
    out.push({
      id: 'degraded-tier',
      file: null,
      message: `${degraded.length} file(s) were read without the AST tier, so key-versus-value and enum detection were unavailable for them. Their verdicts are weaker, and that is recorded per file in the census.`,
      sites: [],
    })
  }

  // A parse that broke down is a different failure from no parser at all, and
  // it is the one worth naming: the file LOOKS fully covered, and the only
  // thing separating it from a silent miss is that its claimRatio is now honest.
  const unparsed = results.filter((r) => r.degraded && r.extractor === 'ts-ast')
  if (unparsed.length) {
    out.push({
      id: 'ast-parse-error',
      file: unparsed[0]!.file.rel,
      message:
        `${unparsed.length} file(s) hit syntax the shipped grammar could not parse. Those regions were swept for ` +
        `text instead of being claimed, so their claimRatio is below 1 and anything human-looking in them is in ` +
        `the inventory as unclassified. Usually this means a language feature newer than the grammar.`,
      sites: [],
    })
  }

  const noExtractor = results.filter((r) => r.extractor === 'none' && !r.degraded)
  if (noExtractor.length) {
    out.push({
      id: 'no-extractor',
      file: null,
      message: `${noExtractor.length} file(s) have no extractor yet (${[...new Set(noExtractor.map((r) => r.file.ext || 'no extension'))].sort().join(', ')}). They are listed in the census rather than counted as clean.`,
      sites: [],
    })
  }

  return out
}

const LIMITS = [
  'Text rendered into images, video or PDF is listed as unscannable and never claimed.',
  'Text computed at runtime with no literal in the source cannot be detected.',
  'Dependencies and text living outside the repository are out of scope.',
  'Files above the size cap or excluded by .gitignore are listed with a reason, not read.',
  'Languages outside the fourteen shipped profiles return no detection and are routed to judgment.',
  'Strings under eight letters are routed rather than guessed: "OK" is a word in eight of these languages.',
  'The gate catches "still in the source language", never "translated badly".',
]

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
