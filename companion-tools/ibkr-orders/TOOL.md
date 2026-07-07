# ibkr-orders

Lists the account's **open and completed orders for the day** (read-only) via
the locally-running Client Portal Gateway. Use it to answer "what orders do I
have today", "did my order fill".

## Arguments

- `account` (optional) — account id; omit for the primary account.
- `output` (optional) — `json` (default) | `ndjson` | `table`.

## Output

The day's orders as JSON. Read-only — this never places or modifies an order.

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host and logged in.
No credentials are passed by the companion.
