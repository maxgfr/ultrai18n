// scan: walk, extract, classify, account.
//
// Two passes, and the reason is the whole design. Classification asks questions
// like "is this value an enum member somewhere else in the repo?" — which
// cannot be answered while still reading the repo. Classifying as we go would
// make a site's verdict depend on file order, and a verdict that depends on
// file order is not a verdict.
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { walk, type WalkedFile } from './vendor/walk'
import { readTextEx, OffsetMap } from './vendor/text'
import { extractTs } from './extract/ts'
import { extractPython } from './extract/python'
import { extractShell, isCommentOnly } from './extract/shell'
import { extractSql } from './extract/sql'
import { extractJson } from './extract/json'
import { extractYaml } from './extract/yaml'
import { extractMarkdown } from './extract/markdown'
import { extractCss } from './extract/css'
import { extractHtml } from './extract/html'
import { extractText, isPlainText } from './extract/text'
import { extractPo } from './extract/po'
import { extractToml } from './extract/toml'
import { extractFtl } from './extract/ftl'
import { extractDockerfile, isDockerfile } from './extract/dockerfile'
import { isQtTranslation } from './extract/html'
import { sweepFile, merge as mergeSpans, complement } from './sweep'
import { scanPaths, pathSites } from './paths'
import { emptyTokenIndex, type RawSite, type TokenIndex } from './extract/raw'
import { prepareGrammars, parserForExt, AST_EXTENSIONS, grammarStatus } from './ast/parse'
import { classify } from './classify'
import { harmoniseBranches } from './consistency'
import { detect } from './lang/detect'
import { matchRules } from './catalog/match'
import { RULES } from './catalog/rules'
import { assembleFamilies, mergeDialects, pluralTier, type PluralDialect, type PluralFamily } from './plural'
import { evidenceFor, gatherEvidence } from './plural/dialect/evidence'
import { compileDialect } from './plural/dialect/check'
import { suspectPlurals, unclaimedSuspicions } from './plural/suspect'
import type { Advisory, CensusEntry, Inventory, Site, Span, Tier } from './types'
import { gitLsFiles } from './census'

// `.xcstrings` is JSON with an Apple extension. Without it here the file sweeps,
// its structure is lost, and a String Catalog's `variations/plural` — the one
// thing in it worth finding — is unreachable by any path-based rule.
const JSON_EXT = new Set(['.json', '.jsonc', '.json5', '.webmanifest', '.arb', '.xcstrings'])
const YAML_EXT = new Set(['.yml', '.yaml'])
const MARKDOWN_EXT = new Set(['.md', '.mdx', '.markdown'])
const CSS_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl'])
// SVG is here on purpose: it is text, and <title>/<desc> carry the accessible
// name of every icon in the interface.
// `.stringsdict` is an XML plist, so the markup scanner reads it — but only
// because that scanner now gives a plist dict a JSON Pointer. Registering the
// extension alone would have produced `string/text[7]`, a document-order index
// that says nothing about which `<key>` owns the value, which is exactly the
// information an Apple plural is made of.
const HTML_EXT = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.vue', '.svelte', '.astro', '.ejs', '.hbs', '.handlebars', '.njk', '.erb', '.twig', '.liquid', '.stringsdict'])
const PO_EXT = new Set(['.po', '.pot'])
const TOML_EXT = new Set(['.toml'])
const FTL_EXT = new Set(['.ftl'])
const SQL_EXT = new Set(['.sql', '.ddl', '.psql'])
// JSON Lines: one JSON document per line, and nothing at the file level. Split
// and route each line to the JSON reader at its own offset, which is what
// `extractYaml` already does for a block scalar's body.
const JSONL_EXT = new Set(['.jsonl', '.ndjson'])

/**
 * Which visitor reads which extension on the AST tier.
 *
 * A table rather than a switch because the three of them make the SAME
 * guarantee — reach every node, report the spans the grammar could not parse —
 * so everything around the call is shared and only the visitor differs.
 */
const VISITORS: Record<string, typeof extractTs> = {
  '.py': extractPython as typeof extractTs,
  '.pyi': extractPython as typeof extractTs,
  '.sh': extractShell as typeof extractTs,
  '.bash': extractShell as typeof extractTs,
  '.zsh': extractShell as typeof extractTs,
}

const EXTRACTOR_NAMES: Record<string, string> = {
  '.py': 'python-ast',
  '.pyi': 'python-ast',
  '.sh': 'shell-ast',
  '.bash': 'shell-ast',
  '.zsh': 'shell-ast',
}

/**
 * Which grammar reads this file, if any.
 *
 * `.gitignore`, `.dockerignore` and `.env.example` have no extension of their
 * own and are `#`-comment formats, so the shell grammar reads them — routed by
 * NAME here rather than by adding pseudo-extensions to `AST_EXTENSIONS`, which
 * would claim a grammar exists for a format nobody wrote one for.
 */
function grammarExtFor(rel: string, ext: string): string | null {
  if (AST_EXTENSIONS.has(ext)) return ext
  if (isCommentOnly(rel, ext)) return '.sh'
  return null
}

export interface ScanOptions {
  repo: string
  from?: string | null
  to?: string
  /** Skip the AST tier even when grammars are available, to exercise degradation. */
  noAst?: boolean
  /** Where plural declarations live. Defaults to `<repo>/.ultrai18n/plurals.json`. */
  pluralSidecar?: string
  /** Where project dialects live. Defaults to `<repo>/.ultrai18n/dialects.json`. */
  dialectsPath?: string
}

interface FileResult {
  file: WalkedFile
  sites: RawSite[]
  extractor: string | null
  degraded: boolean
  bytesTotal: number
  bytesClaimed: number
  /** Whether an offset into the decoded text is an offset into the file. */
  byteAddressable: boolean
  encoding: string | null
  /** Bytes of preamble the decoder stripped — 3 for a UTF-8 BOM, else 0. */
  bodyStart: number
  complete: boolean
  reason?: string
}

export async function scan(opts: ScanOptions): Promise<Inventory> {
  const { repo } = opts
  const to = opts.to ?? 'en'
  const walked = walk(repo)

  // The grammars this repository needs, by ROUTE rather than by extension: a
  // `.gitignore` has no extension and is read by the shell grammar.
  const exts = new Set(
    walked.files.map((f) => grammarExtFor(f.rel, f.ext)).filter((e): e is string => e !== null),
  )
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
  const pairs: { raw: RawSite; site: Site }[] = []
  for (const result of results) {
    for (const raw of result.sites) {
      const site = classify(raw, { from, to, tokens, fileLocale, degraded: result.degraded })
      sites.push(site)
      pairs.push({ raw, site })
    }
  }
  // Two arms of one `switch` or ternary are one editorial decision, and the
  // detector answers them independently. Runs here, on the classified sites,
  // because the disagreement is only visible once both have a verdict.
  const harmonised = harmoniseBranches(pairs)
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
  // Evidence is gathered before the dialects run, so a `declared`-strength row
  // whose dependency is absent never claims anything.
  const evidence = gatherEvidence(repo, tracked, sites)
  const project = readProjectDialects(opts.dialectsPath ?? join(repo, '.ultrai18n', 'dialects.json'))
  const catalog = mergeDialects(project)
  const inert = new Set(catalog.filter((d) => !evidenceFor(d, evidence).applies).map((d) => d.id))

  const plurals = attachPlurals(sites, {
    repo,
    to,
    from,
    dialects: project,
    inert,
    ...(opts.pluralSidecar !== undefined ? { sidecarPath: opts.pluralSidecar } : {}),
  })

  // What LOOKS like a plural and no dialect claimed. Reported on the inventory
  // so `plurals`, `dialects --propose` and the gate all read one list.
  const claimedSiteIds = new Set(plurals.flatMap((f) => f.sites))
  const claimedBases = new Set(plurals.map((f) => f.anchor))
  const pluralResidual = unclaimedSuspicions(suspectPlurals(sites), claimedSiteIds, claimedBases)

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
      ...(harmonised.lifted
        ? [
            {
              id: 'branch-sibling',
              file: null,
              message:
                `${harmonised.lifted} site(s) across ${harmonised.groups} branching construct(s) were refused by ` +
                `the language detector while a sibling arm of the same \`switch\` or ternary was accepted. They ` +
                `carry the sibling's verdict and the \`branch-sibling\` flag, at medium confidence — inherited, ` +
                `not measured. Filter on that flag to review the pass itself.`,
              sites: [],
            },
          ]
        : []),
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
    pluralResidual,
  }
}

/**
 * Project dialects, when the repository declares any.
 *
 * Regexes arrive as strings and are compiled here rather than by the caller, so
 * a row whose pattern does not compile is a `dialects --check` failure and never
 * a crash in the middle of a scan.
 */
export function readProjectDialects(path: string): PluralDialect[] {
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { dialects?: unknown[] }
    return (parsed.dialects ?? []).flatMap((d) => {
      const compiled = compileDialect(d)
      return compiled ? [compiled] : []
    })
  } catch {
    // A malformed file is reported by `dialects --check`, whose job that is.
    // Failing the scan here would make a typo in an optional file look like a
    // broken engine.
    return []
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
  opts: {
    repo: string
    to: string
    from: string | null
    sidecarPath?: string
    dialects?: PluralDialect[]
    inert?: Set<string>
  },
): PluralFamily[] {
  const sidecar = opts.sidecarPath ?? join(opts.repo, '.ultrai18n', 'plurals.json')
  const { families, memberSites, pragmaSites } = assembleFamilies({
    sites,
    targetLanguage: opts.to,
    sourceLanguage: opts.from,
    fileLocale,
    isBundle: isBundleFile,
    sidecarPath: sidecar,
    ...(opts.dialects ? { dialects: opts.dialects } : {}),
    ...(opts.inert ? { inert: opts.inert } : {}),
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

/**
 * Read markup, and sweep whatever the scanner had to read past.
 *
 * An inline `<script>` is code with no reader here, so its bytes are declared
 * UNREAD and the residual sweep covers them. Before this, they were counted as
 * claimed: a document with a French string inside a `<script>` reported
 * `claimRatio: 1` while that string reached no site and no sweep — a false
 * claim of full coverage, which is the one failure the whole accountability
 * argument rests on not making.
 */
async function markupResult(
  base: FileResult,
  file: WalkedFile,
  read: { text: string },
  map: OffsetMap,
  tokens: TokenIndex,
  opts: ScanOptions,
  extra?: { reason?: string },
): Promise<FileResult> {
  const { sites, claimedBytes, identifiers, scripts } = extractHtml(file.rel, read.text, map)
  for (const id of identifiers) tokens.identifiers.add(id)

  const fromScripts: RawSite[] = []
  const unread: Span[] = []
  for (let n = 0; n < scripts.length; n++) {
    const parsed = await readScript(file.rel, read.text, map, scripts[n]!, n, tokens, opts)
    if (parsed) fromScripts.push(...parsed)
    else unread.push({ start: map.byteOf(scripts[n]!.from), end: map.byteOf(scripts[n]!.to) })
  }

  // Whatever no reader could take is declared UNREAD, exactly as every script
  // body used to be. Listed, not claimed.
  const residual = unread.length
    ? sweepFile(file.rel, read.text, map, [...complement(mergeSpans(unread), base.bytesTotal), ...sites.map((s) => s.span)], {
        identifiers: tokens.identifiers,
        extractor: 'html',
        reason: 'inside a <script> block no reader could parse; found by the residual sweep',
      })
    : []
  const unreadBytes = unread.reduce((acc, span) => acc + (span.end - span.start), 0)

  return {
    ...base,
    sites: [...sites, ...fromScripts, ...residual].sort((a, b) => a.span.start - b.span.start),
    extractor: 'html',
    bytesClaimed: claimedBytes - unreadBytes,
    ...(unread.length ? { complete: false } : {}),
    ...(extra?.reason ? { reason: extra.reason } : {}),
  }
}

/**
 * Read one inline `<script>` body with a reader of its own.
 *
 * The markup scanner declares these UNREAD and the sweep covers them, which is
 * honest and is not finished: the strings arrive `unclassified` with no
 * container semantics, so a persisted key and a rendered label inside a
 * `<script>` are indistinguishable. That is a plumbing problem rather than a
 * lexer one — grammar loading is async and lives here, not in a synchronous
 * extractor — and this is the plumbing.
 *
 * The body is parsed as its OWN document with its own map, and every offset is
 * shifted back afterwards. Reading it in place is not an option: tree-sitter is
 * given a string, and giving it the whole file would parse the markup as
 * JavaScript.
 *
 * Returns null when no reader applies or the parse broke down, and null means
 * the caller sweeps — the same fallback as before, reached only when the better
 * answer is unavailable.
 */
async function readScript(
  file: string,
  text: string,
  map: OffsetMap,
  region: { from: number; to: number; lang: string | null },
  ordinal: number,
  tokens: TokenIndex,
  opts: ScanOptions,
): Promise<RawSite[] | null> {
  const body = text.slice(region.from, region.to)
  if (body.trim() === '') return []

  const shift = map.byteOf(region.from)
  const at = map.lineColOf(region.from)
  const local = new OffsetMap(body)

  // A `<script type="application/ld+json">` body is structured data, not code —
  // and `meta.structured-data` is a surface the catalog already names.
  if (region.lang && /json/i.test(region.lang)) {
    const { sites, keys } = extractJson(file, body, local)
    for (const k of keys) tokens.identifiers.add(k)
    return sites.map((s) => relocate(s, `script[${ordinal}]`, shift, at))
  }

  if (opts.noAst) return null
  // `lang="ts"` on a single-file component's script block is the common case,
  // and handing TypeScript to the JavaScript grammar reports it as broken.
  const ext = region.lang && /\bts|typescript\b/i.test(region.lang) ? '.ts' : '.js'
  const parser = await parserForExt(ext)
  if (!parser) return null
  const tree = parser.parse(body)
  if (!tree) return null

  const { sites, tokens: contributed, hasError } = extractTs(file, body, tree, local)
  // A broken parse here falls back to the sweep whole, rather than mixing
  // parsed sites with swept ones inside one small region: the error spans are
  // relative to the body, and the honest report for a `<script>` the grammar
  // could not read is the one this always gave.
  if (hasError) return null
  merge(tokens, contributed)
  return sites.map((s) => relocate(s, `script[${ordinal}]`, shift, at))
}

/** Move a site read out of an embedded region back onto its host's coordinates. */
function relocate(site: RawSite, prefix: string, byteShift: number, at: { line: number; col: number }): RawSite {
  return {
    ...site,
    // Prefixed so two `<script>` blocks in one document cannot share an anchor,
    // and so a script site cannot collide with a markup one.
    path: `${prefix}/${site.path}`,
    span: { start: site.span.start + byteShift, end: site.span.end + byteShift },
    valueSpan: { start: site.valueSpan.start + byteShift, end: site.valueSpan.end + byteShift },
    line: site.line + at.line - 1,
    endLine: site.endLine + at.line - 1,
    // Only the body's FIRST line is offset horizontally: it starts wherever the
    // `>` left off, and every line after it starts at column 1 of its own line.
    col: site.line === 1 ? site.col + at.col - 1 : site.col,
    endCol: site.endLine === 1 ? site.endCol + at.col - 1 : site.endCol,
  }
}

/**
 * A block scalar whose body is markdown, read as the markdown it is.
 *
 * `.github/workflows/release.yml` holds a release-notes body as `body: |` —
 * markdown that renders on a public page. Read as one block scalar it is a
 * forty-line translation unit with its links, headings and code spans unmasked;
 * read as markdown it is individually patchable prose.
 *
 * Which blocks qualify is decided by the CATALOG rather than by a list of key
 * names here. A rule already says where a release-notes body lives and cites
 * GitHub's own documentation for it, so a new host format is a new row and not
 * a new branch — and the surface is the question being asked, which is exactly
 * what `Emit.surface` records.
 */
const MARKDOWN_SURFACES = new Set(['ui.release-notes', 'doc.markdown-prose', 'doc.changelog'])

function markdownInYaml(
  file: string,
  text: string,
  map: OffsetMap,
  region: { from: number; to: number },
  path: string,
  body: string,
): RawSite[] {
  const key = path.split('/').pop() ?? ''
  const matched = matchRules(RULES, { file, path, value: body, key }).some((m) =>
    MARKDOWN_SURFACES.has(m.emit.surface),
  )
  if (!matched) return []
  // Each child keeps the HOST's pointer as its prefix, so `h3[0]` inside a
  // release-notes body anchors at `/jobs/release/steps/1/with/body/h3[0]`. Two
  // things depend on it: the catalog rule that decided the block in the first
  // place has to reach the runs it produced, and a bare `h3[0]` would collide
  // with the same heading in any other block scalar in the file.
  return extractMarkdown(file, text, map, region).sites.map((site) => ({
    ...site,
    path: `${path}/${site.path}`,
  }))
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
    byteAddressable: read.byteAddressable,
    encoding: read.encoding,
    bodyStart: read.bodyStart,
    complete: true,
  }
  if (!read.ok) return { ...base, reason: 'unreadable', complete: false }
  if (read.binary) return { ...base, reason: 'nul-byte', complete: false }
  if (read.text === '') return { ...base, extractor: 'empty', bytesClaimed: 0 }

  const map = new OffsetMap(read.text)
  const ext = file.ext

  // The one extension collision worth a content check.
  //
  // A Qt Linguist catalog and a TypeScript module genuinely share `.ts`, and
  // handing XML to the TypeScript grammar reported nineteen unparseable regions
  // and a `claimRatio` of 0 — a broken TypeScript module where there is a
  // perfectly good translation catalog. Nothing was LOST (the degraded branch
  // sweeps exactly the regions the grammar failed on, which is what it is for)
  // but nothing was understood either. Extension routing stays right for
  // everything else; this is the one case that earns a sniff.
  if (ext === '.ts' && isQtTranslation(read.text)) {
    return markupResult(base, file, read, map, tokens, opts, {
      reason: 'Qt translation catalog: routed by content, because .ts is also TypeScript',
    })
  }

  // A Dockerfile is not prose, and reading it as prose made every `RUN apt-get
  // install …` a paragraph the classifier had to talk itself out of.
  if (isDockerfile(file.rel)) {
    const { sites, keys, claimedBytes } = extractDockerfile(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'dockerfile', bytesClaimed: claimedBytes }
  }

  // An AST-eligible file enters this branch whether or not the tier is
  // available, and `--no-ast` is a way INTO it rather than around it. Skipping
  // the branch let such a file fall through to the bottom, where it was swept
  // and reported `extractor: residual-sweep, degraded: false` — a TypeScript
  // module read by no reader, described as though that were an ordinary
  // outcome. The flag's own comment says it exists "to exercise degradation",
  // and until now it exercised a different path entirely.
  const grammarExt = grammarExtFor(file.rel, ext)
  if (grammarExt) {
    const parser = opts.noAst ? null : await parserForExt(grammarExt)
    if (parser) {
      const tree = parser.parse(read.text)
      if (tree) {
        // One branch, three visitors. Which one runs is the extension's
        // business; everything below — the clean-parse claim, the error-span
        // sweep, the degradation — is identical for all of them, because the
        // guarantee each makes is the same guarantee.
        const visit = VISITORS[grammarExt] ?? extractTs
        const extractor = EXTRACTOR_NAMES[grammarExt] ?? 'ts-ast'
        const { sites, tokens: contributed, errorSpans, hasError } = visit(
          file.rel,
          read.text,
          tree,
          map,
        )
        merge(tokens, contributed)
        if (!hasError) {
          // The visitor reaches every node, so a clean parse genuinely did look
          // at every byte.
          return { ...base, sites, extractor, bytesClaimed: read.bytes }
        }
        // It did not. Sweep exactly the regions the grammar failed on, so a
        // parse that broke down halfway produces `unclassified` sites rather
        // than a thinner result reporting full coverage — the one place this
        // tier could otherwise lose text without saying so.
        const unreadable = mergeSpans(errorSpans)
        const claimed = [...complement(unreadable, read.bytes), ...sites.map((s) => s.span)]
        const residual = sweepFile(file.rel, read.text, map, claimed, {
          identifiers: tokens.identifiers,
          extractor,
          reason: `the ${grammarExt} grammar could not parse this span; found by the residual sweep`,
        })
        const unreadableBytes = unreadable.reduce((n, s) => n + (s.end - s.start), 0)
        return {
          ...base,
          sites: [...sites, ...residual].sort((a, b) => a.span.start - b.span.start),
          extractor,
          degraded: true,
          bytesClaimed: Math.max(0, read.bytes - unreadableBytes),
          complete: false,
          reason: `the ${grammarExt} grammar reported ${errorSpans.length} unparseable region(s); container semantics are unavailable there`,
        }
      }
    }
    // The AST tier is unavailable — no grammar shipped, no grammar loadable,
    // or `--no-ast`. Saying so per file was necessary and was not sufficient:
    // this branch returned ZERO sites and claimed ZERO bytes, so every string
    // in the file left the pipeline with no site, no `unclassified`, and no
    // gate. An advisory named the tier and nothing named the text. That is the
    // one failure this whole design exists to make impossible, and it was
    // reachable on any machine where a grammar failed to load.
    //
    // So the file is swept, exactly as the broken-parse branch above sweeps the
    // regions the grammar gave up on. `extractor` stays `none` on purpose:
    // `sites --audit` and `bench/sweep.mjs` both read that as "this file's
    // ratio was set, not measured", which is precisely what a 1.0 means here.
    const reason = grammarStatus().reason ?? 'no grammar for this extension'
    const residual = sweepFile(file.rel, read.text, map, [], {
      identifiers: tokens.identifiers,
      extractor: 'none',
      reason: `no ${grammarExt} parser was available (${reason}); found by the residual sweep`,
    })
    return {
      ...base,
      sites: residual,
      extractor: 'none',
      degraded: true,
      bytesClaimed: read.bytes,
      complete: false,
      reason,
    }
  }

  if (JSON_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete } = extractJson(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'json', bytesClaimed: claimedBytes, complete }
  }

  // JSON Lines. One document per line, so the file-level scanner loses sync on
  // the second one — which is why a `.jsonl` used to reach the residual sweep
  // and arrive as fragments like `"grounding\", \"author\": \"lens-A\", \"dim`.
  // Accounted for, and useless as a unit of translation.
  if (JSONL_EXT.has(ext)) {
    const sites: RawSite[] = []
    let claimed = 0
    let complete = true
    let at = 0
    let line = 0
    for (const body of read.text.split('\n')) {
      if (body.trim() !== '') {
        const out = extractJson(file.rel, body, new OffsetMap(body))
        for (const k of out.keys) tokens.identifiers.add(k)
        if (!out.complete) complete = false
        const shift = map.byteOf(at)
        const lineNo = map.lineColOf(at).line - 1
        for (const site of out.sites) {
          sites.push({
            ...site,
            // The line ordinal is part of the anchor. Without it every document
            // in the file shares `/message/text` and one translation lands on
            // another's bytes.
            path: `/line[${line}]${site.path}`,
            span: { start: site.span.start + shift, end: site.span.end + shift },
            valueSpan: { start: site.valueSpan.start + shift, end: site.valueSpan.end + shift },
            line: site.line + lineNo,
            endLine: site.endLine + lineNo,
          })
        }
        claimed += out.claimedBytes
      }
      // The newline itself is read and is not text.
      claimed += map.byteOf(Math.min(at + body.length + 1, read.text.length)) - map.byteOf(at + body.length)
      at += body.length + 1
      line++
    }
    return { ...base, sites, extractor: 'json', bytesClaimed: claimed, complete }
  }

  if (SQL_EXT.has(ext)) {
    const { sites, claimedBytes, complete } = extractSql(file.rel, read.text, map)
    return { ...base, sites, extractor: 'sql', bytesClaimed: claimedBytes, complete }
  }

  if (YAML_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete, skippedSpans } = extractYaml(
      file.rel,
      read.text,
      map,
      (region, path, body) => markdownInYaml(file.rel, read.text, map, region, path, body),
    )
    for (const k of keys) tokens.identifiers.add(k)
    // A flow collection or an alias is a construct the scanner does not enter.
    // It used to record the skip in prose and claim the bytes anyway, so a file
    // holding one reported full coverage over a value that reached no site —
    // the same false claim an inline `<script>` used to make, and the one
    // `sites --audit` found first when it was pointed at this repository.
    const residual = skippedSpans.length
      ? sweepFile(file.rel, read.text, map, [...complement(mergeSpans(skippedSpans), read.bytes), ...sites.map((s) => s.span)], {
          identifiers: tokens.identifiers,
          extractor: 'yaml',
          reason: 'a YAML flow collection or alias, which the indentation scanner does not enter; found by the residual sweep',
        })
      : []
    return {
      ...base,
      sites: [...sites, ...residual].sort((a, b) => a.span.start - b.span.start),
      extractor: 'yaml',
      bytesClaimed: claimedBytes,
      complete,
    }
  }

  if (MARKDOWN_EXT.has(ext)) {
    const { sites, claimedBytes } = extractMarkdown(file.rel, read.text, map)
    return { ...base, sites, extractor: 'markdown', bytesClaimed: claimedBytes }
  }

  if (PO_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete } = extractPo(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'po', bytesClaimed: claimedBytes, complete }
  }

  if (TOML_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete } = extractToml(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'toml', bytesClaimed: claimedBytes, complete }
  }

  if (FTL_EXT.has(ext)) {
    const { sites, keys, claimedBytes, complete } = extractFtl(file.rel, read.text, map)
    for (const k of keys) tokens.identifiers.add(k)
    return { ...base, sites, extractor: 'ftl', bytesClaimed: claimedBytes, complete }
  }

  if (CSS_EXT.has(ext)) {
    const { sites, claimedBytes, identifiers } = extractCss(file.rel, read.text, map)
    for (const id of identifiers) tokens.identifiers.add(id)
    return { ...base, sites, extractor: 'css', bytesClaimed: claimedBytes }
  }

  if (HTML_EXT.has(ext)) {
    return markupResult(base, file, read, map, tokens, opts)
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

/**
 * Claimed bytes over the bytes an extractor was actually given.
 *
 * The denominator excludes any preamble the decoder stripped, because a BOM is
 * not text and no extractor can claim it. Only called for byte-addressable
 * files; for the rest the ratio is not reported at all.
 */
function claimRatioOf(result: FileResult): number {
  const body = result.bytesTotal - result.bodyStart
  return body > 0 ? round(result.bytesClaimed / body) : 1
}

/**
 * The strongest tier that read this file.
 *
 * Declared on `CensusEntry` since the type was written and populated by
 * nobody, which made `tier` on the census a field a reader could believe in and
 * never find. Null for an empty file and for one nothing read: absent says "not
 * measured", and `structural` there would be a guess dressed as a measurement.
 */
function tierOf(result: FileResult): Tier | null {
  const extractor = result.extractor
  if (!extractor || extractor === 'empty') return null
  if (extractor.endsWith('-ast')) return 'ast'
  if (extractor === 'residual-sweep' || extractor === 'none') return 'sweep'
  return 'structural'
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
      ...(tierOf(result) ? { tier: tierOf(result)! } : {}),
      degraded: result.degraded,
      byteAddressable: result.byteAddressable,
      bytesTotal: result.bytesTotal,
      bytesClaimed: result.bytesClaimed,
      // Reported only when a decoded offset IS a file-byte offset, and
      // measured against the BODY the extractor was handed.
      //
      // Two ways this used to lie, both from dividing decoded bytes by raw
      // ones. A fully-read UTF-16 file reported 0.506 — "the extractor skipped
      // half of this" about a file it skipped none of — and a UTF-8 file with
      // a BOM reported 0.962, because the three preamble bytes are counted by
      // `bytesTotal` and stripped before the extractor ever sees them. A BOM is
      // not text an extractor can claim, so it does not belong in the
      // denominator.
      //
      // For the non-addressable case the answer is absence, not a repaired
      // number. Dividing decoded by decoded there would mint a 1.0, and `sweep`
      // reads a 1.0 as the extractor ASSERTING it accounted for every byte —
      // the one claim a file whose offsets do not address its bytes cannot
      // make. Not measured is not zero, and `runCensus` has always said so.
      ...(result.byteAddressable
        ? { claimRatio: claimRatioOf(result) }
        : {}),
      ...(result.reason
        ? { reason: result.reason }
        : result.byteAddressable
          ? {}
          : { reason: `encoding:${result.encoding}` }),
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
