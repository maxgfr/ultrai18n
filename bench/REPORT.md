# ultrai18n bench — 8 case(s), 84 expectation(s)

```
  accounting coverage     84/84       1.000   ok
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
  7/7 accounted   15 site(s)   16 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

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
  11/11 accounted   25 site(s)   5 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 fail  G7 pass
```

  Known gaps, gated by nothing:
  - `'XMLHttpRequest'` still lands on needs-judgment/ambiguous-role. Its two neighbours are now decided — the header names as identifiers, `fr-FR` as a locale marker — and this one is left because a lone capitalised token genuinely is ambiguous: nothing structural separates a protocol constant from a product name, and refusing is the right outcome. What changed is that it is now the ONLY refusal in the object rather than one of four.

### traps-persistence — Values that leave the process: translating one corrupts data, and no gate would catch it

```
  15/15 accounted   45 site(s)   4 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

### traps-test-fixtures — Strings that exist to be compared, not read: assertions, ARIA, class names, date patterns, keys

```
  14/14 accounted   48 site(s)   6 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

Every floor held.
