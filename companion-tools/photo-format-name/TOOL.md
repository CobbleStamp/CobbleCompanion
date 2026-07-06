# photo-format-name

Renames every **geotagged** photo in a folder, in place, to a
metadata-derived name of the form
`yyyy-MM-dd_HH-mm-ss-<CC>-<place>.<ext>`:

- **Capture time** comes from EXIF, falling back to the file's modification
  time when EXIF has none.
- **Country code + nearest place** come from the photo's GPS coordinates via
  an embedded offline gazetteer — no network calls.

Photos with **no GPS data are left untouched**.

## When to reach for it

The user wants a folder of photos renamed to sortable, human-readable names
that say *when* and *where* each shot was taken.

## Arguments

- `folder` (required) — absolute path to the directory to process. Photos are
  renamed **in place**, so this modifies the user's files.
- `dryRun` (optional) — set `true` to preview the renames without changing
  anything. **Prefer a dry run first** when the user hasn't explicitly asked to
  rename immediately, then confirm before the real run.
- `format` (optional) — `json` (default) or `text` output.

## Output

Reports each photo's old → new name (and which were skipped for lacking GPS).
Exit code is non-zero on failure.

## Notes

- Runs fully offline; needs no credentials.
- Only renames files — it never deletes them.
