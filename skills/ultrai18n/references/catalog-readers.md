# Keyed catalog readers

Use the existing `scan → plan → translate → apply --write → verify → check --semantic`
workflow. `verify` and `check` refresh the live files themselves; keep the original inventory
for source provenance. Each value is anchored by its decoded key, not its line number.

## Accepted source syntax

- Apple `.strings`: double-quoted `"key" = "value";` entries, including several on one line;
  `//` and `/* */` comments. Escapes: backslash, double quote, `n`, `r`, `t`, `f`, `b`,
  four-hex-digit `u`/`U`. Literal multiline strings, unquoted keys and octal escapes are refused.
- Java `.properties`: `key=value`, `key:value` or whitespace-separated entries, escaped keys,
  LF/CRLF lines and continued values. `#`/`!` comments are metadata. Leading unescaped value
  whitespace is ignored; trailing spaces are significant. Continued keys, CR-only lines and
  keys with no separator are refused; write an empty value as `key=`. Java escape semantics
  apply, including dropping a backslash before an otherwise unrecognised escape letter.
- Duplicate decoded keys or malformed syntax invalidate the whole file. No partial subset is
  treated as a complete catalog. Correct the residual before planning translation.

Comments, keys and unaffected bytes remain unchanged. Only UTF-8 source files (optionally BOM)
are writable. Recognised UTF-16/BOM and Latin1 sources can be inventoried, but `apply` refuses
their non-byte-addressable offsets; convert deliberately to UTF-8 first, then start a new scan.
New non-ASCII characters are written as Unicode escapes, so the new value is ASCII-safe.
This is not an automatic whole-file encoding converter.

`.strings` values are classified as Apple UI copy. `.properties` under `locales/` are locale
messages; elsewhere the ordinary classifier decides, since Java properties can be configuration.
Locale source files retain the normal locale-protection rules.

## Formatting tokens and verification

`apply` checks a decoded roundtrip and preserves the exact multiset of recognised printf/
NSString tokens (`%@`, `%1$@`, `%d`, `%%`, etc.) and simple numbered MessageFormat tokens
(`{0}`, `{0,number}`). Their order may change; adding or losing one is refused. This is token
preservation, not validation of every runtime formatting dialect, MessageFormat apostrophe
semantics, nested choice patterns or plural correctness. Keep those structures unchanged and
review them with the consumer's tests. These readers do not introduce a new plural dialect.

Syntax references: [Apple strings resources](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/LoadingResources/Strings/Strings.html),
[Java Properties](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/Properties.html),
[PropertyResourceBundle](https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/util/PropertyResourceBundle.html).
