# ibkr-history

Historical OHLCV price bars for a stock over a period, via the locally-running
Client Portal Gateway. Use it to answer "how has AAPL moved over the last
month", "give me daily bars for the past year".

## Arguments

- `symbol` (required) — the stock symbol, e.g. `AAPL`.
- `bar` (optional) — bar size: `1min`, `5min`, `1h`, `1d`, `1w`, `1m`
  (default `1d`).
- `period` (optional) — lookback span in IBKR syntax (`1d`, `1w`, `1m`, `1y`;
  default `1m`). Use **either** `period` **or** `from`/`to`, not both.
- `from` / `to` (optional) — explicit range `YYYY-MM-DD`.
- `asOf` (optional) — point-in-time date `YYYY-MM-DD`; filters bars to on/before
  that date.
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

An array of OHLCV bars as JSON.

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
