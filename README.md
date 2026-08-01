# ultrai18n

Find every human-readable string in a repository, classify it, translate it with cheap models, and
prove nothing was missed.

## Why

Asking an AI to "change the language of this repo" fails silently. It translates the React
components and the README, then misses `package.json`'s `description`, the web app manifest inlined
in `vite.config.ts`, the GitHub issue templates, the release-notes body nested inside a workflow
YAML, the screenshots with rendered UI text, and the file of comments nobody opened. The failure is
not translation quality — it is **recall**. The miss is in what was never looked at, and prompting
harder does not fix that.

The opposite failure costs more. Translate a string that happens to be a persisted enum value and
every existing user's data stops parsing. Translate a CSV column header and you break an export
format other tools depend on. Translate a test fixture that exists to exercise quote escaping and
the test still passes while testing nothing.

ultrai18n is built to be right in both directions, and to be checkable rather than trusted.

## The claim

It does **not** claim to classify every string correctly. It claims:

> No byte of any scannable, decodable, tracked file leaves the pipeline unaccounted for, and every
> tracked path lands in exactly one census bucket.

"We found every string" is unfalsifiable. "Nothing was dropped without a recorded reason" is a gate
that fails loudly. Anything unclaimed and human-looking is forced into the inventory as
`unclassified`, and `check` refuses to pass while one remains.

## How it works

A deterministic zero-dependency engine finds and classifies the text; a model only ever translates
short strings it is handed, and never touches a file:

```
engine  →  { "u:7f21c9": "Yes, erase it all" }
model   →  { "u:7f21c9": "Oui, tout effacer" }
engine  →  writes apps/web/.../DataSection.tsx at bytes 4187-4204
           ✓ 412/412 applied, 0 drift
```

The model never opens a source file. That keeps the cost proportional to the text rather than the
codebase, and removes any opportunity to reformat, drop or "improve" surrounding code.

## Install

```sh
npx skills add maxgfr/ultrai18n            # this project
npx skills add maxgfr/ultrai18n --global   # every project
```

No build step, no API key, no network. The tree-sitter grammars ship with the engine.

## Plurals

English has two plural forms, Russian needs four, Japanese one. So a plural cannot be one string in
and one string out, and the unit of work is the **family**: every form goes to the translator at
once, along with exactly the categories the target locale selects, and the engine writes back the
keys that did not exist before.

Arrangements are **data, not code**. Three mechanical primitives live in the engine — one form per
site with the category on its anchor path, every form in one value split by a delimiter, every form
in one value read by a real parser — and each library is a row in a catalog that cites its own
documentation. i18next, Rails, ICU, Android, vue-i18n, Polyglot and Apple String Catalogs are seven
rows, not seven detectors.

When a repository uses an arrangement the catalog does not have, the engine says so and a model
declares it:

```
engine  →  G7: 2 sites look like a plural and no dialect claimed them
           evidence: node-polyglot (package.json:14)
model   →  .ultrai18n/dialects.json  { "primitive": "value-split", "delimiters": ["||||"], … }
engine  →  dialects --check ✓   scan → 2 families, each citing that row
```

The model writes a **declaration**, never an answer. That is what makes the result cacheable and
re-runnable, and what keeps the cost proportional to the number of libraries rather than the number
of keys. `dialects --check` rejects a row that cites no documentation, claims nothing in this
repository, or silently re-reads a family that already worked — the last one being the check that
protects a repository that already works.

Categories come from `Intl.PluralRules`, so any BCP-47 tag works. A rule baked into an expression is
still declared where it lives, because no catalog can read one:

```js
// ultrai18n:plural count=n one="One item in your cart" other="{0} items in your cart"
const label = `${n} item${n > 1 ? 's' : ''} in your cart`
```

The most useful output needs no translation at all. `plurals` exits 1 when a catalog is short of a
form its own locale selects — a Russian bundle with only `one` and `other` renders the wrong string
for 2, 3 and 4 right now, in production.

## Measuring it

`pnpm bench` runs a corpus of small repositories with hand-written ground truth, and its report is
committed — so every change in what the tool finds arrives as a reviewable prose diff, whether or not
it crossed a threshold.

The headline number is deliberately **not** recall. `found / hand_listed` makes the denominator one
author's guess about what exists, which is the unfalsifiable claim this project rejects. What is
falsifiable is accounting: every declared region is covered by a site, and every tracked path is in
one census bucket. Precision is gated harder than recall, and for a concrete reason — a miss in a
file with no extractor is already caught by the residual sweep and G2, while a false `translate` on a
persisted enum is caught by nothing, and G4 will actively demand it be translated.

`pnpm sweep` is the other half: it clones real repositories, has `codeindex` locate plural and
surface sites from patterns alone, and reports what ultrai18n did not claim. A grep oracle has its
own false positives, so a hit only becomes a **confirmed miss** when the file's `claimRatio` is 1.0
under a real extractor — meaning that extractor asserted it accounted for every byte, and a
human-looking line it never emitted contradicts a recorded claim. Everything else is a candidate for
a person. Network-dependent, so it is nightly and never a merge gate.

## Status

The pipeline works end to end: `scan` → `plan` → `translate` → `apply` → `verify` → `check`, plus
`plurals`, `sync`, `orchestrate` and `init --ci --baseline`.

Translation backends: a generic CLI (`--translator '<command>'`), direct HTTP (`--backend api`), and
manual. The API backend is fully configurable — `--provider anthropic|openai|openai-compatible`,
`--model`, `--endpoint`, `--key-env`, `--max-tokens`, overridable by `ULTRAI18N_*` environment
variables and by `.ultrai18n/config.json`, resolved settings printed with their source before
anything is sent. Every preset defaults to its provider's SMALL tier, and a localhost endpoint needs
no key, so a local model is one flag away. `--backend subagent` writes the batches and the agent contract and hands over, because the
engine cannot spawn a Claude Code agent and will not pretend to.

On a fully French reference repository, `scan` finds 2956 text sites across 91 files and separates
them into what to translate, what is an identifier and must not be touched, and what it refuses to
decide. Among the finds are four French comments in a stylesheet that two separate human translation
passes both missed.

## License

MIT
