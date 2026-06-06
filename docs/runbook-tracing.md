# Runbook — online tracing (Langfuse)

> **Canonical source** for enabling/operating online tracing. The seam and data
> model are in `architecture.md` §3 and `implementation.md`; env vars are listed
> in `README.md`. This runbook is the operational + privacy guide.

## What it is

Each chat turn emits a **trace** with nested **spans** — `assemble_context`, one
`llm_call` per model call (stamped with the `promptRef`: prompt id + semver +
content hash, plus token usage), and one `tool_call` per executed tool. The seam
is `TraceSink` in `@cobble/core` (mirrors `Logger`/`UsageSink`); the only adapter
is `packages/api/src/tracing/langfuse-sink.ts`, which ships to **Langfuse Cloud**.

## ⚠️ Privacy posture (read before enabling)

Langfuse Cloud is a **third party**. This is a deliberate departure from the
default data posture (`architecture.md` §8), so the export is gated three ways
and defaults to fully off:

- **`TRACING_PROVIDER=none`** (default) → the no-op sink; nothing is emitted.
- **`TRACING_SAMPLE_RATE=0`** (default) → even with a provider set, no trace is
  sent. Sampling is deterministic per trace id (a whole turn is kept or dropped
  together — never half a trace).
- **`TRACING_REDACT=strict`** (default) → **no conversational content leaves the
  process**: only structure + metadata (span names, timings, model, token counts,
  prompt version, opaque companion/owner UUIDs). `metadata_only` is the same
  today. `off` sends content, with a defensive PII scrub (emails/phones/long
  digit runs) — use only against an internal/self-hosted Langfuse.

Residual risk even under `strict`: metadata (turn cadence, token volumes,
companion id) is still correlatable. Keep companion/owner ids opaque UUIDs.

A misbehaving adapter can **never** break a turn: the sink is wrapped
(`guardedTraceSink`) and the POST is fire-and-forget + self-catching.

## Enabling it

Set on the API service (never commit secrets — `security.md`):

```bash
TRACING_PROVIDER=langfuse
LANGFUSE_PUBLIC_KEY=pk-lf-…
LANGFUSE_SECRET_KEY=sk-lf-…
LANGFUSE_HOST=https://cloud.langfuse.com   # or your self-hosted host
TRACING_SAMPLE_RATE=0.05                    # start small
TRACING_REDACT=strict                       # keep content in-house
```

Startup fails fast if `TRACING_PROVIDER=langfuse` without both keys. With keys
missing the factory falls back to the no-op sink rather than erroring mid-run.

## OpenRouter Broadcast (optional enrichment)

OpenRouter can push provider-side generation telemetry straight to the same
Langfuse project (native integration). It bypasses our redaction scrubber, so it
is only acceptable with `TRACING_REDACT=off` (internal Langfuse). Our SDK-less
span tree is the always-available path; Broadcast is enrichment, not a
replacement.

## Verifying

With keys set, `TRACING_REDACT=strict`, and a raised sample rate, run a turn and
confirm in Langfuse a `turn` trace containing `assemble_context` / `llm_call`
(with the `promptId`/`promptSemver`/`promptHash` + token metadata) / `tool_call`
spans, and **no message content**. `redaction.test.ts` proves the scrubber;
`langfuse-sink.test.ts` proves the sampling gate and that strict drops input/output.

## Known gaps / follow-ups

- The fire-and-forget affect read runs after the turn trace closes, so it is not
  yet a child span (documented; wire as a sibling trace later).
- Validate the Langfuse ingestion event shape against a live instance before
  production use (it is default-off until then).
