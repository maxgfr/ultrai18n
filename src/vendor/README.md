# Vendored from codeindex

`walk.ts`, `ignore.ts`, `glob.ts` and `util.ts` are vendored from
[`@maxgfr/codeindex`](https://github.com/maxgfr/codeindex) v2.22.0 (MIT, same author).

They are here rather than as a dependency because the shipped engine must be a single
zero-dependency `.mjs` that runs with no install step.

**Do not rewrite `ignore.ts`.** Its gitignore semantics were verified by differential testing
against `git check-ignore`, and a hand-rolled reimplementation will be subtly wrong in ways that
only show up as missing files — which is precisely the failure mode this project exists to prevent.

## Deliberate divergences from upstream

Four additive changes. Each is marked `// ULTRAI18N:` at its site.

1. **`.svg` removed from `BINARY_EXT`.** SVG is text and carries `<title>`, `<desc>` and `<text>`.
   Upstream skips it because it holds no code symbols; here it holds user-visible copy.
2. **`walk()` returns `skipped: {rel, reason}[]`** instead of an anonymous `excluded` counter. The
   census has to account for every tracked path by name and reason; a number cannot be audited.
3. **`readTextEx()`** alongside `readText()`. Upstream returns `""` for an empty file *and* for a
   binary one; the census must distinguish "scanned, no text found" from "could not be read".
4. **Census walk mode** (`includeLockfiles`, `includeBinary`, `includeOversize`). Upstream drops
   these silently; the census must list them so a human can see what was not read.

Upstream's own behaviour is otherwise preserved, including the two documented gitignore deviations:
no re-inclusion inside an ignored directory, and always case-sensitive matching.
