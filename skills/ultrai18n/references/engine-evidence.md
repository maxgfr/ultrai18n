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

If resolving an extractor defect requires reading source code, report that as
engine debugging outside the translation run. Do not expand a translator's file
access to compensate for missing engine evidence.
