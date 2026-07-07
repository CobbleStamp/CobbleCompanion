# scheduler-history

Shows the per-tick evaluation history of one scheduler job — each run's status,
any message it produced, and timing. Use it to see what a watch has observed so
far, or to debug why a job did or didn't fire.

## Arguments

- `id` (required) — the job id (e.g. `job_3f9c1a`).
- `limit` (optional) — max records to return; omit or `0` for the server
  default.
- `since` (optional) — only records at/after this RFC3339 timestamp
  (e.g. `2026-07-06T00:00:00Z`).

## Output

A JSON array of evaluation records, most useful newest-first.

## Prerequisites

The scheduler service must be running on its loopback address
(`http://127.0.0.1:8787` by default). No credentials needed.
