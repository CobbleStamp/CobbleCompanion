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
4. Where it matters, A/B old vs new offline (`pnpm eval --prompt-version=…`,
   Phase B) before merging.

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
