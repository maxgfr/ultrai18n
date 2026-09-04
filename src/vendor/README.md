# Vendored from codeindex

`walk.ts`, `ignore.ts`, `glob.ts`, `util.ts` and `text.ts` are forked from
[`@maxgfr/codeindex`](https://github.com/maxgfr/codeindex) v2.28.4 (MIT, same author).

They are here rather than as a dependency because the shipped engine must be a single
zero-dependency `.mjs` that runs with no install step.

**Do not rewrite `ignore.ts`.** Its gitignore semantics were verified by differential testing
against `git check-ignore`, and a hand-rolled reimplementation will be subtly wrong in ways that
only show up as missing files — which is precisely the failure mode this project exists to prevent.

## Deliberate divergences from upstream

Four additive changes. Each is marked `// ULTRAI18N:` at its site.

1. **`.svg` removed from `BINARY_EXT`.** SVG is text and carries `<title>`, `<desc>` and `<text>`.
   Upstream skips it because it holds no code symbols; here it holds user-visible copy.
2. **`walk()` returns `skipped: {rel, reason}[]`** and `skippedDirs` instead of an anonymous
   `excluded` counter. The census has to account for every tracked path by name and reason; a
   number cannot be audited. Upstream's nested-repository boundary — a subdirectory carrying its
   own `.git` is not descended into — lands here as `skippedDirs: 'nested-repo'`
   rather than as `excluded++`, and in `skippedDirs` rather than `skipped` because a submodule is
   tracked as a gitlink at the *directory's* own path, and files under a vendored clone are
   attributed through the directory too.
3. **`readTextEx()`** alongside `readText()`. Upstream returns `""` for an empty file *and* for a
   binary one; the census must distinguish "scanned, no text found" from "could not be read".
   Lifting `readText()` out of `walk.ts` into `text.ts` leaves `walk.ts` without it, so the local
   `readGitignore()` stands in at upstream's two call sites — the per-directory `.gitignore` and
   `.git/info/exclude`. Both are UTF-8 by definition, and the full decoder would pull a cycle
   between the two files.
4. **Census walk mode** (`includeLockfiles`, `includeBinary`, `includeOversize`). Upstream drops
   these silently; the census must list them so a human can see what was not read.

Upstream's own behaviour is otherwise preserved, including the two documented gitignore deviations:
no re-inclusion inside an ignored directory, and always case-sensitive matching.

## The pin

codeindex enters this repository twice, and a fork that drifts from the package it ships beside is
two versions of the same walker in one binary:

- **These files**, forked from four upstream sources (`text.ts` is upstream's `readText()` lifted
  out of `walk.ts`).
- **The npm package**, imported by `src/ast/parse.ts` for grammar provisioning and inlined by tsup —
  so codeindex code ships *inside* `skills/ultrai18n/scripts/ultrai18n.mjs`, and its `.wasm`
  grammars are committed beside it. It is pinned to an **exact** version, never a caret: a silent
  minor bump would change shipped bytes nobody reviewed.

`engine.meta.json` holds one pin for both, plus two sets of hashes: `base` (the upstream bytes this
fork was taken from) and `vendored` (these files, as reviewed).

```
node scripts/sync-engine.mjs --ref <tag>     # re-pin to a codeindex release tag
node scripts/sync-engine.mjs --check         # offline gate, run by CI
node scripts/sync-engine.mjs --accept        # re-record a deliberate edit to these files
```

A fork cannot be gated by comparing bytes to upstream — they are *supposed* to differ. What is
gated is the fork base: `--ref` fetches the four upstream sources at the new tag and **refuses the
re-pin if any of them moved**, printing the upstream diff, because a moved base means one of the
four deltas above has to be re-applied by hand. Re-apply it, update this file if a delta changed,
then record the new base with `--ref <tag> --base-reviewed`.

Editing these files otherwise fails `--check`, which is the point: they read like upstream, so an
unrecorded edit is the change review is least likely to catch. Document it here, then `--accept`.

`.github/workflows/engine-repin.yml` runs the whole thing daily against the newest codeindex
release: green gates push the re-pin to `main`, and anything red pushes nothing and asks for a human.
