# ibkr-resolve

Resolves a stock symbol to an IBKR **contract id (conid)**, via the
locally-running Client Portal Gateway. Ambiguous symbols surface the candidate
contracts so you can disambiguate. Useful as a lookup step before other
symbol-based queries.

## Arguments

- `symbol` (required) — the stock symbol, e.g. `AAPL`.
- `currency` (optional) — contract currency (default `USD`).
- `exchange` (optional) — routing/listing exchange (default `SMART`).
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

The resolved conid, or a list of candidates for an ambiguous symbol, as JSON.

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
