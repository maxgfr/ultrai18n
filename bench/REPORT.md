# ultrai18n bench — 8 case(s), 80 expectation(s)

```
  accounting coverage     80/80       1.000   ok
  expectation mismatches  0                   ok
  trap violations         0                   ok
  census mismatches       0                   ok
  gate mismatches         0                   ok
  determinism             8/8                 ok
```

## catalog coverage — 15 rule(s) exercised, 4 never

```
  cargo.package.description             allowlisted
  docker.label                          allowlisted
  html.title                            allowlisted
  python.pyproject.description          allowlisted
```

## by case

### census-edges — Every path git tracks lands in one bucket with a reason

```
  7/7 accounted   15 site(s)   15 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - assets/utf16.md reports claimRatio 0.506 because bytesClaimed counts decoded UTF-8 while bytesTotal counts the UTF-16 file. It reads as 'the extractor skipped half this file' when it skipped nothing. Not asserted here, because writing 0.506 into ground truth would turn a measurement artefact into a decision.
  - A BROKEN symlink is dropped by the walker before it reaches any skip list, so a tracked one would surface as G1 `unaccounted` with no reason. Not exercised here — the case would fail, and it deserves a fix rather than a pinned expectation.

### plural-android-xml — Android <plurals>, and a Russian catalog rendering the wrong string today

```
  5/5 accounted   7 site(s)   2 tracked path(s)
  G1 pass  G2 pass  G3 pass  G4 fail  G5 pass  G6 fail  G7 pass
```

  Known gaps, gated by nothing:
  - `<string-array>` items are not read as a family and should not be — an array of weekday initials is calendar vocabulary, not a plural. They currently come back as ordinary translatable strings with no signal that reordering them breaks the calendar.

### plural-unread-dialects — Arrangements the engine does not read — listed, never claimed

```
  6/6 accounted   43 site(s)   6 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 pass  G7 fail
```

  Known gaps, gated by nothing:
  - The Symfony interval string in `src/locales/messages.en.yaml` is claimed by `vue-i18n.pipe-positional` as a three-part `zero|one|other` family. It is not one: `{0} …|]0,1] …|]1,Inf[ …` carries an explicit selector on each part, and reading them as positions mislabels all three. The `value-split` primitive has no `partSelector`, so a correct Symfony row cannot be written today — and adding an interval guard to the vue-i18n row would put Symfony knowledge inside somebody else's dialect, which is the coupling this design exists to remove.
  - `.stringsdict` and `.ftl` produce no plural RESIDUAL, only `unclassified` sites. The suspicion signals look for a marker in a path or a token in the text, and the sweep fragments both formats below the level where either survives. Nothing is lost — G2 still refuses to pass — but G7 cannot say 'this looks like a plural', so the dialect worklist will not mention them.
  - gettext's `Plural-Forms:` header is read by nothing. Even with a `.po` extractor, an index would map to a POSITION and never to a CLDR category, so such a family would be `cldr: false` and never measured for completeness. That is a smaller claim than the one made for i18next, and the true one.

### surfaces-polyglot-manifests — Package descriptions across ecosystems — and the three catalog rules that cannot fire

```
  6/6 accounted   18 site(s)   5 tracked path(s)
  G1 pass  G2 fail  G3 pass  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - Three catalog rules — `cargo.package.description`, `python.pyproject.description`, `docker.label` — are well-formed, cite documentation, and cannot fire in any repository. `checkCatalog` validates a rule's SHAPE and never its reachability, so nothing in the engine says so. This case is why the benchmark carries a `neverExercisedRules` ratchet: the list may only shrink, and a fourth dead rule fails the run.
  - `html.title` is the fourth, recorded in surfaces-web-app rather than here.

### surfaces-web-app — Where user-visible text hides in a web project: build configs, CI, store listings

```
  20/20 accounted   86 site(s)   10 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 fail  G7 pass
```

  Known gaps, gated by nothing:
  - `html.title` cannot fire. The rule matches `{kind: attr, element: title, attr: text}`, but the HTML extractor emits a document title as a `prose-run` at `title/text[0]`. The title IS found and IS translated — by the generic prose path, with no rule cited — so the miss is in traceability rather than in recall.
  - `manifest/lang` inside `rspack.config.ts` comes back with no verdict at all, where the same field in `manifest.webmanifest` is a `locale-marker`. The companion matcher lists vite, nuxt, astro and next; its parent rule lists nine more bundlers including rspack. A locale marker left undetected in a build config is exactly the G6 `locale-drift` finding this tool advertises.

### traps-interop — Formats other tools depend on, and text the licence forbids rewriting

```
  9/9 accounted   25 site(s)   5 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - `'Content-Type'`, `'Accept-Language'` and `'XMLHttpRequest'` come back needs-judgment/ambiguous-role rather than as the API contract they are. Refused, so nothing breaks — but by a generic hesitation rather than by recognising an HTTP header, so a longer header name in the same object would read as copy.
  - `'fr-FR'` lands on needs-judgment/ambiguous-role. It is a locale marker in a header map, which is the one thing in this file that SHOULD be retargeted rather than left alone; the engine sees neither.

### traps-persistence — Values that leave the process: translating one corrupts data, and no gate would catch it

```
  14/14 accounted   45 site(s)   4 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - `'Synchronisation en cours'` comes back needs-judgment/no-rule while `'Réinitialisation demandée'`, its sibling in the same switch, comes back translate. Same position, same shape, two answers. Not asserted either way here: pinning the inconsistent pair would make it look decided.
  - `'email'` and `'push'` — the Channel enum VALUES — land on needs-judgment/short-string rather than enum-member, so they are refused for the right outcome by the wrong reason. Only their brevity saves them; a longer enum value in the same position reads as copy.

### traps-test-fixtures — Strings that exist to be compared, not read: assertions, ARIA, class names, date patterns, keys

```
  13/13 accounted   48 site(s)   6 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - The values in `src/locales/fr/common.json` come back do-not-translate/already-target-language on a fr→en run. The bundle is in the SOURCE language, so under `swap` it is exactly what should be rewritten; the reason given is the opposite of the situation. Asserted only as accounted-for here, because pinning the verdict would pin the confusion.
  - `'Enregistrement en cours'` lands on needs-judgment/no-rule while its ternary sibling `'Toutes les modifications sont enregistrées'` comes back translate. Same expression, two answers — the same inconsistency traps-persistence records in a switch.

Every floor held.
