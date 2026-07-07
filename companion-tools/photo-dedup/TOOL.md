# photo-dedup (report-only)

Scans `dedupDir` and reports every image whose content is **byte-identical**
(SHA-256 + a byte-for-byte verify) to an image in the trusted, read-only
`sourceDir` library. Runs fully offline.

## Report-only by design

This wrapper **always runs in `--dry-run` mode** — it lists the duplicates it
finds but **never removes or moves any file**. The underlying CLI can delete
duplicates, but that capability is intentionally not exposed here, because
whitelisted tools run without a per-call approval gate. If the user wants
duplicates actually removed, do it as a separate, explicitly-confirmed step
outside this tool.

## When to reach for it

The user wants to know which photos in one folder are already present in their
main library, without touching anything.

## Arguments

- `dedupDir` (required) — absolute path to the folder to scan.
- `sourceDir` (required) — absolute path to the trusted library to compare
  against. Never modified.
- `format` (optional) — `json` (default) or `text` output.

## Output

Lists each duplicate found in `dedupDir` and the source image it matches. Exit
code is non-zero on failure.
