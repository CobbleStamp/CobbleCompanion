# ibkr-quote

Fetches a **live** snapshot quote for one stock symbol via the locally-running
Client Portal Gateway. Use it to answer "what's AAPL trading at right now".

## Arguments

- `symbol` (required) — the stock symbol, e.g. `AAPL`.
- `currency` (optional) — contract currency (default `USD`).
- `exchange` (optional) — routing/listing exchange (default `SMART`).
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

The live snapshot quote as JSON. This is a live value, not point-in-time.

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
