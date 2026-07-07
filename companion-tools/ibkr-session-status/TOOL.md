# ibkr-session-status

Reports the IBKR Client Portal Gateway **session status** as JSON — whether the
gateway is running and the login session is live. Read-only: it only checks
status, it never logs out or ends the session.

Use it first when other `ibkr-*` tools fail with a gateway/auth error, to tell
the user whether they need to log the gateway back in.

## Arguments

None.

## Output

The gateway session status as JSON (authenticated / connected flags).

## Prerequisites

The IBKR Client Portal Gateway must be running on the same host. If it is up but
not logged in, this reports that — which is exactly the diagnostic you want.
