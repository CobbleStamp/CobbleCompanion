# Refactoring plan: SOLID / DRY / layering cleanup

> **Status: in progress.** Batch 1 shipped in **PR #27** (`refactor: collapse
> duplication and tighten layering across core/api`); Batch 2 (the Tier-M tasks)
> is shipped on branch `docs/solid-dry-refactor-plan`. This doc is the canonical
> record of a whole-codebase review and the **followable backlog** for the
> remaining work. Each task below is sized to land as its own reviewable PR.

> **Scope.** Structural quality only — no feature or behavior change. Every task
> is behavior-preserving unless its acceptance criteria say otherwise. The test
> suite (`vitest run`) is the safety net; a task is not done until typecheck +
> prettier + the relevant tests are green.

## 1. Why — the review in one paragraph

A review of the whole codebase against three lenses — **(1) over-engineering**
(keep it as simple as possible), **(2) SOLID & DRY**, **(3) coupling & layer
leaking** — found the architecture sound at the macro level (DIP is well
observed: services depend on store *interfaces*, no service reaches the DB
directly, no `pg`/driver type escapes `db/src/client.ts`, providers sit behind
gateways) but with duplication and a few layering smells concentrated in
identifiable places. The problems are repetitive, not structural.

## 2. The standard we refactor against

- **Layering (the gold reference): `packages/api/src/routes/discord.routes.ts`.**
  A thin transport adapter: adapt the framework request to a framework-free seam,
  delegate the real decision to a domain module (`auth/discord-token-mint.ts`),
  map the typed result to a reply. All gating + logging live in the module, not
  the handler. The target layering everywhere is **transport → domain service →
  repository → data access**.
- **SRP** — a file/class/function does one thing; god-objects get decomposed.
- **DRY** — each rule/shape/algorithm lives in exactly one place.
- **DIP** — depend on interfaces, not concretions.
- **Simplicity** — no abstraction without ≥2 callers or genuine extra logic; no
  config knobs / generality without a present need. Anemic single-call wrappers
  are a smell, not a layer.

## 3. Shipped — Batch 1 (PR #27)

Behavior-preserving DRY + layering wins, all green (1265 core+api tests):

| Fix | Bucket |
| --- | --- |
| `meterSpend()` (`quota/vitality-store.ts`) ← 11 token-debit copies (4 single-call wrappers inlined) | DRY |
| `text/untrusted.ts` — one canonical prompt-injection fence (was redefined in `harness/semantic-retrieve.ts`); relocated out of `ingestion/` | DRY + Coupling (security) |
| `memory/sql-fragments.ts` — pgvector/FTS SQL + `'english'` config centralized across 3 stores | DRY + Coupling |
| `embedding/batch.ts` (`embedInBatches`) ← duplicated batch-embed loop + `EMBED_BATCH_SIZE` | DRY |
| `isConversational()` (`memory/store.ts`) ← `(kind ?? 'message')` filter at 6 sites | DRY |
| `adjustDrivingBelief()` + shared `BELIEF_REWARD_RATE` ← reinforcement block in 2 files | DRY |
| `jobs/sweep.ts` (`sweepCompanions`) ← motivation + consolidation sweeps | DRY |
| identity `advanceCursor()` ← 3 cursor writers; harness `stoodDown()` ← 4 lease blocks | DRY |
| `ws/methods/dto.ts` (`toJobDto` dup) + parallelized `memory.snapshot` reads | DRY + layering |
| `buildBudget` moved `routes/` → `ws/methods/vitality-meter.ts` | Coupling-Layer |
| Deleted unwired `MotivationRunner`/`ConsolidationRunner` (superseded by `JobProcessorPool`) | Over-eng / dead code |

## 3b. Shipped — Batch 2 (Tier M)

Behavior-preserving, full workspace green (typecheck + prettier + 1020 core / 245
api tests):

| Fix | Bucket |
| --- | --- |
| `namespacedToolName(prefix, …segments)` (`tools/tool.ts`) ← `cliToolName`/`mcpToolName` each re-implemented the same sanitize + join + 64-char hash-truncate (M1) | DRY |
| `ProactiveActivityReader` split out of `ProactiveOutcomeStore` — read-only projections (`listDetailed` + `stats`, the joins/findings-load) separated from the hot attribution write/claim path; `growth` + `activity` now depend on the slim reader (M2) | ISP / SRP |
| Belief-salience **policy** (`SALIENCE_RANK_WEIGHT` + the `1 + W·s` rank formula → `salienceRankMultiplier`, plus `DEFAULT_BELIEF_SALIENCE`/`BELIEF_REINFORCE_STEP`) moved from `user-model/store.ts` into the `decay.ts` policy module; the store now imports policy, defines none (M3) | SRP |

> **M1 scope decision.** Only the `namespacedToolName` dedup shipped. The planned
> **Zod rewrite of `validateArgs` was reviewed and rejected** — see §5.

## 4. Backlog

Line numbers are indicative (they drift); locate by symbol. Each task is
independent unless a dependency is noted.

### Tier A — architectural (one PR each; higher risk / wider blast radius)

#### A1 · Extract `proposals.confirm` into a `confirmProposal` domain service — ✅ shipped
- **Problem.** `ws/methods/streaming.ts` `proposals.confirm` orchestrated ~7
  collaborators inline (markResolved, dispatchTool, toolCallLog, procedural,
  leads.markStatus, memory.appendMessage, harness.continueAfterApproval) with
  branching + four error-tag blocks. A use-case living in the transport layer —
  the inverse of `discord.routes.ts`.
- **Done.** `confirmProposal(deps, input): Promise<ConfirmProposalResult>` in
  `packages/api/src/proposals/confirm-proposal.ts` — a total discriminated-union
  result (`not_pending` | `confirmed{proposal, toolResult, outcomeRow}`) that
  never throws for the lost-claim case, with ISP-narrowed (`Pick`) deps mirroring
  `discord-token-mint.ts`. The handler shrank to parse → fence/over-cap →
  delegate → map (Conflict / branch on origin / stream or emit). Operation log
  tags preserved byte-for-byte.
- **Acceptance met.** ws-method + phase3 tests green; new `confirm-proposal.test.ts`
  covers the claim, success-only side-effects, tool-error path, and best-effort
  swallow. Full api suite green (250).

#### A2 · Extract `sources.file` into a `stageAndEnqueueFileSource` service
- **Problem.** `ws/methods/sources.ts` `sources.file` inlines ~70 lines of
  orchestration across `staging` + `semantic` + `ingest` + `memory`
  (upload-key auth, magic-byte validation, enqueue, best-effort transcript
  append) — no domain-service layer.
- **Approach.** `stageAndEnqueueFileSource(deps, input): Promise<Result>`;
  handler does param-parse + delegate + DTO-map.
- **Risk.** High — upload path. Pin with the sources tests.
- **Acceptance.** sources tests green; handler thin.

#### A3 · Split the `harness.ts` god class (1166 lines)
- **Problem.** `Harness` bundles ≥6 responsibilities: the agent loop, prompt
  assembly, affect perception/learning, user-model capture/embedding, token
  metering, and background-task lifecycle.
- **Approach.** Extract a `PostTurnPerception` collaborator (affect +
  user-fact capture + belief embedding + their two serialize-by-key chains) and
  a `BackgroundTaskGroup` (`trackBackground`/`whenIdle`), injected into the
  harness. Optionally extract `executeToolCalls` from `runLoop`.
- **Risk.** **Highest** — the hottest path. Land in small steps, each green.
- **Acceptance.** all harness tests green; the loop class no longer owns
  perception/embedding/background internals.

#### A4 · Decompose `web/src/pages/Chat.tsx` (~906 lines)
- **Problem.** One component owns transcript, composer, attach, proposals,
  greeting, embodiment establishment, reconnect/backoff + a two-layer event
  buffer, and room-takeover, across ~18 `useState`/`useRef`. The web polling
  hooks (`useIngestionJobs`/`useProposals`/`usePresenceHeartbeat`) re-implement
  mount-guard + timer.
- **Approach.** Extract `useEmbodimentSync()` (subscription/buffer/reconnect),
  split `<ChatTranscript>` / `<ChatComposer>`, and a shared `usePolling(fetcher,
  intervalMs, isActive)`.
- **Risk.** Medium — isolated to `packages/web`, test-covered (`Chat.test.tsx`).
- **Acceptance.** web tests green; no behavior change.

#### A5 · Unify the triplicated WS transport
- **Problem.** The same WS envelope/transport (a `StreamQueue`, `SupersededError`,
  the `'stream'|'result'|'error'` demux, the embodiment-ready/superseded
  lifecycle) is implemented three times against the same `@cobble/shared`
  message union: `web/src/api/ws.ts`, `discord/src/ws-client.ts`,
  `api/src/test/ws-client.ts`.
- **Approach.** A shared transport (a `@cobble/shared` submodule or small
  package) parameterized by a socket factory (the seam already exists in
  `ws-client.ts` as `WsSocket`/`WsSocketFactory`).
- **Risk.** Medium-high — cross-package; preserves the documented discord↔core
  decoupling (transport speaks only `@cobble/shared`).
- **Acceptance.** web + discord + api tests green against the shared transport.

#### A6 · Split `shared/contracts.ts` (1213 lines) into a `contracts/` barrel
- **Problem.** One file spans ~12 domains (messages, upload, ingestion, the WS
  envelope, motivation, growth, economy, memory, user-model, discord, citations,
  errors). Organization, not bloat (no dead schemas) — but a module-level SRP miss.
- **Approach.** Split by domain into `contracts/*.ts` with an `index.ts`
  re-export; the `@cobble/shared` import surface stays identical. Move the
  `Ws*Message` envelope into the shared transport module from A5.
- **Risk.** Low-medium — wide but mechanical; typecheck catches misses.
- **Acceptance.** full workspace typecheck green; import surface unchanged.

## 5. Reviewed and intentionally NOT changed

- **discord `gateway/types.ts` local `Logger`.** Deliberate, documented
  decoupling — the discord package imports nothing from `@cobble/core`, and
  core's `Logger` has a stricter signature (`error(message, context)` required).
  Deduping would couple two intentionally-independent packages. Keep.
- **A fully-generic `hybridSearch` helper.** Considered and rejected as
  over-engineering — three callers each need a different subset (joins, vector
  floor, stale filter, salience weight). `memory/sql-fragments.ts` (shipped) was
  the right-sized extraction; the per-store search bodies stay.
- **Rewriting `cli/adapter.ts` `validateArgs` to Zod (the dropped half of M1).**
  The tool's `parameters` is **runtime data** authored in `TOOL.json`, and it
  **must exist as JSON Schema** — it's what `toToolDef` advertises to the LLM.
  Zod fits *statically-known* schemas; here we'd have to write a JSON-Schema→Zod
  compiler (no such precedent anywhere in the repo) of roughly the same size as
  the current 47-line validator — so no simplification, and it introduces a
  **second representation of the same contract** that must stay in sync with the
  JSON Schema. That's a DRY *regression* at a security boundary. The current
  validator checks directly against the single source of truth, and the real
  injection defense is `renderArgv` + `unsafeArgvPlaceholders`, not this contract
  check. Keep the direct validator.

## 6. Sequencing & PR strategy

1. **Batch 2 = M1 + M2 + M3** (one branch/PR) — ✅ shipped (§3b); finishes the
   medium tier (M1 reduced to the `namespacedToolName` dedup — Zod rewrite
   dropped, §5).
2. **A1** ✅ shipped (`confirmProposal`); **A2** next — the WS-method layer
   extractions (the flagship layering fix); one PR each, hot path, land carefully.
3. **A4** — `Chat.tsx`; isolated, can go in parallel with the API work.
4. **A5 → A6** — A5 first (it owns the moved `Ws*Message` envelope), then A6.
5. **A3** — the harness split; highest risk, do it on its own with the most care,
   ideally after the others so the tree is otherwise settled.

Every PR: behavior-preserving, `pnpm -r run typecheck` + `pnpm lint` +
`vitest run` green, and verified against this doc's acceptance criteria.
