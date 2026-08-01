# TODO

Everything here was found by running the thing against real repositories, not by
imagining it. Each entry says what is wrong, how it was found, and what the
remedy actually costs — because half of these are one branch and half are a new
module, and the difference is not obvious from the symptom.

Ordered by leverage, not by effort.

The measurements below come from two repositories outside this project, 1,128
tracked files between them, scanned `en → fr`. Where a number appears it was
measured, and the command that produced it is named.

---

## 0. What is already true, so the rest is read honestly

There are three different "100%" and they are in very different places. Conflating
them is how a recall claim becomes a lie.

| claim | state |
|---|---|
| **Accounting** — every tracked path in one bucket, every byte claimed or swept | **holds.** G1 and G2 pass on both repositories |
| **Found and usable** — the text reaches a site a translator can be handed | holds for every format with a reader; §2 is the gap |
| **Decided** — a verdict somebody can act on | deliberately not claimed. §4 |

Recall on formats that HAVE a reader is measured, not asserted: every quoted
literal, every JSX text node and every JSON string value in a file whose
`claimRatio` is 1.0 was covered by a site, and markdown prose ran at 99.9%. The
lines still uncovered are lines that are entirely inline code.

---

## 1. The audit that proves it is a script in /tmp

The highest-leverage item, and the reason it is first: **it makes everything
below measurable by the user instead of by whoever last read this file.**

`sweep` already knows how to make the strongest claim this project makes — a
file whose `claimRatio` is 1.0 has an extractor ASSERTING it accounted for every
byte, so a human-looking line no site covers contradicts a recorded claim. But
that logic lives in `bench/sweep.mjs`, needs the network, needs `codeindex` on
PATH, and only ever runs against nine pinned repositories.

The same check works offline, on the user's own repository, with no oracle at
all: walk the census, take every file asserting full coverage, and ask whether
every human-looking line falls inside some site's line span.

**Remedy:** `sites --audit`. Roughly 60 lines, no new dependency, reusing the
census and the sites already on the inventory. It is the difference between "we
believe nothing was missed" and "run this and see".

Evidence: the 99.9% figures above were produced by an ad-hoc script that is not
in the repository. A number nobody else can reproduce is not evidence.

---

## 2. Formats with no reader

743 sites in one repository, 471 in the other, surfaced as `unclassified`. **None
of this is lost** — the residual sweep lists it and G2 refuses to pass — but
listed is not understood, and the sweep fragments as it lists. A real example
from `.jsonl`:

```
"grounding\", \"author\": \"fable-crealink-improver-2/lens-A\", \"dimensionScor"
```

That is accounted for and useless as a unit of translation. The sweep guarantees
accounting; a reader is what gives exploitability.

| format | sites | what it is | cost |
|---|---|---|---|
| `.jsonl` | 299 / 180 | JSON, one object per line | **cheapest.** Route each line to `extractJson` with a line offset, as `yaml.ts` already does for a block scalar. One branch |
| `.py` | 70 | docstrings and comments — real prose | a real module, and the most valuable missing reader: a Python application currently has no meaningful coverage at all |
| `.sh` | 30 / 28 | `#` comments, often install instructions a user reads | small. A comment lexer, close to `extract/dockerfile.ts` |
| `.sql` | 384 / 175 | schema DDL | small, and it earns its place by SILENCING rather than finding: read the `--` comments, claim the DDL as read-and-non-textual. Turns 384 refusals into ~0 noise |
| `.example`, `.gitignore`, `.dockerignore` | 30 | comments | falls out of the `.sh` work |

Evidence: `sites --verdict unclassified --file '**/*.py'` on either repository,
after `scan`.

---

## 3. An inline `<script>` is swept, not parsed

`extract/html.ts` hands an inline `<style>` to the stylesheet reader and declares
a `<script>` body UNREAD, so the residual sweep covers it and G2 refuses. That is
honest and it is not finished: the strings arrive as `unclassified` with no
container semantics, so a persisted key and a rendered label inside a `<script>`
are indistinguishable.

**Remedy:** route the body to the AST tier. The obstacle is real — grammar
loading is async and lives in `scan.ts`, not in a synchronous extractor — so this
is a plumbing change rather than a lexer.

Evidence: `bench/corpus/surfaces-web-app/inline.html`, and its `knownGaps` entry.

---

## 4. The refusal pile is the wall, and it is not a recall problem

10,530 sites in one repository and 7,842 in the other come back
`needs-judgment`. Every one of them was FOUND. For somebody trying to translate a
repository, that is the real cost, and no amount of better searching reduces it.

Where they are:

| reason | count | dominated by |
|---|---|---|
| `ambiguous-role` | 6,136 / 4,379 | `.md` (4,141), `.json` (1,105) |
| `short-string` | 4,052 / 3,259 | short values everywhere |
| `no-rule` | 277 / 188 | |

And what they look like:

```
DESIGN.md | "`oklch(0.15 0.02 255)`"
DESIGN.md | "background"
DESIGN.md | "+ overrides"
```

Colour tokens and CSS keywords inside technical documentation. The markdown
extractor masks inline code for the RUN it emits, but a run that is *entirely* a
code span still becomes a site and still reaches the detector.

**Remedy, in order of honesty:**

1. A run whose masked form is empty is a code span, not prose. Do not emit it.
   Cheap, and removes a large share of the `.md` noise.
2. A design-token shape (`oklch(...)`, `#rrggbb`, `1.5rem`, `var(--x)`) is
   `token.style` by the same argument that already protects a `css` tagged
   template. One matcher.
3. What remains is genuinely ambiguous and should stay refused. `short-string` on
   `"Format"` is the engine working, not failing.

This is a CLASSIFICATION problem throughout. Filing it under recall would be the
comfortable mistake.

---

## 5. Two returns nobody verifies

`adjudicate --apply` parses the adjudicator's ruling and folds it in. The
`pluralist` and `structuralist` phases have the same shape and no such path —
but the gap is a DIFFERENT one and must not be fixed the same way.

Those two phases write files themselves (`PhaseStatus.writes`), so their return
is not a decision the engine must fold in; it is a **claim that an edit was
made**. Both joins already re-scan, and the re-scan is never compared against
what the agent said it did.

**Remedy:** a verifier, not a parser. `plurals --apply <returns.json>` asserting
each claimed `familyId` now has `missing: []` against its target categories, and
a `check` fold asserting each claimed `siteId`'s grammar hole is gone. Both fail
when an agent reported an edit the re-scan cannot see.

---

## 6. Declared and never written

Small, verified, and each one a place where a reader of the code is misled.

- **`Tier = 'regex'` is dead vocabulary.** Nothing emits it, and `classify.ts:133`
  computes `degraded: raw.tier === 'regex'` — so **`Site.degraded` is always
  false**. Per-file degradation is only on `CensusEntry.degraded`. Either drop
  the tier and the field, or give the field the meaning its name promises.
- **`CensusEntry.tier` is declared and never populated**, by either census
  builder.
- **`extractYaml`'s `nested` hook is never passed.** It exists so a markdown
  release-notes body inside a workflow YAML is read as the markdown it is; today
  that body is one block-scalar site. Not a miss — the rule fires and the text is
  found — but a forty-line release note as a single translation unit, with its
  links and code spans unmasked.
- **`extractMarkdown`'s `headings` is dropped** by `scan.ts`, and `check.ts`
  re-derives slugs from siteKeys matching `/^h\d/`. Duplication rather than a
  bug, and one of the two will drift.

---

## 7. Benchmark and sweep

- **Six pinned repositories have never been swept.** Only `sindresorhus/ky` (the
  control) and `python-babel/babel` have run. `excalidraw`, `nowinandroid`,
  `pdf.js`, `formatjs`, `django`, `astro` and `duckduckgo/iOS` are pinned and
  untested. Network-dependent, nightly, never a merge gate — so this is a gap in
  evidence rather than in the product, and it is written down in
  `bench/README.md` so it stays visible.
- **The oracle is where codeindex WOULD matter.** `bench/locators.json` is 25
  patterns, and a hole it cannot see is a hole nobody finds. Better locators —
  or a better `codeindex grep` behind them — improve the MEASURING INSTRUMENT.
  That is worth doing, and it is not the same thing as improving recall: see the
  note below.

---

## 8. Deferred on purpose during the last change

- **`WriteSpec.partTemplate`.** `symfony.interval` is `code-edit` because
  rejoining translated parts with a bare pipe would drop each part's interval
  selector. A `partTemplate: '{selector} {form}'` plus about six lines in
  `writeFamily` would make these writable. The success criterion for that change
  was classification, and it was met.
- **`.plist` registration.** `.stringsdict` is read; `.plist` is not, and
  deliberately: every iOS repository has dozens, and `Info.plist` would turn
  `CFBundleIdentifier` and every usage-description string into sites at once. The
  good version is a rule for `NS*UsageDescription`, which is genuinely
  user-visible copy — and it needs its own corpus case.

---

## Not on this list, on purpose

- **Improving `codeindex` does not improve recall.** It is used in exactly two
  ways, neither in the extraction path: the `codeindex` binary is the grep oracle
  in `bench/sweep.mjs`, and `src/vendor/walk.ts` / `glob.ts` are source copied
  once and already in-tree (the `.wasm` grammars are shipped, not called). A
  better codeindex is a better instrument, and §7 says where that pays. It
  extracts nothing.
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
