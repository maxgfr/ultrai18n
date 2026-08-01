# ultrai18n

Find every human-readable string in a repository, classify it, translate it with cheap models, and
prove nothing was missed.

```sh
npx skills add maxgfr/ultrai18n            # this project
npx skills add maxgfr/ultrai18n --global   # every project
```

No build step, no API key, no network. The tree-sitter grammars ship with the engine.

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

## Using it

```sh
ultrai18n scan   --repo . --to fr    # inventory every text site, with byte offsets
ultrai18n sites  --repo . --audit    # prove nothing was missed  (exits 1 on a contradiction)
ultrai18n check  --repo .            # the gates: G1…G8
```

That is the read-only audit, and it is a strict prefix of every other mode. To actually swap a
language, continue: `plan` → `translate` → `apply --write` → `verify` → `check --semantic`.

## Proving it

Three instruments, and the first runs on **your** repository rather than on a benchmark.

**`sites --audit`** takes every file whose extractor recorded a `claimRatio` of 1.0 — asserting it
accounted for every byte — and asks whether any line holding text is covered by no site. The oracle
is a small table of per-format locators the extractors do not share, because asking an extractor
whether it found everything is a tautology. Each row cites what it points at, and when a row is
wrong the fix is a row.

Pointed at two real repositories — 1,128 tracked files, 1,110 of them claiming to have read all of
themselves — it returned 119 findings: six the engine's, 113 the oracle's. Both halves were worth
having, and the engine's were these:

- an inline code span that WRAPS a line desynchronised the markdown mask and ate the line below it;
- a YAML flow collection was recorded as skipped and had its bytes claimed anyway;
- `jsx_attribute` scanned its value for strings and pruned everything else, so
  `empty={<p>Aucun projet pour le moment</p>}` — real UI copy — was silently absent from a file
  reporting full coverage, with a clean parse and nothing swept.

That last one is the case for the whole approach. No gate could have caught it: nothing was dropped
*without* a reason, it was dropped *with* one, by a branch that looked deliberate. All three are
closed, and both repositories now come back clean with every tracked file read by a real reader —
nothing falls through to the residual sweep.

**`pnpm bench`** runs a corpus of small repositories with hand-written ground truth, and its report
is committed — so every change in what the tool finds arrives as a reviewable prose diff, whether or
not it crossed a threshold. The headline number is deliberately **not** recall: `found / hand_listed`
makes the denominator one author's guess about what exists, which is the unfalsifiable claim this
project rejects. What is falsifiable is accounting. Precision is gated harder than recall, and for a
concrete reason — a miss in a file with no extractor is already caught by the residual sweep and G2,
while a false `translate` on a persisted enum is caught by nothing, and G4 will actively demand it
be translated.

Accepting a changed expectation means typing its id: `bench --accept <case>:<id>` rewrites exactly
that value and records what it replaced. There is no `--update-all`.

**`pnpm sweep`** clones real repositories, has `codeindex` locate plural and surface sites from
patterns alone, and reports what ultrai18n did not claim. A grep oracle has its own false positives,
so a hit only becomes a **confirmed miss** when the file is byte-addressable and its `claimRatio` is
1.0 under a real extractor. Everything else is a candidate for a person. Network-dependent, so it is
nightly and never a merge gate.

## What it reads

TypeScript, JavaScript, JSX and TSX; **Python and shell on the same AST tier**, so a docstring is
the first statement of a body rather than a string that happens to come first; JSON, JSONC, JSON5
and JSON Lines; YAML, including markdown nested in a block scalar; markdown; HTML, SVG and
single-file components, down to the inline `<script>`; CSS; TOML; gettext `.po`; Fluent `.ftl`;
Apple `.stringsdict`, `.xcstrings` and `.plist`; Qt `.ts`; Android `strings.xml`; Dockerfiles;
`.sql`; and the `#`-comment ignore formats.

`.sql` is the one reader that earns its place by **silencing** rather than finding: it reads the
comments and claims the DDL as looked-at and non-textual, which turns hundreds of refusals into
none.

Text nests, and so do the readers. An inline `<style>` goes to the stylesheet reader; a raw HTML
block inside markdown goes to the markup reader, so the `<img alt>` in a README banner is found; a
release-notes body inside a workflow YAML is read as the markdown it is; a `<script>` goes to the
AST tier, and a `type="application/ld+json"` body to the JSON reader.

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

## Handing it to agents

The engine cannot spawn an agent and will not pretend to. What it does instead is make the hand-off
exact, so the same run is reproducible whether a workflow tool, a person, or a shell loop drives it:

```sh
ultrai18n plan        --repo .                      # 3747 groups — exits 1 on an open hazard
ultrai18n orchestrate --repo .                      # the workflow + contract for the READY phase
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
translation agents run past three of those is precisely the failure this tool exists to prevent.

Two things follow, and they are worth being blunt about:

- **A subagent can translate everything the engine DECIDED.** The batches are complete, each is
  eight short strings and a one-page contract, and a model never opens a source file.
- **It cannot translate what the engine REFUSED**, and that pile is large — roughly 7,800 and 10,300
  `needs-judgment` sites on those two repositories. They do not block translation; they block
  `check`. They are the price of not guessing.

An agent phase that WRITES files is verified rather than trusted: `plurals --apply` and `check`'s
structural fold both re-scan and compare the result against what the agent said it did, because a
return from those phases is a claim that an edit was made rather than a decision to fold in.

Other backends: a generic CLI (`--translator '<command>'`), direct HTTP (`--backend api`), and
manual. The API backend is fully configurable — `--provider anthropic|openai|openai-compatible`,
`--model`, `--endpoint`, `--key-env`, `--max-tokens`, overridable by `ULTRAI18N_*` environment
variables and by `.ultrai18n/config.json`, with resolved settings printed and their source named
before anything is sent. Every preset defaults to its provider's SMALL tier, and a localhost
endpoint needs no key, so a local model is one flag away.

## Limits

Stated rather than discovered, because a tool that hides these is worse than one that has them.

**The refusal pile is the wall, and it is not a recall problem.** Thousands of sites come back
`needs-judgment`. Every one of them was *found*; no amount of better searching reduces the number.
This is a classification problem, and it should not go to zero — `short-string` on `"Format"` is the
engine working, not failing.

**Not read, and named:**

- text rendered into images, video or PDF is listed as unscannable and never claimed — there is no
  version of that which is not OCR;
- text computed at runtime with no literal in the source cannot be detected;
- dependencies and text outside the repository are out of scope;
- a shell script's *strings* are never emitted, only its comments — deliberately, because emitting
  shell arguments hands a translator a wall of paths, flags and package names;
- `.strings`, and the `.ini`/`.conf`/`.properties` family, have no reader yet.

**Claims deliberately not made:**

- `dialects --check` verifies the *shape* of a citation, never the citation. No network, ever: a
  well-formed URL to a page that does not exist passes, and only a human reading the diff is between
  that and a shipped lie.
- Evidence is presence, never usage. `i18next` in `package.json` proves the dependency is installed,
  not that the file in front of you is one of its bundles.
- gettext's `Plural-Forms:` is read and never evaluated. It is a C expression, and an index there is
  a POSITION — index 1 of a three-form Polish catalog is "the second form", never `few` — so such a
  family is `cldr: false` and never measured for completeness.
- The language gate catches "still in the source language", never "translated badly". Languages
  outside the fourteen shipped profiles return no detection and are routed to judgment.

## License

MIT
