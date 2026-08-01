# TODO

Everything here was found by running the thing against real repositories, not by
imagining it. Each entry says what is wrong, how it was found, and what the
remedy actually costs.

The list is short now, and the reason it is short is not that the work got
easier. It is that `sites --audit` exists: the check that used to live only in
`bench/sweep.mjs` — network, `codeindex` on PATH, nine pinned repositories — now
runs offline against your own repository, so a claim of full coverage can be
contradicted by anyone rather than believed on the strength of a number nobody
else could reproduce.

---

## 0. What is already true, so the rest is read honestly

There are three different "100%" and they are in very different places.
Conflating them is how a recall claim becomes a lie.

| claim | state |
|---|---|
| **Accounting** — every tracked path in one bucket, every byte claimed or swept | **holds.** G1 and G2 pass on both reference repositories, and `sites --audit` re-checks it per file |
| **Found and usable** — the text reaches a site a translator can be handed | **holds for every format with a reader**, and every format the reference repositories contain now has one |
| **Decided** — a verdict somebody can act on | deliberately not claimed. §2 |

Recall is measured rather than asserted, and the instrument ships: `sites
--audit` takes every file whose extractor recorded a `claimRatio` of 1.0 —
asserting it accounted for every byte — and asks whether any line holding text is
covered by no site. It comes back clean on this repository across 201 such files.

The oracle is a table of locators the extractors do not share, because asking an
extractor whether it found everything is a tautology. Each row cites what it
points at, and when a row is wrong the fix is a row.

---

## 1. The sweep has never run on seven of its nine repositories

`sindresorhus/ky` (the control) and `python-babel/babel` have run. `excalidraw`,
`nowinandroid`, `pdf.js`, `formatjs`, `django`, `astro` and `duckduckgo/iOS` are
pinned and untested.

Network-dependent, nightly, never a merge gate — so this is a gap in EVIDENCE
rather than in the product, and it is written down in `bench/README.md` too so it
stays visible.

Two of those seven now matter more than they did. `django` is a Python codebase
and `duckduckgo/iOS` is a Swift one with property lists; the first has a real
reader for the first time and the second has one for its `Info.plist`. Whatever
the sweep says about them is new information rather than a re-run.

**The oracle is where `codeindex` WOULD matter.** `bench/locators.json` is 25
patterns, and a hole it cannot see is a hole nobody finds. Better locators — or a
better `codeindex grep` behind them — improve the MEASURING INSTRUMENT. That is
worth doing, and it is not the same thing as improving recall: see the note at
the bottom.

---

## 2. The refusal pile is the wall, and it is not a recall problem

Roughly 4,100 sites on this repository come back `needs-judgment`. Every one of
them was FOUND. For somebody trying to translate a repository that is the real
cost, and no amount of better searching reduces it.

What remains, after the code spans and the design tokens were taken out of it:

| reason | share | dominated by |
|---|---|---|
| `short-string` | ~64% | short values everywhere |
| `ambiguous-role` | ~31% | `.ts`, then `.md` |
| `no-rule` | ~3% | |

This is a CLASSIFICATION problem throughout, and filing it under recall would be
the comfortable mistake. Two causes have been removed — a markdown run that is
entirely a code span is no longer emitted, and a design token is `token.style` by
the same argument that already protects a `css` tagged template.

What is left is genuinely ambiguous and **should stay refused**. `short-string`
on `"Format"` is the engine working, not failing. There is no version of this
that ends with the number at zero, and a change that lowered it by guessing would
be strictly worse than the wall.

---

## 3. Formats still without a reader

Every format the reference repositories contained has one. These do not, and
each is named with what it would cost:

- **`.strings`** — the other half of an Apple localisation. `.stringsdict` and
  `.xcstrings` are read; this is not. A `key = "value";` lexer, small, and the
  one that makes an iOS repository's coverage complete rather than partial.
- **`.ini`, `.conf`, `.cfg`, `.properties`** — `#` comments, and NOT shell:
  sections, `key = value`, their own quoting. Handing one to the bash grammar
  buys unparseable regions in exchange for comments the sweep already surfaces,
  so each needs its own reader and its own corpus case.
- **A shell script's strings.** Deliberate, and worth restating as a limit rather
  than a gap: `echo "Terminé"` is a real miss, and emitting shell arguments would
  hand a translator a wall of paths, flags and package names to refuse one at a
  time.

---

## 4. Smaller, verified, and each one a place where a reader of the code is misled

- **`CFBundleDisplayName` is in neither plist rule.** Some teams localise the
  launcher label and some treat it as the product name. It comes back for a
  person, which is right — but it comes back with no rule cited, which is the
  weaker of the two ways to be right.
- **`html.title` cannot fire.** The rule matches `{kind: attr, element: title,
  attr: text}` and the markup extractor emits a document title as a `prose-run`.
  The title IS found and IS translated, by the generic prose path with no rule
  cited, so the miss is in traceability rather than in recall.
- **`manifest/lang` inside `rspack.config.ts` comes back with no verdict**, where
  the same field in `manifest.webmanifest` is a `locale-marker`. The companion
  matcher lists four bundlers; its parent rule lists thirteen.
- **A trailing comment is outside the audit's oracle.** The `comment` locator is
  anchored at the start of a line, because unanchored it read `\/\/` inside a
  regex literal as a comment marker. The alternative to anchoring is lexing the
  line, and an oracle that needs a lexer is the extractor it is meant to be
  independent of.

---

## Not on this list, on purpose

- **Improving `codeindex` does not improve recall.** It is used in exactly two
  ways, neither in the extraction path: the `codeindex` binary is the grep oracle
  in `bench/sweep.mjs`, and `src/vendor/walk.ts` / `glob.ts` are source copied
  once and already in-tree. What it DOES supply is grammars — `python.wasm` and
  `bash.wasm` came from its CORE tier, which is why those two readers cost a
  visitor each instead of a module each — and that is provisioning, not
  extraction. A better codeindex is a better instrument; §1 says where that pays.
- **`dialects --check` verifies the shape of a citation, not the citation.** No
  network, ever. A well-formed URL to a page that does not exist passes, and the
  only thing between that and a shipped lie is a human reading the diff.
- **Evidence is presence, never usage.** `i18next` in `package.json` proves the
  dependency is installed, not that the file in front of you is one of its
  bundles.
- **gettext's `Plural-Forms:` is read and never evaluated.** It is a C
  expression. An index there is a POSITION — index 1 of a three-form Polish
  catalog is "the second form", never `few` — which is why such a family is
  `cldr: false` and never measured for completeness. Comparing `nplurals=N`
  against the number of `msgstr[n]` present would find a real bug, and doing it
  would invite the reader to believe the whole header is understood.
- **Text rendered into images, video or PDF.** Listed, never claimed. There is no
  version of this that is not OCR.
