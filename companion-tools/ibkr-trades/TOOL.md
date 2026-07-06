# ibkr-trades

Lists the account's **recent executions** (roughly the last 7 days, read-only)
via the locally-running Client Portal Gateway. Use it to answer "what have I
traded recently", "show my fills this week".

## Arguments

- `account` (optional) — account id; omit for the primary account.
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

Recent executions as JSON. Read-only.

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
