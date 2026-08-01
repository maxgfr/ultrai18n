# bench

What this engine finds, measured against ground truth somebody wrote by hand.

```sh
pnpm bench                    # every case
pnpm bench --only census-edges
pnpm bench --ci               # additionally rejects a `why` still marked TODO
```

Exit `0` every floor held, `1` one did not, `2` a malformed `expected.json` or a
missing bundle. It drives `skills/ultrai18n/scripts/ultrai18n.mjs` — the
committed bundle, which is what people actually run — so `pnpm build` has to have
happened first.

## Why the headline number is not recall

`found / hand_listed` makes the denominator one author's guess about what exists,
which is the unfalsifiable claim this project rejects. What is falsifiable is
**accounting**: for every region a human declared, is there a site whose bytes
overlap it, and for every path git tracks, does the census name a bucket and a
reason? That number has a floor of `1.000` and no per-case exemption.

Precision is gated harder than recall, and deliberately. A miss in a file with no
extractor is already caught in-product — residual sweep, `unclassified`, G2. A
false `translate` on a persisted enum is caught by **nothing**; worse, G4 will
actively demand it be translated, because it is a `translate` site still reading
as the source language. So one trap violation fails the run, while aggregate
recall is measured against a floor a human can move with a commit message.

## Adding a case

1. `mkdir bench/corpus/<name>` and put a small repository in it. Under ~4 KB.
   Every file should be a claim or a trap, never sample code.
2. Write `expected.json` (schema below).
3. `pnpm bench --only <name>`, and read what it says before believing it.

`REPORT.md` and `report.json` are **committed**, and CI fails when a fresh run
differs from them. That is the point: every change in what the tool finds arrives
as a reviewable prose diff, whether or not it crossed a threshold.

## `expected.json`

```jsonc
{
  "schemaVersion": 1,
  "case": "<must equal the directory name>",
  "title": "<one line: what this case is for>",
  "scan": { "from": "fr", "to": "en" },

  // pass | fail | any. `any` means the case makes no claim about that gate.
  "gates": { "G1": "pass", "G2": "pass", "G3": "any" },

  // Files a git repo can hold but this one should not: a megabyte of filler, a
  // symlink out of the tree, a nested `.gitignore`. Materialised into the
  // isolated copy before its commit. See "Files this repository will not hold".
  "generate": [
    { "file": "assets/huge.md", "repeat": "…\n", "bytes": 1200000, "why": "…" },
    { "file": "link", "symlinkTo": "/etc/hosts", "why": "…" },
    { "file": ".gitignore", "repeat": "secrets/\n", "bytes": 9, "why": "…" }
  ],

  // Paths to `git add -f`, for the gitignored-but-tracked case.
  "forceAdd": ["secrets/token.txt"],

  // Per-file census claims. `reason` is a prefix match.
  "census": [
    { "file": "dist/bundled.js", "bucket": "skipped", "reason": "ignore-dir", "why": "…" }
  ],

  // Region claims, keyed on a verbatim substring of the file.
  "expectations": [
    {
      "id": "readme.prose",
      "file": "README.md",
      "find": "Aucun d'entre eux ne doit finir sans explication.",
      "occurrence": 1,                    // only when `find` is not unique
      "expect": { "verdict": "translate", "rule": "npm.package-json.description" },
      "mustNotClaim": false,              // true ⇒ a `translate` here fails the run
      "why": "<required, and not starting with TODO under --ci>"
    }
  ],

  // A filename that reads as source-language text has a ZERO-WIDTH span, so it
  // is asserted by value rather than by region.
  "pathSites": [
    { "file": "docs/réglages.png", "segment": "réglages", "verdict": "needs-judgment", "why": "…" }
  ],

  // Things this case knows the engine gets wrong or cannot express. Printed in
  // every run, gated by nothing.
  "knownGaps": ["…"]
}
```

### Why `find` and not `siteKey`

Writing a `siteKey` means running the tool and copying its answer, so the
expectation would be derived from the output it exists to verify — a rubber
stamp by construction. Sweep anchors are worse: `~sweep[3]` is an ordinal into a
gap list and shifts whenever an earlier gap changes.

A verbatim substring is something a human reads off the fixture and confirms by
eye, and when it stops resolving it says `does not contain "…"` or
`contains "…" 3 times — add "occurrence"` rather than silently pointing at the
wrong place.

`find` resolves against the **decoded** text, not the raw bytes, because that is
what the engine's spans index: a UTF-8 BOM is stripped before extraction, so
every span in such a file sits three bytes below its raw offset. Files the engine
marks non-byte-addressable — UTF-16, latin1, binary — refuse region claims
outright rather than comparing nonsense; assert those at the `census` level.

### Files this repository will not hold

A corpus file that git ignores never reaches a fresh clone, so the case passes on
the machine that wrote it and quietly measures less everywhere else. It is easy
to walk into: a case needs a `dist/`, a `node_modules/`, a `.log` — or its own
`.gitignore`, which then applies to *this* repository and hides whatever it
names.

`pnpm bench` refuses any case holding such a file, and names it. Put it under
`generate` instead: materialised at run time, and still visible in the ground
truth rather than hidden behind a `git add -f` nobody will remember.

### Why `why` is required

Same discipline G5 puts on an exception's justification: an expectation without a
reason is a place to hide. It is also what makes a miss promoted from the wild
ship red — the draft carries `TODO:` and `--ci` rejects it — so a finding stays
loud until somebody writes down what it proves.

## Accepting a change

When the tool starts answering differently and the new answer is right, splice
it into ground truth one typed id at a time:

```sh
node bench/run.mjs --accept traps-interop:http.header-name
```

It rewrites exactly the value that produced a finding, records what it replaced
under `acceptedFrom`, and leaves every other byte of the file alone — a
reflowed `expected.json` would bury the one accepted id in a four-hundred-line
diff, which destroys the review signal the flag exists to produce. The rewritten
text is parsed back and deep-compared before anything is written; a splice that
does not round-trip writes nothing.

**There is no `--update-all`, and there will not be one.** Accepting forty
changes should mean typing forty ids, and the reviewer seeing forty ids in the
diff. `--accept` also refuses to run with `--ci` — one verifies, the other
rewrites ground truth, and doing both in a single run is how an unreviewed
change lands in a green build — and it never writes `REPORT.md` or
`report.json`, because CI diff-gates both and a partial run's report must not
land in that diff.

`observed.siteKey` is written the same way and only that way. It is the anchor a
site is addressed by, and an exception is PINNED to one — so an anchor that
moves silently stops excusing anything. `anchorDrift` is gated at 0 from the day
it shipped, because `--accept` *is* its escape hatch.

## Promoting a miss found in the wild

A confirmed miss is the strongest thing the sweep says: the extractor asserted
it accounted for every byte, and a human-looking line no site covered
contradicts that. Losing one to a nightly log is how a real finding becomes
folklore.

```sh
node bench/sweep.mjs --promote python-babel/babel:src/x.py:41
```

It never clones and never re-sweeps — it curates a report somebody has just
read. The case it writes has **no `expect` block**: the observed verdict is the
behaviour under suspicion, and writing it in would pin the bug rather than the
finding. It fails on `accountingCoverage`, which is the correct red, and its
`why` starts `TODO:` so `pnpm bench --ci` stays red until somebody writes down
what it proves.

The `license` field in `repos.json` is what makes the copyleft policy
enforceable rather than aspirational. A permissive source gets a thirty-line
excerpt and a `PROVENANCE.md`; anything else — **including a licence the script
does not recognise, which fails closed** — gets a `bench/reproduce/` directory
with clone-and-look instructions and zero copied bytes.

## Repositories that have never been swept

`sindresorhus/ky` (the control) and `python-babel/babel` have run.
`excalidraw`, `nowinandroid`, `pdf.js`, `formatjs`, `django`, `astro` and
`duckduckgo/iOS` are pinned and untested. The sweep is network-dependent,
nightly, and never a merge gate, so this is a gap in evidence rather than in the
product — but it is a gap, and it is written down here so it stays visible.
