# scheduler-run

Registers a **run-until-true** job with the always-on scheduler service and
starts it. Each tick the scheduler runs the **predicate** command; whenever the
predicate emits a non-empty message it runs the **action** command; and the
moment the predicate reports success the job delivers any final message and is
**deleted**. Delivery is durable and at-least-once across restarts.

Use this to set up "watch for X, then tell me" — e.g. "ping me when LITE drops
below 810" — or a recurring time-of-day wake — e.g. "every weekday at 7:30am".

## Cadence: exactly one of `every` or `cron`+`tz`

- `every` — poll on an interval (`1s`, `30s`, `15m`): "keep checking until it
  happens". Right for price/state watches.
- `cron` + `tz` — fire at times of day: a standard 5-field cron expression
  (`30 7 * * 1-5` = weekdays 07:30) evaluated in an IANA time zone
  (`Europe/London`). Right for daily/weekly routines. For a **recurring** wake,
  pair it with a predicate that reports `status:"false"` with a non-empty
  message — the action fires every match and the job stays alive; `status:"true"`
  still terminates. Pick the tz the routine belongs to (a US-market morning
  routine usually wants `America/New_York`).

## The two command strings

- `predicate` — the condition to poll. By contract it prints one JSON object to
  stdout: `{"status":"true|false|error","message":"..."}`. `status` drives the
  lifecycle (`true` terminates); a non-empty `message` drives notification **on
  any status**, so a check can stream progress, not just a final ping. For a
  plain command that can't emit that envelope, set `noContract: true` and the
  status is derived from its exit code (0 → true) with stdout as the message.
- `action` — what runs when there's a message. It **must contain the literal
  token `{{message}}`**, which the scheduler substitutes with the message as a
  single argv element (no shell — inert data).

## Delivering to Discord (the notification pattern)

To notify over Discord, make the action a `discord-notify` invocation:

```
discord-notify --text {{message}} --channel <channelId>
```

or `--user <ownerDiscordUserId>` to DM. **Supply only the non-secret channel or
user id** — never a bot token. The bot token lives in the *scheduler service's*
own environment (`SCHEDULER_DISCORD_BOT_TOKEN`), set by the operator; the
scheduler passes it to `discord-notify` for you. See `companion-tools.md` §9.
Isolation is per-destination: route each user's alerts to their own channel/DM.

## Arguments

- `predicate` (required) — the predicate command string.
- `action` (required) — the command string containing `{{message}}`.
- `every` (one-of) — poll interval as a Go duration (`1s`, `15m`, `1h`).
- `cron` (one-of) — 5-field cron expression; requires `tz`.
- `tz` (with `cron`) — IANA time zone the expression is evaluated in.
- `maxRuns` (optional) — cap the number of predicate runs; omit for unlimited.
- `maxDuration` (optional) — cap the wall-clock window (e.g. `24h`); a cron job
  expires at the boundary without a final fire; omit for unlimited.
- `noContract` (optional) — judge the predicate by exit code instead of the
  JSON envelope.

## Output

Prints `{ id, first_evaluation, next_run_at }`. An **interval** registration
runs the predicate **once immediately** (so a misconfigured check fails fast);
a **cron** registration defers to its first scheduled match — `first_evaluation`
is `null` and `next_run_at` says when it will fire. Keep the returned `id` to
`get`, `history`, or `cancel` the job later.

## Prerequisites

The scheduler service must be running on its loopback address
(`http://127.0.0.1:8787` by default). This tool needs no credentials.
