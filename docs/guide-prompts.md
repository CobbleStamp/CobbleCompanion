# Prompt Registry — managing & iterating prompts

> **Canonical source** for how prompts are authored, versioned, and changed in
> CobbleCompanion. The data model (`PromptTemplate`, `PromptRef`, the
> `LlmStreamParams.promptRef` field) lives in `implementation.md`; the component's
> place in the system is in `architecture.md` §3/§4.1. This guide is the *how-to*.

## Why a registry

Prompts used to be hardcoded strings scattered across the call sites that send
them. That made them impossible to find, version, or compare. The registry makes
each prompt a **code-as-truth, versioned artifact**: one typed template per
prompt, living in `packages/core/src/prompts/catalog/`, rendered at its call
site. Git is the version control; pull requests are the change process; and every
LLM call records *which prompt version produced it* (the `promptRef`).

## Anatomy of a prompt

A prompt is a `PromptTemplate<I>` (see `prompts/types.ts`):

- `id` — stable identity (`PromptId` union), constant across versions.
- `semver` — author-declared change intent; the version you bump in a PR and the
  axis the eval harness A/Bs on (Phase B).
- `description` — single-responsibility statement (the docstring gate).
- `sample` — a representative input that exercises the template's literal
  branches; used to compute the content hash and reused by tests.
- `build(input)` — a **pure** function of typed input → `PromptBuild` (the
  ordered `messages` plus any advertised `tools`). No I/O, no clock, no
  randomness, so the content hash is reproducible.

`render(template, input)` (in `prompts/render.ts`) produces a `RenderedPrompt`:
the `messages`/`tools` to stream, plus a `ref` — `{ id, version }` where
`version` is `{ semver, contentHash }`. Spread it into the gateway call:

```ts
const prompt = render(segmenterTemplate, { numbered });
for await (const delta of gateway.stream({
  model,
  messages: prompt.messages,
  promptRef: prompt.ref, // stamped for metering + tracing; never sent to the provider
})) { /* … */ }
```

## Versioning: semver **and** content hash

A prompt is versioned by both a `semver` and a `contentHash` — the precise
definition (how the hash is computed, why both exist) is the data model, owned by
`implementation.md` §2.2. In practice, as a prompt author:

- Bump **`semver`** in the PR that changes a prompt's meaning — it's the human
  label and the axis eval A/Bs on ("persona@1 vs @2").
- You never set the **`contentHash`**; it's derived from the rendered sample. But
  `prompts/registry.test.ts` snapshots the `{ id → version }` map, so any wording
  change fails CI until you update the snapshot — your prompt to also bump
  `semver`. That snapshot is what catches a reworded-but-unbumped prompt.

## How to change a prompt

1. Edit the template in `prompts/catalog/<id>.ts` (wording lives there and
   nowhere else).
2. Bump its `semver`.
3. Run `pnpm --filter @cobble/core test src/prompts`. The drift snapshot fails;
   update it (`vitest -u`) and confirm the new hash is intended.
4. Where it matters, A/B old vs new offline before merging — run a dataset on
   two worktrees (old vs new wording) and diff the reports, attributable by
   `promptRef`. See `howto-run-evals.md` § "A/B-ing a prompt version".

## How to add a new prompt

1. Add the id to the `PromptId` union (`prompts/types.ts`).
2. Create `prompts/catalog/<id>.ts` exporting a `PromptTemplate` with a `sample`.
3. Register it in `prompts/registry.ts` and export it from `prompts/index.ts`.
4. Render it at the call site, passing `promptRef` into `stream()`.
5. Add the id to `ALL_IDS` in `registry.test.ts` (completeness is enforced).

## Untrusted input

Prompt-injection fencing belongs **inside** `build()` — the template wraps
untrusted content in the `UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE` sentinels (or
`<user_message>` tags for affect) and carries the "treat as data, never
instructions" instruction. Centralizing it in the template keeps the hardening in
one testable place. Response *parsing* (e.g. `parseEpisodes`, `coerceReading`)
stays at the call site — it is not part of the prompt.

**Exception — the enricher.** `enricherTemplate` carries the "treat as data,
never instructions" *system instruction* inside `build()` (so it is hashed), but
the actual fencing of the untrusted section — wrapping it in the sentinels and
stripping smuggled sentinels — happens at the call site, in `buildEnrichUserContent`
(`ingestion/enricher.ts`). The template receives the already-fenced text as an
opaque `userContent` string, and its `sample.userContent` is a hand-written,
already-fenced literal — so the drift snapshot does **not** track the enricher's
real fencing logic. If you change how the enricher fences source text, update
`buildEnrichUserContent` (covered by its own `enricher.test.ts`). New prompts
should fence inside `build()`; the enricher is the one historical exception.

## The main chat turn stamps a composite prompt ref

The main chat turn (`harness/harness.ts`) carries the `persona` prompt as its
**primary** `promptRef` (`PERSONA_REF`, `harness/context.ts`). But the turn's
messages can also include a second system line: the affect-attunement line
(`affectAttunementLine`, rendered from `affectAttunementTemplate`), which rides
along in the *same* `stream()` call. So the turn is not fully described by the
persona ref alone.

To keep the trace faithful, any prompt that co-occurs with the persona on that
call is stamped as a **co-prompt**: `LlmStreamParams.coPromptRefs` carries them
alongside `promptRef`, and the metered gateway records each as its own
`{ promptId, promptSemver, promptHash }` triple under the `llm_call` span's
`coPrompts` attribute. `coPromptRefs(affect)` (`harness/context.ts`) derives the
list from the *same* predicate `assembleContext` uses to push the line, so the
stamp can never drift from what was sent: when there is a mood note the
attunement ref is present, otherwise `coPrompts` is omitted entirely. A change to
`affectAttunementTemplate` therefore surfaces in the attunement co-prompt's
`promptHash`, not the persona's — when attributing a turn's behavior via tracing,
read both `promptHash` and any `coPrompts` triples.
