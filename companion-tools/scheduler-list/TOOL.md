# scheduler-list

Lists every job currently registered with the scheduler service — their ids,
state (active/paused), predicate/action, and interval.

Use it to see what watches are currently set up before adding, inspecting, or
cancelling one.

## Arguments

None.

## Output

A JSON array of jobs. Use a job's `id` with `scheduler-get`,
`scheduler-history`, or `scheduler-cancel`.

## Prerequisites

The scheduler service must be running on its loopback address
(`http://127.0.0.1:8787` by default). No credentials needed.
