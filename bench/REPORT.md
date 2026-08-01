# ultrai18n bench — 9 case(s), 101 expectation(s)

```
  accounting coverage     101/101     1.000   ok
  expectation mismatches  0                   ok
  trap violations         0                   ok
  census mismatches       0                   ok
  gate mismatches         0                   ok
  anchor drift            0                   ok
  determinism             9/9                 ok
```

## catalog coverage — 20 rule(s) exercised, 0 never

## by case

### census-edges — Every path git tracks lands in one bucket with a reason

```
  12/12 accounted   24 site(s)   17 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - A markdown HTML block is consumed only while its lines keep containing a `<`. Running to the next blank line instead was measurably worse: an HTML-ish line followed by ordinary prose swallowed the prose and handed it to a scanner that found no tags in it. The cost of the narrower rule is that a multi-line `<div>` with a blank line inside it is read as two blocks, which affects the anchor and not the recall.

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

### surfaces-scripts — The four formats that used to have no reader: .py, .sh, .sql, .jsonl — plus the ignore files that share the shell's comment syntax

```
  10/10 accounted   22 site(s)   6 tracked path(s)
  G1 pass  G2 pass  G3 fail  G4 fail  G5 pass  G6 pass  G7 pass
```

  Known gaps, gated by nothing:
  - A shell script's STRINGS are never emitted, only its comments. `echo "Terminé"` is a real miss and a deliberate one: emitting shell arguments hands a translator a wall of paths, flags and package names to refuse one at a time.
  - Four regions are deliberately NOT sites, and G2 is what gates that rather than an expectation: a `#!` shebang, a `# type:` directive, a `# shellcheck` directive, and every line of DDL. `mustNotClaim` cannot express them — it means "this site exists and must not be translate", so declaring one would fail accounting for a region that correctly has no site. Without the .sql reader that DDL sweeps into the inventory as unclassified and G2 fails, which is exactly the silencing this case measures.
  - `.ini`, `.conf`, `.cfg` and `.properties` also use `#` comments and are not shell. Handing one to the bash grammar buys unparseable regions in exchange for comments the sweep already surfaces, so each is its own decision with its own case.
  - A SQL literal carrying prose is emitted and left to the classifier. Whether a seed row is copy or a fixture is not something the lexer can know.

### surfaces-web-app — Where user-visible text hides in a web project: build configs, CI, store listings

```
  23/23 accounted   93 site(s)   11 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 fail  G7 pass
```

  Known gaps, gated by nothing:
  - `html.title` cannot fire. The rule matches `{kind: attr, element: title, attr: text}`, but the HTML extractor emits a document title as a `prose-run` at `title/text[0]`. The title IS found and IS translated — by the generic prose path, with no rule cited — so the miss is in traceability rather than in recall.
  - `manifest/lang` inside `rspack.config.ts` comes back with no verdict at all, where the same field in `manifest.webmanifest` is a `locale-marker`. The companion matcher lists vite, nuxt, astro and next; its parent rule lists nine more bundlers including rspack. A locale marker left undetected in a build config is exactly the G6 `locale-drift` finding this tool advertises.
  - An inline <script> is swept rather than parsed, so its strings arrive as `unclassified` instead of carrying container semantics. Routing the body to the AST tier would give real verdicts; it needs the async grammar load that lives in `scan`, and the sweep already makes the text impossible to miss.

### traps-interop — Formats other tools depend on, and text the licence forbids rewriting

```
  10/10 accounted   24 site(s)   5 tracked path(s)
  G1 pass  G2 fail  G3 fail  G4 fail  G5 pass  G6 fail  G7 pass
```

  Known gaps, gated by nothing:
  - `'XMLHttpRequest'` still lands on needs-judgment/ambiguous-role. Its two neighbours are now decided — the header names as identifiers, `fr-FR` as a locale marker — and this one is left because a lone capitalised token genuinely is ambiguous: nothing structural separates a protocol constant from a product name, and refusing is the right outcome. What changed is that it is now the ONLY refusal in the object rather than one of four.
  - `postgres://localhost:5432/atelier` is no longer a site. The shell reader emits comments and claims everything else as read and non-textual, so a connection string is silenced instead of surfacing as `unclassified` — the same trade the .sql reader makes. It cannot be written as a `mustNotClaim` expectation, which requires a covering site; the gate that holds it is G2 on this case.

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
