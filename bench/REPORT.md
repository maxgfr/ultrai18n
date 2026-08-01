# ultrai18n bench — 8 case(s), 84 expectation(s)

```
  accounting coverage     84/84       1.000   ok
  expectation mismatches  0                   ok
  trap violations         0                   ok
  census mismatches       0                   ok
  gate mismatches         0                   ok
  determinism             8/8                 ok
```

## catalog coverage — 20 rule(s) exercised, 0 never

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

### plural-unread-dialects — Six plural arrangements, each read by the format it belongs to

```
  6/6 accounted   37 site(s)   6 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - gettext's `nplurals=N` header is read verbatim and used by nothing. Comparing it against the number of `msgstr[n]` present would find a live rendering bug, and it is deliberately not done: reading half a header invites the reader to believe the whole thing is understood, and `plural=` is a C expression this engine will not evaluate.

### surfaces-polyglot-manifests — Package descriptions across ecosystems — and the three catalog rules that cannot fire

```
  6/6 accounted   24 site(s)   5 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

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
