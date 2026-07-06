# ibkr-portfolio

Reads the IBKR account's **live** state (read-only) via the locally-running
Client Portal Gateway: positions, cash ledger, account summary, P&L, or the list
of accounts. Use it to answer "what do I hold", "what's my P&L", "how much cash
do I have", "which accounts do I have".

## Arguments

- `view` (optional) — `positions` | `ledger` | `summary` | `pnl` | `accounts`
  (default `positions`).
- `account` (optional) — account id; omit for the primary account.
- `where` (optional) — filter rows on a column, e.g. `position != 0`.
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

The requested view as JSON. Account state is live (not point-in-time).

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in
(its browser session, refreshed ~daily). No credentials are passed by the
companion — the gateway holds the session. If a call fails with a gateway/auth
error, check the session with `ibkr-session-status`.
