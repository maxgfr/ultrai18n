# ultrai18n

Find every human-readable string in a repository, classify it, translate it with cheap models, and
prove nothing was missed.

## Why

Asking an AI to "change the language of this repo" fails silently. It translates the React
components and the README, then misses `package.json`'s `description`, the web app manifest inlined
in `vite.config.ts`, the GitHub issue templates, the release-notes body nested inside a workflow
YAML, the screenshots with rendered UI text, and the file of comments nobody opened. The failure is
not translation quality — it is **recall**. The miss is in what was never looked at, and prompting
harder does not fix that.

The opposite failure costs more. Translate a string that happens to be a persisted enum value and
every existing user's data stops parsing. Translate a CSV column header and you break an export
format other tools depend on. Translate a test fixture that exists to exercise quote escaping and
the test still passes while testing nothing.

ultrai18n is built to be right in both directions, and to be checkable rather than trusted.

## The claim

It does **not** claim to classify every string correctly. It claims:

> No byte of any scannable, decodable, tracked file leaves the pipeline unaccounted for, and every
> tracked path lands in exactly one census bucket.

"We found every string" is unfalsifiable. "Nothing was dropped without a recorded reason" is a gate
that fails loudly. Anything unclaimed and human-looking is forced into the inventory as
`unclassified`, and `check` refuses to pass while one remains.

## How it works

A deterministic zero-dependency engine finds and classifies the text; a model only ever translates
short strings it is handed, and never touches a file:

```
engine  →  { "u:7f21c9": "Yes, erase it all" }
model   →  { "u:7f21c9": "Oui, tout effacer" }
engine  →  writes apps/web/.../DataSection.tsx at bytes 4187-4204
           ✓ 412/412 applied, 0 drift
```

The model never opens a source file. That keeps the cost proportional to the text rather than the
codebase, and removes any opportunity to reformat, drop or "improve" surrounding code.

## Install

```sh
npx skills add maxgfr/ultrai18n            # this project
npx skills add maxgfr/ultrai18n --global   # every project
```

No build step, no API key, no network. The tree-sitter grammars ship with the engine.

## Status

The pipeline works end to end: `scan` → `plan` → `translate` → `apply` → `verify` → `check`, plus
`sync`, `orchestrate` and `init --ci --baseline`.

Translation backends: a generic CLI (`--translator '<command>'`), direct HTTP (`--backend api`), and
manual. `--backend subagent` writes the batches and the agent contract and hands over, because the
engine cannot spawn a Claude Code agent and will not pretend to.

On a fully French reference repository, `scan` finds 2956 text sites across 91 files and separates
them into what to translate, what is an identifier and must not be touched, and what it refuses to
decide. Among the finds are four French comments in a stylesheet that two separate human translation
passes both missed.

## License

MIT
