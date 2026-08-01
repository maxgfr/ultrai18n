# TODO

Everything here was found by running the thing, not by imagining it. Each entry
says what is wrong, how it was found, and what the remedy actually is — because
half of these are one line and half are a new module, and the difference is not
obvious from the symptom.

Ordered by leverage, not by effort.

---

## 1. Formats with no reader

The largest single gap, and the one the tool is most explicit about. These files
are **surfaced** as `unclassified` — G2 refuses to pass — but nothing understands
them. No dialect row can fix this: without an extractor the sites do not exist,
so a row is inert however well written.

| format | what is missing | cost |
|---|---|---|
| gettext `.po` / `.pot` | `src/extract/po.ts` | a real module. `msgid` / `msgid_plural` / `msgstr[n]`, plus the obsolete-entry and fuzzy-flag rules |
| Fluent `.ftl` | `src/plural/fluent.ts` + an extractor | a real module. Fluent's selector is a GRAMMAR, not a separator, so it needs a parser beside `icu.ts` — the one place the dialect design charges for a new arrangement |
| Apple `.stringsdict` | one line: register `.stringsdict` in `HTML_EXT` (it is an XML plist), then one dialect row | cheap. `.xcstrings` took exactly this and became a row |
| Qt `.ts` | content sniffing, because `.ts` is routed to the TypeScript grammar | see §2 |

**gettext's honest limit, even with an extractor.** `Plural-Forms:` is a C
expression this engine does not evaluate. An index there is a POSITION — index 1
of a three-form Polish catalog is "the second form", never `few` — so such a
family is `cldr: false` and is never measured for completeness. That is a smaller
claim than the one made for i18next, and it is the true one. Say so in the row's
`notes` when it lands.

Evidence: `bench/corpus/plural-unread-dialects/`, and `SKILL.md`'s scope notes.

---

## 2. Qt `.ts` is handed to the TypeScript grammar

A Qt translation file uses the same extension as TypeScript, so the AST tier
parses XML, reports 19 unparseable regions, and the file goes down the degraded
branch with `claimRatio` at 0.

Nothing is LOST — the sweep covers exactly the regions the grammar failed on,
which is what that branch exists for — but the file is reported as a broken
TypeScript file rather than as a translation catalog.

**Remedy:** sniff the first bytes for `<!DOCTYPE TS>` before routing on the
extension, in `src/scan.ts:extractFile`. Extension-based routing is right for
everything else; this is the one collision worth a content check.

Evidence: `bench/corpus/plural-unread-dialects/translations/app_fr.ts`.

---

## 3. Four catalog rules cannot fire

Well-formed, documented, unreachable. `checkCatalog` validates a rule's SHAPE and
never its reachability, which is why the benchmark carries a ratchet
(`bench/thresholds.json`, `neverExercisedRules`) that may only shrink.

| rule | why | remedy |
|---|---|---|
| `cargo.package.description` | `pointer` matcher on `.toml`; no TOML extractor, and `classify` short-circuits on `tier === 'sweep'` before `matchRules` | `src/extract/toml.ts` — one extractor unlocks both TOML rules |
| `python.pyproject.description` | same | same |
| `docker.label` | `keyName` matcher on `Dockerfile`, which the prose extractor reads with `key = "p[0]"` | either a Dockerfile extractor emitting LABEL keys, or rewrite the rule to match the value |
| `html.title` | expects `{kind: attr, element: title, attr: text}`; the HTML extractor emits a title as a `prose-run` at `title/text[0]` | make the extractor emit it as an attr, or rewrite the rule. **Recall is fine** — the title is found and translated by the generic prose path — so this is traceability only |

Evidence: `bench/corpus/surfaces-polyglot-manifests/`, `pnpm bench` catalog section.

---

## 4. Symfony intervals are mislabelled

`'{0} Rien|]0,1] Un article|]1,Inf[ %count% articles'` is claimed by
`vue-i18n.pipe-positional` as a three-part `zero|one|other` family. It is not
one: each part carries an explicit selector, and reading them as positions
mislabels all three.

**Why it is not a one-line fix.** The `value-split` primitive has no
`partSelector`, so a correct Symfony row cannot be written today. Adding an
interval guard to the vue-i18n row would put Symfony knowledge inside somebody
else's dialect — exactly the coupling this design exists to remove.

**Remedy:** add `partSelector: { re, tokens }` to `ValueSplitRead`, then ship a
`symfony.interval` row. Roughly 30 lines in the primitive and one row.

Evidence: `bench/corpus/plural-unread-dialects/src/locales/messages.en.yaml`.

---

## 5. Classification inconsistencies

Two strings in the same construct getting different answers. Neither is pinned in
ground truth, because pinning an inconsistent pair makes it look decided.

- **`switch` arms.** `'Synchronisation en cours'` → `needs-judgment/no-rule`;
  `'Réinitialisation demandée'`, its sibling in the same `switch`, → `translate`.
  (`bench/corpus/traps-persistence/`)
- **Ternary branches.** `'Enregistrement en cours'` → `needs-judgment/no-rule`;
  `'Toutes les modifications sont enregistrées'`, the other branch of the same
  ternary, → `translate`. (`bench/corpus/traps-test-fixtures/`)
- **Enum VALUES.** `'email'` and `'push'` land on `needs-judgment/short-string`
  rather than `enum-member`. Refused for the right outcome by the wrong reason —
  only their brevity saves them, and a longer enum value reads as copy.
- **HTTP headers.** `'Content-Type'`, `'Accept-Language'`, `'XMLHttpRequest'` →
  `needs-judgment/ambiguous-role` rather than the API contract they are. Refused,
  so nothing breaks, but by a generic hesitation.
- **A locale marker the engine cannot see.** `'fr-FR'` in a header map is the one
  thing in that file that SHOULD be retargeted; it reads as `ambiguous-role`.

---

## 6. Two census defects

- **A BROKEN symlink is dropped silently.** `walk()` calls `statSync` on a
  symlink, which throws for a dangling target, and the `catch` does `continue` —
  so the path never reaches any skip list. If git tracks it, the census reports
  `unaccounted` and G1 fails with no reason anybody can act on. **Remedy:** catch
  it into `skipped` with a `broken-symlink` reason. Not exercised in the corpus
  on purpose: the case would fail, and it deserves a fix rather than a pinned
  expectation.
- **`claimRatio` is a false alarm on UTF-16.** `bytesClaimed` counts decoded
  UTF-8 while `bytesTotal` counts the file, so a fully-read UTF-16 file reports
  0.506 — "the extractor skipped half this file" when it skipped nothing.
  **Remedy:** compare like with like, or report the ratio only when
  `byteAddressable`.

Evidence: `bench/corpus/census-edges/` `knownGaps`.

---

## 7. Suspicion signals do not reach two formats

`.stringsdict` and `.ftl` produce no plural RESIDUAL, only `unclassified` sites.
The signals look for a marker in a path or a token in the text, and the residual
sweep fragments both formats below the level where either survives — the sweep
splits on `_`, so `msgid_plural` becomes `msgid` + `plural`.

Nothing is lost (G2 still refuses to pass) but G7 cannot say "this looks like a
plural", so `dialects --propose` will not mention them.

**Remedy:** this dissolves once §1 gives those formats extractors. Not worth
patching the signals for.

---

## 8. Benchmark and sweep

- **`--accept <case>:<id>` is not implemented.** `bench/run.mjs` has no way to
  splice a reviewed change into `expected.json`. Deliberately no `--update-all`:
  accepting forty changes should mean typing forty ids, and the reviewer seeing
  forty ids in the diff. That is the whole anti-rubber-stamp mechanism.
- **`sweep --promote` is not implemented.** A confirmed miss should become a
  `bench/corpus/` case with a `PROVENANCE.md` and a `why` starting `TODO:`, so
  `pnpm bench --ci` fails on it until somebody writes down what it proves. It
  must refuse copyleft repositories and emit a `REPRODUCE.md` instead — excerpting
  thirty lines of MIT/Apache/BSD with provenance is fine, vendoring GPL into an
  MIT repo is not.
- **Six pinned repositories have never been swept.** Only `sindresorhus/ky`
  (the control) and `python-babel/babel` have run. `excalidraw`, `nowinandroid`,
  `pdf.js`, `formatjs`, `django` and `astro` are pinned and untested —
  `pnpm sweep --tier core` runs the first four.
- **`anchorDrift` is designed and unimplemented.** `expected.json` has an
  `observed.siteKey` slot, and nothing writes or diffs it. It would exercise
  `reconcile()` in `src/identity.ts`, which nothing exercises today — and an
  exception pinned to a stale key silently stops applying.
- **The generated README table.** `evals/fixture-i18n/README.md` still
  hand-maintains a `where | shape | proves` table duplicating `plurals.test.ts`.
  It should be generated from ground truth into a `<!-- ul:gen -->` region, using
  the marker convention `commands.ts` already has for `glossary.md`.

---

## 9. Unimplemented commands

Declared in `src/cli.ts` and failing with a stated reason, not silently:
`sites`, `lang`, `adjudicate`, `glossary`.

`adjudicate` is the notable one: the `adjudicator` contract asks for
`{groupId, sites:[{siteId, verdict, reason}]}` and **nothing parses that shape**.
The only way a hazard ruling reaches the engine today is by hand-editing
`exceptions.json`. Same for the `pluralist` and `structuralist` returns.

---

## 10. Flags the parser accepts and nothing reads

`--quiet`, `--no-sweep`, `--allow-dirty`, `--no-git`, `--backup`, `--strict`.
Either wire them or drop them; a flag that is accepted and ignored is worse than
one that errors.

(`--config` was in this list and is now read by the provider resolver.)

---

## Not on this list, on purpose

- **`dialects --check` verifies the shape of a citation, not the citation.** No
  network, ever. A well-formed URL to a page that does not exist passes, and the
  only thing between that and a shipped lie is a human reading the diff — the same
  protection `glossary.md` has. This is a design decision, not a gap.
- **Evidence is presence, never usage.** `i18next` in `package.json` proves the
  dependency is installed, not that the file in front of you is one of its
  bundles. The remedy is `where.file`, which is a human decision and not an
  inference.
- **The dialectician sees strings.** Its worklist carries residual and sibling
  VALUES, because an arrangement is not recognisable from a path alone. Stated
  rather than smoothed over: "the model only ever sees `{id, text}`" is true of
  the translator, not of every agent in the pipeline.
