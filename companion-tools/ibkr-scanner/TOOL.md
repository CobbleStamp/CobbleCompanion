# ibkr-scanner

Runs an IBKR **market scanner** (read-only) via the locally-running Client
Portal Gateway and returns the ranked results. Use it to answer "what are
today's top gainers", "scan for the most active stocks".

## Arguments

- `scan` (required) — the scan type, e.g. `TOP_PERC_GAIN`.
- `instrument` (optional) — scan instrument (default `STK`).
- `location` (optional) — scan location (default `STK.US.MAJOR`).
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

The scanner's ranked matches as JSON.

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
