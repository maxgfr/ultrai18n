# Shared engine

The committed codeindex bundle and declarations are copied without modification
from the release recorded in `engine.meta.json`. `skill.json` declares its minimum
version and the exact grammar-provisioning development dependency. Both advance
in the same repin; the shipped skill still runs without an install.

`src/walk.ts` supplies inventory policy (SVG is text and selected binary formats
may carry human-readable content). Traversal, exclusions, gitignore, decoding and
byte-coordinate conversion are codeindex primitives, not local forks.
