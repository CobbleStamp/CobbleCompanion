# CobbleCompanion — Implementation

> **How it works internally:** data models, schemas, configuration, error handling, and security
> implementation — enough for a developer to modify the system using only this doc. For *what the
> system is* (components, flows, decisions) see `architecture.md`; for *what we're building and in
> what order* see `development-plan.md`.
>
> **Status: incremental.** Specifies **Phase 0** (`development-plan.md` §3); later phases are
> marked **_Deferred — Phase N_**.

## 1. Data Model (Phase 0)

Postgres (with `pgvector` available for later phases). Multi-tenant: every row is scoped by owner
(`architecture.md` §2, invariant #5). Field types are indicative; authoritative DDL lives in
migrations under `db/`.

### `users`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `email` | text, unique | login identity |
| `created_at` | timestamptz | |

### `companions` — the canonical "home"
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `owner_id` | uuid (FK → `users.id`) | tenancy scope |
| `name` | text | user-chosen |
| `form` | text | species/appearance archetype (seed) |
| `temperament` | text | starting personality seed (`product-overview.md` §5.5) |
| `created_at` | timestamptz | |

### `conversations`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `companion_id` | uuid (FK → `companions.id`) | |
| `created_at` | timestamptz | |

### `messages` — transcript (episodic-memory substrate)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `conversation_id` | uuid (FK → `conversations.id`) | |
| `role` | text | `user` \| `assistant` \| `system` |
| `content` | text | |
| `created_at` | timestamptz | indexed; episodic memory (P2) builds on these timestamped turns |

**_Deferred:_** semantic-memory tables + `vector` embedding columns (P1); episodic indices (P2);
procedural/skill records + approval-queue tables (P3). Added via new migrations.

## 2. Harness & Agent-Loop Internals

The design and diagrams of the loop live in `architecture.md` §4; this is the concrete mechanism.

### 2.1 Extension-point signatures

The loop defines these typed hooks (invariant #3). Phase 0 registers default no-op/passthrough
implementations; later phases supply real ones without changing the loop.

```ts
// memory-retrieval hook — assembles prior context for a turn
type RetrieveContext = (companionId: string, conversationId: string) => Promise<ContextBlock[]>;

// tool hooks — gate around every tool call (P3)
type BeforeToolCall = (call: ToolCall, ctx: TurnCtx) => Promise<ToolCall | Block>; // Block → exit-to-approve
type AfterToolCall  = (result: ToolResult, ctx: TurnCtx) => Promise<ToolResult>;   // rewrite / terminate

// initiation hook — produces a non-human ENTRY (P4)
type Initiator = (companionId: string) => Promise<Entry | null>;                   // null → stay idle
```

### 2.2 Context assembly (Phase 0)

A turn's prompt is composed, in order, from: **(1)** the companion identity row (`name`, `form`,
`temperament` → persona system prompt), **(2)** the base system prompt, **(3)** `RetrieveContext`
output — in P0 the most-recent N messages of the conversation (a recency window), later semantic
(P1) and episodic (P2) recall. The available-tools list is empty in P0.

### 2.3 Turn & loop mechanics (Phase 0)

- A **turn** = one streamed LLM call; its assistant message is parsed for tool calls. With no tools
  registered, every turn yields a no-tool-call message → the inner loop exits after one turn.
- The model response **streams** to the client (SSE/WebSocket); tokens are relayed as they arrive.
- On exit, the turn (user message + assistant message) is appended to `messages` (the transcript /
  episodic substrate, §1).

**_Deferred:_** inner-loop tool iteration + `beforeToolCall` approval enqueue (P3); progress meter +
per-run budget ceiling and the two-tier wind-down (P3+); proactive `Initiator` wiring + push (P4);
transcript compaction when the context window fills (P-later).

## 3. Configuration

Loaded from environment / a secret manager; required values validated at startup (fail fast).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection (secure connection required) |
| `LLM_PROVIDER` | Selects the gateway backend (default: `openrouter`) |
| `OPENROUTER_API_KEY` | LLM provider credential (secret — never in source) |
| `AUTH_*` | Auth/session secrets (OAuth client + session signing) |
| `PORT` / `MIN_INSTANCES` | Server port; scale-to-zero hot-path minimum (`architecture.md` §8) |

**_Deferred:_** ingestion/worker tuning, embedding model selection, proactivity cadence,
push-notification credentials (P1+).

## 4. Error Handling

- Every caught error is logged at `error` severity with context (operation, relevant
  `user`/`companion` ids — never secrets) before being handled or surfaced (`common/logging.md`).
- API boundary returns user-safe messages; internal detail stays in logs.
- LLM Gateway handles provider failures explicitly (timeout, rate limit, unavailable) and surfaces
  a typed error to the harness rather than throwing raw provider errors.

## 5. Security Implementation (Phase 0)

Implements the trust-model boundaries in `architecture.md` §8.

- **Secrets** — never hardcoded; loaded from env / secret manager; presence validated at startup.
- **Transport** — HTTPS/TLS for client traffic; secure (TLS) Postgres connections.
- **Tenancy** — every query filtered by `owner_id`/`companion_id`; authorization checked at the
  API boundary before reaching the core.
- **Input validation** — schema-validate all request bodies and all external (LLM) responses at
  the boundary before use.
- **LLM provider data handling** — user content sent to the provider is an explicit external
  trust boundary; record the chosen provider's data-retention terms here once finalized.

**_Deferred — Phase 8:_** encryption-at-rest, data inspection/management/delete controls,
on-device data locality (native surfaces), propose→approve audit trail.
