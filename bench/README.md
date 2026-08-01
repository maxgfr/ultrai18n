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
