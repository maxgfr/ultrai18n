---
name: ultrai18n
description: "Use when a repository's LANGUAGE must change and the result has to be provable, not hoped for — a full source-language swap, an i18n extraction, a locale-catalog sync, or a read-only audit. Asking an AI to 'translate this repo' silently misses package.json descriptions, web manifests inlined in a bundler config, GitHub issue templates, release-notes bodies nested in workflow YAML, and screenshots with rendered UI text; it also translates persisted enum values and breaks every existing user's stored data. ultrai18n is a deterministic zero-dep engine (node scripts/ultrai18n.mjs, no keys, no install) that inventories every text site with byte offsets, classifies it against a documented surface catalog, and gates the result: census accounts for EVERY tracked path in exactly one bucket, and check REFUSES to pass while any site is unclassified, unadjudicated, or still in the source language. The engine decides the token/identifier surfaces; YOU adjudicate the judgment calls it deliberately refuses — a text that is both a rendered label and a persisted enum is reported, never guessed. Models only ever receive {id: text} and return {id: translation}; the engine writes the files by byte offset, so a translation costs the text and not the codebase. Triggers: 'translate this repo', 'change the language of the project', 'switch from French to English', 'find all hardcoded strings', 'extract strings to i18n', 'which locale keys are missing', 'did we miss any text', 'audit this repo for untranslated strings'. Not a translation API and not a linter: for prose you already have, translate it yourself."
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
> 6. **A plural is a family, not a string.** English has two forms and Russian needs four, Japanese
>    one. So the unit of work is the family, the translator is asked for exactly the categories the
>    TARGET locale selects, and the engine writes the new keys. A catalog short of a form its own
>    locale selects is a bug rendering the wrong string *today*, with nothing translated — `plurals`
>    and gate G6 both report it.
> 4. **Never translate an identifier.** Enum members, storage keys, module specifiers, API contract
>    strings, CSS tokens, URL slugs and vendored legal text are decided by the engine and are not
>    negotiable by an agent.
> 5. **Every rule cites its evidence.** A catalog rule that says "translate this" without a `docs`
>    URL is rejected by `catalog check`. A rule is documentation, not a hunch.

## Route by situation

1. **You want to know what is there, and change nothing** — run `census`, then `scan --json`, then
   read the report. Audit mode is a strict prefix of every other mode, so this is never wasted work.
2. **A tracked file is unaccounted for** — `census` failed gate G1. That is a walker or extractor
   bug, not a user error; the reason field names which.
3. **You are swapping the repository's language** — `scan` → `plan` → `translate` → `apply --write`
   → `verify` → `check --semantic`.
4. **The engine reported a hazard** — a text that is both copy and a persisted value. Adjudicate it
   per *site*, not per string. Both roles are legitimate; one of them has to be renamed.
5. **You want the language surface explained for one file** — `catalog --explain <file>` prints
   every rule that applies and why.
6. **Plurals** — run `plurals`. It exits 1 when a family lacks a form its own locale selects, which
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
- `check [--semantic] [--new-only]` — the six gates. Exit 1 on any failure.
- `plurals` — every plural family, what its locale selects, what it has. Exit 1 when one is short.
- `sync [--source-locale <lang>]` — diff locale catalogs; placeholder arity fails closed.
- `orchestrate [--phase <p>] [--list]` — emit the workflow and contracts for a phase.
- `init --ci --baseline` — freeze today, so only new regressions block a pull request.

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

**Plurals are read by arrangement, not by library.** Five shapes, and no dependency on any i18n
runtime: the category appended to a key (`item_one` — i18next, Rails, anything hand-rolled), the
categories as sibling keys (`item: { one, other }`), an ICU argument
(`{n, plural, one {…} other {…}}` — react-intl, FormatJS, ARB), a quantity attribute
(Android `<plurals>`), and pipe-separated positional forms (vue-i18n). Categories come from
`Intl.PluralRules`, so any BCP-47 tag works and no language list is baked in. Anything none of that
covers is declared in place:

```js
// ultrai18n:plural count=n one="One item in your cart" other="{0} items in your cart"
const label = `${n} item${n > 1 ? 's' : ''} in your cart`
```

Formats without comments use `.ultrai18n/plurals.json`, keyed by `siteKey`.

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
  key that is already there. Android XML, `.stringsdict` and any rule living in an expression are
  reported with their translated forms and left to a code edit — a plural is a call-site decision,
  and a tool that rewrites call sites is no longer patching bytes. gettext `msgid_plural` and Apple
  `.stringsdict` have no reader yet: listed, not claimed. Ordinal families and vue-i18n's positional
  forms are translated and preserved but never measured against CLDR, because neither follows it.
- **`claimRatio` is a measurement, in bytes, on both sides.** A ratio below 1 means the extractor
  genuinely did not account for part of the file, never that the file contained an accented
  character. Anything it did not claim is swept, so the shortfall shows up as `unclassified` rather
  than as silence.

## Status

Every command in the cheat-sheet works, plus `plurals`, `sync`, `orchestrate` and `init`.

Extraction covers TypeScript/JSX/TSX through tree-sitter, and JSON, YAML, Markdown, HTML, SVG, CSS
and plain text through hand-written byte-indexed lexers, with a residual sweep behind them so a
format with no extractor surfaces as `unclassified` rather than as nothing.

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
