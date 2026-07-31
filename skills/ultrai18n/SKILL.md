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
>    guesses here corrupts data silently.
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

## Command cheat-sheet

- `census [--repo <dir>]` — every tracked path in exactly one bucket, with a reason. Gate G1.
- `scan [--from auto] [--to en]` — build the inventory of text sites.
- `catalog --explain <file>` — which surface rules apply to a path, and why.
- `plan [--mode audit|swap|i18n|sync]` — group sites, surface hazards, emit batches.
- `translate [--backend subagent|cli|api|manual]` — hand batches out; fold results back.
- `apply [--write]` — patch by byte offset. Dry-run by default.
- `verify [--apply <verdicts.json>]` — adversarial review of what actually shipped.
- `check [--semantic]` — the six gates. Exit 1 on any failure.

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

## Status

**Working today:** the whole audit and swap pipeline — `scan`, `census`, `catalog`, `plan`,
`translate`, `apply` and the six-gate `check`. Extraction covers TypeScript/JSX/TSX through
tree-sitter, and JSON, YAML, Markdown, HTML, SVG, CSS and plain text through hand-written
byte-indexed lexers, with a residual sweep behind them so a format with no extractor surfaces as
`unclassified` rather than as nothing.

**Not built yet:** `verify` (adversarial review of what shipped), `sync` (multi-locale diffing),
`orchestrate` and `init --ci`. Each exits 1 naming what it still needs. A command that succeeds with
no findings is indistinguishable from a clean repository, and removing that confusion is the point.

On a fully French reference repository — 106 files, a pnpm monorepo with a browser extension —
`scan` finds 2956 sites across 91 files: 832 to translate, 1439 protected as identifiers, 684 handed
back for judgment, and one locale marker to retarget. Among them are the four French comments in a
stylesheet that two separate human translation passes both left behind.
