# evals

Three suites, each answering a different question. They run inside `pnpm test`
alongside the unit tests; `pnpm eval` narrows to just these.

| suite | fixture | the question |
|---|---|---|
| `recall.test.ts` | `fixture/` | Does the pipeline find what two human translation passes over a real repository missed — and does it refuse the traps sitting beside them? |
| `gates.test.ts` | `fixture/` | Do the gates fire on the states they exist for, and does an exception excuse exactly one site and no more? |
| `plurals.test.ts` | `fixture-i18n/` | Is a plural read as a family, measured against its **own** locale, and written back with the forms the target needs? |

## The fixtures

**`fixture/`** is a fully French Vite/React app, ~150 lines across 13 files.
Every file is a miss or a trap, never sample code: `package.json`'s description,
a web app manifest that exists only inside `vite.config.ts`, French comments in a
stylesheet, a storage key that must not move, a `LICENSE` that must not be
touched, a plural baked into a ternary that the engine is supposed to refuse.

**`fixture-i18n/`** is an already-English workspace carrying one instance of each
plural arrangement, plus a Russian bundle short of two forms and a Japanese one
that is correct with a single form. It is deliberately a separate tree so its
English does not pollute `fixture/`'s source-language inference. Its own
`README.md` lists what each entry is there to prove.

## Isolation

Every suite scans a **copy** of its fixture, in a tmpdir with a git history of
its own, via `isolate.ts`. Never the tree in place. Two reasons, both
load-bearing:

- The census denominator is `git ls-files`, on purpose — the walker's own
  exclusions are the thing being audited. Run inside `evals/fixture`, that
  command answers for *this* repository, so a fixture scanned in place is
  measured against the outer repo's git state.
- `.ultrai18n/` is skipped by the walker but read by the engine: `scan` takes
  `plurals.json` from there, `check` takes `exceptions.json` and `baseline.json`.
  A local run leaves state that silently changes what a later eval measures, in a
  gitignored directory nobody sees in a diff.

Nothing here shells out to the CLI. `plurals.test.ts` drives the write path with
the same five functions `src/cli.ts` calls — `scan`, `cmdPlan`, `cmdTranslate`,
`cmdTranslateApply`, `cmdApply` — so a failure comes back as a stack rather than
an exit code, and the suite needs neither a TypeScript loader nor the network.

`fake-translator.mjs` stands in for a model: it echoes each source string back
unchanged and copies `other` into every category the target needs. A terrible
translation and a perfectly good test of batching, folding, validation, byte
offsets and key insertion.

## What these are not

They assert **behaviour, never totals**. A test pinning "12 families" fails on
every fixture edit and tells you nothing about whether the thing works.

They also do not report recall as a number. `found / hand_listed` would make the
denominator one author's guess about what exists, which is the unfalsifiable
claim this project rejects. Recall is carried structurally instead: by G1, which
puts every tracked path in exactly one census bucket, and by G2, which forces any
unclaimed human-looking byte into the inventory as `unclassified`.

Measurement across ecosystems lives in `bench/` — a corpus with declared ground
truth, thresholds, and a report committed so that every change in what the tool
finds shows up as a reviewable diff.
