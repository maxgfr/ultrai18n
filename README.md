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

And the claim is checkable by you, not only by whoever last ran the benchmark. `sites --audit`
takes every file whose extractor recorded a `claimRatio` of 1.0 — asserting it accounted for every
byte — and asks whether any line holding text is covered by no site. The oracle is a table of
locators the extractors do not share, because asking an extractor whether it found everything is a
tautology. It is the one mode of `sites` that gates, and on its first run against this repository it
found two real holes: an inline code span that wraps a line desynchronised the markdown mask and ate
a line of prose, and a YAML flow collection was recorded as skipped and had its bytes claimed anyway.

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

Three instruments, and the first one runs on **your** repository rather than on a benchmark:

```sh
ultrai18n scan  --repo . --to fr
ultrai18n sites --repo . --audit
```

`sites --audit` takes every file whose extractor recorded a `claimRatio` of 1.0 — asserting it
accounted for every byte — and asks whether any line holding text is covered by no site. It exits 1
on a contradiction, which makes it the one mode of `sites` that gates.

The oracle is a small table of per-format locators the extractors do not share, because asking an
extractor whether it found everything is a tautology. Each row cites what it points at, and when a
row is wrong the fix is a row. Run against two real repositories — 1,128 tracked files, 1,110 of
them claiming to have read all of themselves — it returned 119 findings. **Six were the engine's and
113 were the oracle's**, and both halves were worth having:

- an inline code span that WRAPS a line desynchronised the markdown mask and ate the line below it;
- a YAML flow collection was recorded as skipped and had its bytes claimed anyway;
- `jsx_attribute` scanned its value for strings and pruned everything else, so
  `empty={<p>Aucun projet pour le moment</p>}` — real UI copy — was silently absent from a file
  reporting full coverage, with a clean parse and nothing swept.

That last one is the case for the whole approach: no gate could have caught it, because nothing was
dropped *without a reason* — it was dropped *with* one, by a branch that looked deliberate.

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
own false positives, so a hit only becomes a **confirmed miss** when the file is byte-addressable and
its `claimRatio` is 1.0 under a real extractor — meaning that extractor asserted it accounted for
every byte, and a human-looking line it never emitted contradicts a recorded claim. Everything else
is a candidate for a person. Network-dependent, so it is nightly and never a merge gate.

Accepting a changed expectation means typing its id: `bench --accept <case>:<id>` rewrites exactly
that value and records what it replaced. There is no `--update-all`. A miss found in the wild is
promoted with its provenance and a `why` starting `TODO:`, which keeps CI red until somebody writes
down what it proves — and a copyleft source gets clone-and-look instructions instead of an excerpt.

## Status

The pipeline works end to end: `scan` → `plan` → `translate` → `apply` → `verify` → `check`, plus
`plurals`, `sync`, `sites`, `lang`, `adjudicate`, `glossary`, `orchestrate` and
`init --ci --baseline`. Nothing is declared and unbuilt, and no flag is parsed and ignored.

Recall is measured rather than asserted, and the instrument ships rather than living in a benchmark.
`sites --audit` comes back clean on two real repositories — 1,110 files that claim to have read all
of themselves — and on this one. Every hole it has found is closed: hard-wrapped markdown
paragraphs, an inline `<style>` and `<script>` whose bytes were counted as read while their text
reached nothing, a wrapped code span that ate the line below it, a YAML flow collection claimed and
never entered, and a JSX attribute expression whose nested elements and comments were unreachable.

On those two repositories every single tracked file has a real reader — no path falls through to the
residual sweep — spread across markdown, TypeScript, JSON, HTML, SQL, shell, YAML, CSS, Python and
Dockerfiles.

Readers: TypeScript, JavaScript, JSX and TSX; **Python and shell on the same AST tier**, so a
docstring is the first statement of a body rather than a string that happens to come first; JSON,
JSONC, JSON5 and **JSON Lines**; YAML, including markdown nested in a block scalar; markdown; HTML,
SVG and single-file components, **whose inline `<script>` is now parsed rather than swept**; CSS;
TOML; gettext `.po`; Fluent `.ftl`; Apple `.stringsdict`, `.xcstrings` and `.plist`; Qt `.ts`;
Android `strings.xml`; Dockerfiles; **`.sql`, which earns its place by silencing rather than
finding**; and the `#`-comment ignore formats.

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

## Handing it to agents

The engine cannot spawn an agent and will not pretend to. What it does instead is make the hand-off
exact, so the same run is reproducible whether a workflow tool, a person, or a shell loop drives it:

```sh
ultrai18n scan        --repo . --to fr        # 40k sites, 463 files, audit clean
ultrai18n plan        --repo .                # 3747 groups — exits 1 on an open hazard
ultrai18n orchestrate --repo .                # emits the workflow + contract for the READY phase
ultrai18n translate   --repo . --backend subagent   # 468 batches + agents/translator.md
```

`orchestrate --list` is the part worth reading before dispatching anything. On a real repository it
comes back with `translate` **blocked**:

```
READY adjudicate       3 items
      translate      468 items   3 open hazard(s) — adjudicate them first
```

That ordering is the product, not a formality. A hazard is a text that is both a rendered label and
a persisted value; both readings are correct and one of them destroys stored data. Letting 468
translation agents run past three of those is precisely the failure this tool exists to prevent, so
the phase refuses to be ready.

Two things follow from that, and they are worth being blunt about:

- **A subagent can translate everything the engine DECIDED** — the batches are complete, each is
  eight short strings and a one-page contract, and a model never opens a source file.
- **It cannot translate what the engine REFUSED**, and that pile is large: roughly 7,800 and 10,300
  `needs-judgment` sites on the two repositories. Those do not block translation; they block
  `check`. They are the price of not guessing, and no amount of better searching reduces them —
  see `TODO.md` §2.

An agent phase that WRITES files is verified rather than trusted: `plurals --apply` and `check`'s
structural fold both re-scan and compare the result against what the agent said it did, because a
return from those phases is a claim that an edit was made rather than a decision to fold in.

## License

MIT
