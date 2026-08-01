---
name: ultrai18n
description: "Use when a repository's LANGUAGE must change and the result has to be provable, not hoped for — a full source-language swap, an i18n extraction, a locale-catalog sync, or a read-only audit. Asking an AI to 'translate this repo' silently misses package.json descriptions, web manifests inlined in a bundler config, GitHub issue templates, release-notes bodies nested in workflow YAML, and screenshots with rendered UI text; it also translates persisted enum values and breaks every existing user's stored data. ultrai18n is a deterministic zero-dep engine (node scripts/ultrai18n.mjs, no keys, no install) that inventories every text site with byte offsets, classifies it against a documented surface catalog, and gates the result: census accounts for EVERY tracked path in exactly one bucket, and check REFUSES to pass while any site is unclassified, unadjudicated, or still in the source language. The engine decides the token/identifier surfaces; YOU adjudicate the judgment calls it deliberately refuses — a text that is both a rendered label and a persisted enum is reported, never guessed. Models only ever receive {id: text} and return {id: translation}; the engine writes the files by byte offset, so a translation costs the text and not the codebase. It reads TypeScript/JSX/TSX, Python and shell on a tree-sitter AST tier, plus gettext .po/.pot, Fluent .ftl, Apple .stringsdict/.xcstrings/.plist, Qt .ts, Android strings.xml, TOML manifests, JSON Lines, .sql, Dockerfiles, ignore files and JSX/TSX/Vue/Svelte/Astro markup down to the inline <script>; sites --audit re-checks the recall claim offline so it is verifiable rather than merely asserted; and its plural handling is a cited catalog of arrangements rather than a list of supported libraries. Triggers: 'translate this repo', 'change the language of the project', 'switch from French to English', 'find all hardcoded strings', 'extract strings to i18n', 'which locale keys are missing', 'did we miss any text', 'audit this repo for untranslated strings', 'translate my .po files', 'is my Russian catalog missing plural forms'. Not a translation API and not a linter: for prose you already have, translate it yourself."
license: MIT
metadata:
  version: 0.0.0
---

# ultrai18n — find every human-readable string, and prove nothing was missed

The hard part of changing a repository's language is not translating. It is **recall**. An agent's
model of "the UI" is components plus HTML plus README, and whatever falls outside that model is
invisible — not translated badly, simply never looked at. Prompting harder does not fix a blind spot.

The opposite failure costs more. `'done'` can be a rendered label *and* a value persisted to storage
and validated by a schema. Translate the wrong one and every existing user's data stops parsing.

So the engine does the finding and the accounting, deterministically; you do the judgment it refuses
to fake; and a model does nothing but translate strings it is handed.

> **The core rules:**
>
> 1. **The claim is accountability, not omniscience.** ultrai18n does not claim to classify every
>    string correctly. It claims no byte of a scannable file leaves the pipeline unaccounted for.
>    Anything unclaimed and human-looking becomes `unclassified`, and `check` fails while one remains.
> 2. **The engine writes files. Models never do.** A translator receives `{id, text}` and returns
>    `{id, text}`. It does not open a source file, and it cannot reformat, drop, or "improve" code.
> 3. **A refusal is a result.** Where a decision needs code the engine cannot read — a dual-use
>    string, a plural baked into a ternary — it reports and blocks rather than guessing. A tool that
>    guesses here corrupts data silently. A refusal can be *answered*: an `ultrai18n:plural`
>    annotation declares in place what the engine will not infer.
> 4. **A plural is a family, not a string.** English has two forms and Russian needs four, Japanese
>    one. So the unit of work is the family, the translator is asked for exactly the categories the
>    TARGET locale selects, and the engine writes the new keys. A catalog short of a form its own
>    locale selects is a bug rendering the wrong string *today*, with nothing translated — `plurals`
>    and gate G6 both report it.
> 5. **Never translate an identifier.** Enum members, storage keys, module specifiers, API contract
>    strings, CSS tokens, URL slugs and vendored legal text are decided by the engine and are not
>    negotiable by an agent.
> 6. **Every rule cites its evidence.** A catalog rule that says "translate this" without a `docs`
>    URL is rejected by `catalog check`. A rule is documentation, not a hunch.

## Route by situation

1. **You want to know what is there, and change nothing** — run `census`, then `scan --json`, then
   read the report. Audit mode is a strict prefix of every other mode, so this is never wasted work.
2. **A tracked file is unaccounted for** — `census` failed gate G1. That is a walker or extractor
   bug, not a user error; the reason field names which.
3. **You are swapping the repository's language** — `scan` → `plan` → `translate` → `apply --write`
   → `verify` → `check --semantic`.
4. **The engine reported a hazard** — a text that is both copy and a persisted value. Run
   `adjudicate` for the worklist and the contract, dispatch an agent on it, then `adjudicate --apply
   <rulings.json>` and `plan` again. Rule per *site*, not per string: both roles are legitimate, and
   naming which site is which is the whole job. Unblocking a hazard needs a ruling for EVERY site in
   the group and every `contentHash` still matching — a stale ruling reopens it rather than
   re-anchoring silently.
5. **You want the language surface explained for one file** — `catalog --explain <file>` prints
   every rule that applies and why.
6. **The engine does not understand an arrangement** — G7 names what is plural-shaped and unclaimed.
   Run `dialects --propose`, dispatch one agent on the contract it writes, then `dialects --check`
   and `scan` again. The declaration is data: it is cached, re-runnable, and costs one row per
   library rather than one answer per key.

7. **Plurals** — run `plurals`. It exits 1 when a family lacks a form its own locale selects, which
   is a live rendering bug and worth fixing before any translation happens. Families the engine
   cannot write mechanically land in `PLURALS.todo.json` with their forms already translated; the
   `pluralist` contract turns those into a code edit.

## Command cheat-sheet

- `census [--repo <dir>]` — every tracked path in exactly one bucket, with a reason. Gate G1.
- `scan [--from auto] [--to en]` — build the inventory of text sites.
- `catalog --explain <file>` — which surface rules apply to a path, and why.
- `plan [--mode audit|swap|i18n|sync]` — group sites, surface hazards, emit batches.
- `translate [--backend subagent|cli|api|manual]` — hand batches out; fold results back.
- `apply [--write]` — patch by byte offset. Dry-run by default.
- `verify [--apply <verdicts.json>]` — adversarial review of what actually shipped.
- `check [--semantic] [--new-only] [--strict]` — the gates. Exit 1 on any failure.
  G1 census-complete · G2 no-residual · G3 no-unadjudicated · G4 source-language-clear ·
  G5 exceptions-valid · G6 coherence · G7 plurals-claimed · G8 semantic (only with `--semantic`).
- `plurals` — every plural family, what its locale selects, what it has. Exit 1 when one is short.
- `dialects [--explain <file>] [--check] [--propose]` — how this repository spells its plurals, with
  the manifest line supporting each. `--propose` writes the unclaimed sites for an agent; `--check`
  validates what it wrote. Exit 1 on any problem.
- `sync [--source-locale <lang>]` — diff locale catalogs; placeholder arity fails closed.
- `orchestrate [--phase <p>] [--list]` — emit the workflow and contracts for a phase.
- `sites [--verdict <v>] [--surface <glob>] [--file <glob>] [--rule <id>] [--ecosystem <id>]
  [--value <text>] [--dup] [--limit <n>] [--drift <inventory.json>] [--audit]` — filtered views of
  the inventory. Exit 0 even with no matches — it is a view, `check` is the gate — and exit 2 on a
  token outside a closed vocabulary, because "your repo has none of these" and "you typed something
  that does not exist" must not look alike. `--drift` reconciles against a previous inventory and
  names every anchor that moved, which is what stops a pinned exception silently ceasing to apply.
  `--audit` is the odd one out and the only mode that GATES: for every file whose extractor recorded
  a `claimRatio` of 1.0 — asserting it accounted for every byte — it asks whether any line holding
  text is covered by no site. The oracle is a table of locators the extractors do not share, because
  asking an extractor whether it found everything is a tautology. Run it when you want the recall
  claim checked rather than believed.
- `lang [--value "<text>"] [--test]` — the detector on its own. Bare, it explains the source-language
  vote `scan` took silently, weighted by letters. `--test` runs one sample per supported language and
  exits 1 on a misdetection — the only mode here that makes a claim which can be wrong.
- `adjudicate [--batch <n>] [--apply <rulings.json>]` — the hazard worklist, and the parser for what
  an adjudicator returns. Exit 1 when a ruling is refused or a group came back unseparable.
- `glossary [--seed] [--list]` — the term store. `--seed` rewrites only the generated region.
- `init --ci --baseline` — freeze today, so only new regressions block a pull request.

Global: `--quiet` prints only each command's `VERDICT` line, and never changes `--json` output, an
error, or an exit code. `apply --write` also takes `--backup` (originals under `<out>/backup/`, never
beside the source, where the next scan would read them as new sites), `--allow-dirty` and `--no-git`
— it refuses to rewrite files in place where a bad run could not be undone. There is deliberately no
`--no-sweep`: the residual sweep is what makes G2 checkable, so a run with it disabled looks clean
and proves nothing.

## Coverage

Text is found by **rule**, not by guessing which files look like UI. The catalog covers npm,
VS Code, web/PWA manifests (including one inlined in a bundler config), browser extensions,
Next.js/Nuxt/Astro/SvelteKit/Remix, GitHub issue forms and workflow prose, Docker/Compose/Helm/
Terraform, Cargo/pyproject/composer/gemspec/pubspec/pom, Android/iOS/Flutter, the major i18n
runtimes, store listings, and vendored legal text.

Markup is extracted per framework, not per file extension: JSX and TSX (including `jsx_text`, which
most string extractors miss entirely), Vue, Svelte and Astro single-file components, plain HTML,
and templating languages (ERB, Handlebars, Jinja, Blade, Liquid). Framework interpolation
(`{{ msg }}`, `{msg}`, `${x}`) becomes a placeholder the translator may reorder but may not drop.

Text nests, and so do the readers. An inline `<style>` goes to the stylesheet reader, so a
`content:` value is found; a raw HTML block inside markdown goes to the markup reader, so the
`<img alt>` in the banner at the top of a README and every `<summary>` are found; a release-notes
body inside a workflow YAML is read as the markdown it is; an inline `<script>` goes to the AST
tier, and a `type="application/ld+json"` body to the JSON reader. Where no reader can take it —
a grammar that is unavailable, a parse that broke down — the bytes are declared UNREAD rather than
counted as claimed, and the residual sweep covers them. That distinction is the whole product: an
extractor that reads past text while reporting full coverage is worse than one that admits it
stopped.

**Plurals are read by arrangement, and the arrangements are DATA.** Three mechanical primitives
live in the engine — one form per site with the category on its anchor path, every form in one value
split by a delimiter, and every form in one value read by a real parser. Everything else is a row in
a catalog: `dialects` lists them, each citing the runtime's own documentation, exactly as a surface
rule does. i18next, Rails, ICU, Fluent, Android, vue-i18n, Polyglot, Symfony intervals, gettext, Qt,
Apple String Catalogs and `.stringsdict` are twelve rows and two grammars, not twelve detectors.
Categories come from `Intl.PluralRules`, so any BCP-47 tag works and no language list is baked in.

Exactly two grammars ship, and that is the boundary the design is honest about: ICU and Fluent both
select with a syntax that no table of separators can read. Everything else is a row, and most new
runtimes cost nothing at all.

**A dialect a repository needs and the catalog does not have is DECLARED, not coded.** `dialects
--propose` writes what no dialect claimed, plus the repository's own evidence — its declared
dependencies, its imports — and an agent writes `.ultrai18n/dialects.json`. `dialects --check` then
refuses a row that cites no documentation, claims nothing in this repository, or silently re-reads a
family that already worked. Gate **G7** fails while anything plural-shaped is unclaimed, so the loop
ends rather than being trusted.

A rule baked into an expression is still declared in place, because no catalog can read one:

```js
// ultrai18n:plural count=n one="One item in your cart" other="{0} items in your cart"
const label = `${n} item${n > 1 ? 's' : ''} in your cart`
```

Formats without comments use `.ultrai18n/plurals.json`, keyed by `siteKey`. Both channels accept
`write`, `keyTemplate` and `category`; the default is decided by the FORMAT, so a declaration landing
on a JSON or YAML scalar is inserted like any detected family rather than deferred to a code edit.

## Scope notes

- **Determinism is a product guarantee.** Same repo, same inventory, byte for byte. No timestamps in
  the inventory, no RNG in sampling, no locale-dependent formatting.
- **Byte offsets, never character offsets.** Mixing the two is silent corruption on any file with an
  accented character. Files that are not UTF-8 are inventoried but refused by `apply` rather than
  patched at a plausible-looking wrong offset.
- **Stated limits**, also emitted under `limits` in every `--json` payload: text rendered into
  images, video or PDF is listed and never claimed; text computed at runtime with no literal is not
  detectable; dependencies and text living outside the repo are out of scope; short strings are
  routed to judgment rather than guessed, because `"OK"`, `"Menu"` and `"Format"` are genuinely
  ambiguous across languages; and the gate catches "still in the source language", never
  "translated badly".
- **Plural limits.** New forms are written only into JSON and YAML locale bundles, as a sibling of a
  key that is already there. Android XML, `.stringsdict`, `.xcstrings` and any rule living in an
  expression are reported with their translated forms and left to a code edit — a plural is a
  call-site decision, and a tool that rewrites call sites is no longer patching bytes. Fluent is the
  exception and earns it: a select expression is rewritten in place, because en→ru turns two variants
  into four inside a single value and no delimiter join can do that. gettext and Qt keep the source's
  arity (they are `cldr: false`), so every form already exists and is replaced at its own byte
  offset.
- **A dialect cannot invent a reader, so the readers were written.** gettext `.po`/`.pot`, Fluent
  `.ftl`, Apple `.stringsdict` and Qt's `.ts` are read, and each is claimed by a cited row. The
  principle stands and is why they had to be built: a row cannot claim what was never parsed, so a
  format with no extractor is not a missing row, it is a missing reader. gettext's honest limit
  survives: `Plural-Forms:` is a C expression this engine does not evaluate, so an index there is a
  POSITION — index 1 of a three-form Polish catalog is "the second form", never `few` — and such a
  family is `cldr: false` and never measured for completeness. That is a smaller claim than the one
  made for i18next, and it is the true one. Qt's `.ts` is reached by sniffing `<!DOCTYPE TS>` before
  the extension routes it to the TypeScript grammar: the one extension collision worth a content
  check.
- **Evidence is presence, never usage.** `i18next` in `package.json` proves the dependency is
  installed, not that the file in front of you is one of its bundles. Two dialects claiming one site
  resolve by declared precedence, then by id — determinism, not correctness.
- **`dialects --check` verifies the shape of a citation, not the citation.** No network, ever. A
  well-formed URL to a page that does not exist passes, and the only thing between that and a shipped
  lie is a human reading the diff.
- **Positional and ordinal families are never measured against CLDR.** vue-i18n's pipes, Polyglot's
  `||||` and gettext's indices answer to their own runtime, and an ordinal family answers to the
  ordinal rule set where English has four forms and its cardinals have two.
- **The dialectician sees strings.** Its worklist carries residual values and sibling values, because
  an arrangement is not recognisable from a path alone. It still never opens a file and the sample is
  bounded and deterministic, but "the model only ever sees `{id, text}`" is now true of the
  translator rather than of every agent in the pipeline.
- **`claimRatio` is a measurement, and an absent one is not a zero.** A ratio below 1 means the
  extractor genuinely did not account for part of the file — never that the file held an accented
  character, and never that a BOM or a `<script>` body was counted against it. Anything unclaimed is
  swept, so the shortfall shows up as `unclassified` rather than as silence. For a file whose
  decoded offsets are not file-byte offsets (UTF-16, latin1) the ratio is **not reported at all**,
  because the repair that looks obvious — dividing decoded by decoded — mints a 1.0, and a 1.0 is
  read downstream as the extractor ASSERTING it accounted for every byte. That is the single claim
  such a file cannot make.

## Status

Every command in the cheat-sheet works. There are no declared-but-unbuilt commands and no flags that
are parsed and ignored.

Extraction covers TypeScript, JSX/TSX, **Python and shell** through tree-sitter — so a Python
docstring is the first statement of a body rather than a string that happens to come first — and
JSON, JSON Lines, YAML, Markdown, HTML, SVG, CSS, TOML, gettext `.po`, Fluent `.ftl`, Apple
property lists, **`.sql`**, Dockerfiles, the `#`-comment ignore formats and plain text through
hand-written byte-indexed lexers. A residual sweep sits behind all of them, so a format with no
extractor surfaces as `unclassified` rather than as nothing.

`.sql` is the one reader that earns its place by SILENCING rather than finding: it reads the
comments and claims the DDL as looked-at and non-textual, which turns hundreds of refusals into
none.

Recall is measured, not asserted — and the instrument SHIPS, so you can re-measure rather than
trust a number. `sites --audit` runs the same check offline against your own repository and comes
back clean on this project across 201 files that claim to have read all of themselves.

Every hole that measurement has found is closed: hard-wrapped markdown paragraphs, where only the
last line of each block reached the inventory; inline `<style>` and `<script>`, whose bytes were
counted as read while their text reached nothing; an inline code span that WRAPS a line, which
desynchronised the markdown mask and ate the line below it; and a YAML flow collection, recorded as
skipped and claimed anyway.

**The model, the endpoint and the key are all configurable, and the default tier is SMALL.** Eight
short strings and a one-page contract per batch is not work a frontier model does better, and paying
frontier prices per batch is how a cheap operation becomes an expensive one.

```sh
ultrai18n translate --backend api                       # anthropic, claude-haiku-4-5
ultrai18n translate --backend api --provider openai     # openai, gpt-4o-mini
ultrai18n translate --backend api --provider openai --model <any>
ultrai18n translate --backend api --provider openai-compatible \
  --endpoint http://localhost:11434/v1/chat/completions --model qwen2.5:3b
```

Precedence is `--flag` > `ULTRAI18N_*` env > `.ultrai18n/config.json` > the provider preset, and the
resolved settings are PRINTED with their source before a single request is sent. The two wire formats
differ in where the system prompt goes, what the token cap is called and where the answer sits; the
provider row carries all three, so pointing at an OpenAI-compatible gateway is one flag rather than a
400 that reads like a bad key. A localhost endpoint needs no key at all.

Backends: `--translator '<command>'` (batch JSON on stdin, result JSON on stdout — ollama, a Python
script, anything), `--backend api` (direct HTTP on `fetch`, key from the environment), and
`--backend manual`. `--backend subagent` writes the batches and the agent contract and hands over,
because the engine cannot spawn a Claude Code agent and will not pretend to.

Paths are a surface too: a filename written in the source language is found, its referrers are
resolved, and it is **reported rather than renamed** — a rename that misses one referrer is a broken
build, and no static tool can prove it found the last one.

Two sites may never share an anchor, because a shared anchor is a shared site id and `apply`
resolves a translation through it — one translation would land on another site's bytes. An anonymous
node (a comment, a union member, an import specifier, a statement in a function body) is anchored by
its POSITION in its container, emitted in place of the name it does not have; named paths are
untouched. Where even that is not enough, the later sites are suffixed `~n` and the collision is
reported.

On a fully French reference repository — 106 files, a pnpm monorepo with a browser extension —
`scan` finds 2956 sites across 91 files: 832 to translate, 1439 protected as identifiers, 684 handed
back for judgment, and one locale marker to retarget. Among them are the four French comments in a
stylesheet that two separate human translation passes both left behind.
