# scheduler-cancel

Cancels and forgets one scheduler job — stops its polling and deletes its
definition. Use it to remove a watch the user no longer wants.

This affects **only the single job** identified by `id`. It does not stop the
scheduler service or touch any other job.

## Arguments

- `id` (required) — the job id to cancel (e.g. `job_3f9c1a`). Get it from
  `scheduler-list` or the `scheduler-run` response.

## Output

Succeeds silently (no body) when the job is cancelled. Confirm the target with
`scheduler-get` or `scheduler-list` first if you are unsure which job the id
refers to.

## Prerequisites

The scheduler service must be running on its loopback address
(`http://127.0.0.1:8787` by default). No credentials needed.
