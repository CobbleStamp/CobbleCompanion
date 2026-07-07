# scheduler-get

Shows one scheduler job by id — its predicate/action, interval, state, run
counts, and last evaluation.

## Arguments

- `id` (required) — the job id returned by `scheduler-run` (e.g. `job_3f9c1a`).

## Output

The job as a JSON object. Returns a not-found error if the id is unknown (e.g.
the job already terminated on success or was cancelled).

## Prerequisites

The scheduler service must be running on its loopback address
(`http://127.0.0.1:8787` by default). No credentials needed.
