# ibkr-history

Historical OHLCV price bars for a stock over a period, via the locally-running
Client Portal Gateway. Use it to answer "how has AAPL moved over the last
month", "give me daily bars for the past year" — and, with `indicator`, to get
**computed technical values** (moving averages, RSI, Bollinger bands) instead
of doing the arithmetic yourself.

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
- `indicator` (optional) — an array of technical metrics computed over the
  bars, e.g. `["sma20", "sma50", "sma200", "rsi14"]`. Supported: `sma<N>`,
  `ema<N>`, `rsi<N>` (Wilder), `atr<N>`, `high<N>d`, `low<N>d`,
  `pct_change<N>d`, `bbupper<N>`/`bbmid<N>`/`bblower<N>`, and `bb<N>` (all
  three bands; optional `kM` std-dev multiplier, e.g. `bb20k2`).
- `tail` (optional) — emit only the last N bars (`>= 1`).

## Computing indicators (never by hand)

**Never compute MAs/RSI from raw bars yourself** — ask for them. Indicators are
computed over the **full fetched series** and `tail` is applied afterwards, so
truncating output never changes a value. The fetch is NOT auto-extended: a
window longer than the fetched series yields `null` (the tool warns on stderr).
Size the period to the longest window — `sma200` on daily bars needs `1y`.

The one-call pattern for "current 20/50/200-day MAs and RSI(14)":

```
period: "1y", indicator: ["sma20","sma50","sma200","rsi14"], tail: 2
```

→ two bars (prior day + latest), each carrying an `indicators` map with the
computed values.

## Output

An array of OHLCV bars as JSON; with `indicator`, each bar gains an
`indicators` map (`null` until a window has enough bars).

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
