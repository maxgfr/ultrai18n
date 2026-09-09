# Engine evidence

Use the engine's census, inventory, extraction spans and verification reports to
assess coverage. Keep those reports separate from the translator input: a
translator receives only the approved string records and returns translations.
The engine owns source-file reads, byte offsets and writes.

For a missing or disputed string, inspect its inventory record and the engine's
reported reason. Re-run the relevant extractor or verification command when the
record is incomplete. Record skipped paths, unsupported formats and extraction
limits alongside the result; a complete file census alone does not establish
complete string extraction.

Report concrete examples of protected identifiers alongside translatable text,
and separate the file census, extracted sites, reviewed decisions and runtime
coverage. A scan's `recallClaim` does not prove that its classifications are right.

Matching words do not prove a catalog entry is used by code. Establish the
lookup/formatter relationship before calling an entry used or diagnosing a
placeholder mismatch. JavaScript `${name}`, catalog `{name}` and normalized
engine `{0}` can belong to different layers. Their spelling alone is not a bug;
without a demonstrated consumer, report runtime integration as unknown. Never
recommend renaming placeholders merely to make these layers look alike.

If resolving an extractor defect requires reading source code, report that as
engine debugging outside the translation run. Do not expand a translator's file
access to compensate for missing engine evidence.
