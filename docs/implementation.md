# CobbleCompanion — Implementation

> **How it works internally:** data models, schemas, configuration, error handling, and security
> implementation — enough for a developer to modify the system using only this doc. For *what the
> system is* (components, flows, decisions) see `architecture.md`; for *what we're building and in
> what order* see `development-plan.md`.
>
> **Status: incremental.** Specifies **Phases 0–1** (`development-plan.md` §3); later phases are
> marked **_Deferred — Phase N_**.

## 1. Data Model (Phases 0–1)

Postgres (with `pgvector` available for later phases). Multi-tenant: every row is scoped by owner
(`architecture.md` §2, invariant #5). Field types are indicative; authoritative DDL lives in
migrations under `db/`.

### `users`
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `email` | text, unique | login identity |
| `created_at` | timestamptz | |

> **Auth note:** there is no local credential/token table. Sign-in is **Google Sign-In**; the
> SPA obtains a Google ID token and the API validates it against Google's JWKS, then
> JIT-provisions the `users` row from the verified `email` claim (Google requires
> `email_verified === true`). See §5.

### `companions` — the canonical "home"
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `owner_id` | uuid (FK → `users.id`) | tenancy scope |
| `name` | text | user-chosen |
| `form` | text | species/appearance archetype (seed) |
| `temperament` | text | starting personality seed (`product-overview.md` §5.5) |
| `created_at` | timestamptz | |

### `messages` — transcript (episodic-memory substrate)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `seq` | bigserial | monotonic per-row ordinal — authoritative chronological order |
| `companion_id` | uuid (FK → `companions.id`) | indexed with `seq` (`messages_companion_idx`) for recency recall |
| `role` | text | `user` \| `assistant` \| `system` |
| `content` | text | |
| `created_at` | timestamptz | episodic memory (P2) builds on these timestamped turns |

> **One conversation per companion.** There is deliberately **no `conversations`/session
> table** (`architecture.md` invariant): a companion has exactly one continuous, lifelong
> conversation with its user, so messages attach directly to the companion. The whole
> conversation is `SELECT * FROM messages WHERE companion_id = ? ORDER BY seq`. This makes a
> second conversation structurally impossible.

> **Ordering note:** recency recall orders by `seq`, not `created_at` — many turns can share a
> `created_at` at sub-millisecond resolution, so a monotonic ordinal is the source of truth for
> transcript order. `seq` is a single global sequence, so it orders the whole transcript.

### `sources` — Layer 0: verbatim originals (Phase 1)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `companion_id` | uuid (FK → `companions.id`, cascade) | tenancy scope |
| `kind` | text | `pdf` \| `note` \| `link` \| `txt` \| `md` \| `docx` \| `pptx` — free text typed via `$type<SourceKind>()`, so new formats need no migration; accepted-format/MIME contract → `architecture.md` §4.8 |
| `title` | text | display title ("your Peru book") |
| `origin` | text, nullable | filename / URL; null for notes |
| `raw_text` | text | **canonical** extracted text — everything derived is rebuildable from it |
| `byte_size` | integer, nullable | |
| `created_at` | timestamptz | |

### `ingestion_jobs` — reading-progress surface (Phase 1)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` / `source_id` | uuid | cascade FKs |
| `status` | text | `queued → parsing → segmenting → enriching → embedding → done` \| `failed` |
| `sections_total` / `sections_done` | integer | drives "read N of M" |
| `error` | text, nullable | user-safe failure reason; detail stays in logs |
| `created_at` / `updated_at` | timestamptz | |

> The durable status surface is what makes the in-process runner replaceable by a real worker
> with no schema/API change (`architecture.md` §4.8, §8).

### `sections` — Layer 1: retrieval units (Phase 1)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` / `source_id` | uuid | cascade FKs; companion denormalized for filtered retrieval |
| `chapter_title` | text, nullable | structural parent label |
| `topic_title` | text | Pass-1 segmentation output |
| `original_text` | text | **pure verbatim** paragraph slice — never model-rewritten |
| `context_header` | text, nullable | Pass-2 one-liner; prefixed onto the **embedding input only** |
| `para_start` / `para_end` | integer | 1-based inclusive paragraph range (provenance) |
| `page_start` / `page_end` | integer, nullable | PDF page range |
| `ord` | integer | section order within its source |
| `embedding` | `vector(1024)` | nullable until the embed pass; dimension pinned by `EMBEDDING_DIMENSIONS` (db schema) — changing it requires a migration |
| `fts` | tsvector, generated | `to_tsvector('english', original_text)` |

Indexes: HNSW (`vector_cosine_ops`) on `embedding` — chosen over IVFFlat because it needs no
training set and fits incremental ingestion; GIN on `fts`; btree on `(companion_id)` and
`(source_id, ord)`.

### `facts` — Layer 2: typed knowledge overlay (Phase 1)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` | uuid | cascade FK |
| `section_id` | uuid (FK → `sections.id`, cascade) | **provenance — non-nullable by contract** (`ontology.md` §4) |
| `fact_type` | text | closed core set, validated at ingestion (`ontology.md` §2) |
| `subject` / `predicate` / `object` | text (predicate nullable) | entities are denormalized strings (normalization deferred, `ontology.md` §5) |
| `confidence` | real, nullable | extraction self-reported (0–1), advisory |

### Hybrid retrieval (Phase 1 mechanism)

`SemanticMemoryStore.search` runs two arms over `sections` scoped by `companion_id` —
**vector** (`embedding <=> query` cosine, top-K) and **lexical** (`fts @@ plainto_tsquery`,
`ts_rank`-ordered, top-K) — and fuses them with **reciprocal-rank fusion**
(score = Σ 1/(60 + rank)), which is scale-free so the two scores never need calibrating.
Optional metadata filters: `source_id`, and `entity` (an EXISTS over the fact overlay's
subject/object — how a section whose text only says "he" is still found by "Pizarro"). Every
hit carries provenance (source title, chapter, topic, para/page range) + the verbatim text.

**_Deferred:_** episodic indices (P2); procedural/skill records + approval-queue tables (P3).
Added via new migrations.

## 2. Harness & Agent-Loop Internals

The design and diagrams of the loop live in `architecture.md` §4; this is the concrete mechanism.

### 2.1 Extension-point signatures

The loop defines these typed hooks (invariant #3). Phase 0 registers default no-op/passthrough
implementations; later phases supply real ones without changing the loop.

```ts
// memory-retrieval hook — assembles prior context for a turn. Takes the
// current user content because query-dependent recall (P1 semantic memory
// embeds the question) needs it; the P0 recency window ignores it. The object
// param keeps future fields additive — this was the one P1 hook-signature change.
interface RetrieveParams { companionId: string; userContent: string }
type RetrieveContext = (params: RetrieveParams) => Promise<ContextBlock[]>;

// a context block may carry provenance (P1 semantic recall); the harness
// surfaces a turn's provenance as a `citations` stream event before `done`
interface ContextBlock { role: MessageRole; content: string; provenance?: Citation[] }

// tool hooks — gate around every tool call (P3)
type BeforeToolCall = (call: ToolCall, ctx: TurnCtx) => Promise<ToolCall | Block>; // Block → exit-to-approve
type AfterToolCall  = (result: ToolResult, ctx: TurnCtx) => Promise<ToolResult>;   // rewrite / terminate

// initiation hook — produces a non-human ENTRY (P4)
type Initiator = (companionId: string) => Promise<Entry | null>;                   // null → stay idle
```

**Phase 1 implementation** (`packages/core/src/harness/semantic-retrieve.ts`): embeds
`userContent` via the Embedding Gateway, hybrid-searches the semantic store (§1), renders each
hit as a system-role grounding block (locating preamble + verbatim passage) with structured
`provenance`, then appends the recency window. Embedding-provider failure logs and degrades to
recency-only — recall never breaks the conversation.

### 2.2 Context assembly (Phases 0–1)

A turn's prompt is composed, in order, from: **(1)** the companion identity row (`name`, `form`,
`temperament` → persona system prompt), **(2)** the base system prompt, **(3)** `RetrieveContext`
output — P1: top-K semantic grounding blocks (verbatim sections with source/para preambles)
followed by the most-recent N transcript messages (the recency window); later episodic (P2)
recall. The available-tools list is still empty.

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
| `LLM_PROVIDER` | Selects the gateway backend: `openrouter` (default) \| `fake` |
| `OPENROUTER_API_KEY` | LLM provider credential (secret — required when provider=`openrouter`) |
| `LLM_MODEL` | Model id passed to the provider |
| `AUTH_MODE` | `google` (default) \| `dev_bypass` (local/test — skips Google) |
| `GOOGLE_CLIENT_ID` | OAuth Web client ID — public, served to the SPA and used as the API's ID-token audience (required when `AUTH_MODE=google`) |
| `DEV_BYPASS_EMAIL` | Identity resolved in `dev_bypass` mode |
| `APP_URL` | Web client origin (allowed CORS origin for local cross-origin dev) |
| `PORT` | Server port (Cloud Run injects this) |
| `EMBEDDING_PROVIDER` | `openrouter` (default) \| `fake` (tests/offline dev) |
| `EMBEDDING_MODEL` | Embedding model id (default `perplexity/pplx-embed-v1-0.6b`) |
| `EMBEDDING_DIM` | Requested embedding dimensionality (default 1024) — **must equal** the `sections.embedding` `vector()` column dimension; the API fails fast at startup on mismatch, and changing it requires a migration |
| `INGESTION_MODEL` | Cheap model for the two ingestion reading passes (default `google/gemini-2.5-flash`) — input-heavy, output-bounded (`architecture.md` §4.8) |
| `INGESTION_MAX_BYTES` | Source upload size cap, also the link-fetch body ceiling (default 25 MiB) |
| `USE_CONTEXT_HEADER` | `true` (default) \| `false` — prefix the Pass-2 context header onto embedding inputs (the eval A/B knob, `companionmemory.md` §5) |
| `RATE_LIMIT_WINDOW_MS` | Window for the per-owner rate limits on LLM/embedding-spend routes (default 60 000 ms) |
| `INGESTION_RATE_MAX` | Max source submissions (file/note/link) per owner per window (default 10) |
| `SEARCH_RATE_MAX` | Max memory searches per owner per window (default 30) |
| `INGESTION_QUEUE_MAX` | Backstop cap on queued+in-flight ingestion runs across all owners; submissions past it get 429 (default 100) |

**_Deferred:_** worker tuning, proactivity cadence, push-notification credentials (P2+).

## 4. Error Handling

- Every caught error is logged at `error` severity with context (operation, relevant
  `user`/`companion` ids — never secrets) before being handled or surfaced (`common/logging.md`).
- API boundary returns user-safe messages; internal detail stays in logs.
- LLM Gateway handles provider failures explicitly (timeout, rate limit, unavailable) and surfaces
  a typed error to the harness rather than throwing raw provider errors.

## 5. Security Implementation (Phase 0)

Implements the trust-model boundaries in `architecture.md` §8.

- **Secrets** — never hardcoded; loaded from env / secret manager; presence validated at startup.
- **Authentication** — **Google Sign-In** (Google as the OIDC provider). The SPA uses Google
  Identity Services (`@react-oauth/google`) to obtain a Google **ID token** and sends it as a
  `Bearer` header; the Fastify API validates the RS256 token against Google's JWKS
  (issuer `accounts.google.com`, audience = `GOOGLE_CLIENT_ID`, expiry, `jose`), requires
  `email_verified === true`, and JIT-provisions the user from the verified `email` claim.
  `AUTH_MODE=dev_bypass` skips all of this for local dev/tests. (ID tokens last ~1h; an app-issued
  session JWT is a documented future upgrade.)
- **Transport** — HTTPS/TLS for client traffic; secure (TLS) Postgres connections.
- **Tenancy** — every query filtered by `owner_id`/`companion_id`; authorization checked at the
  API boundary before reaching the core.
- **Input validation** — schema-validate all request bodies and all external (LLM) responses at
  the boundary before use.
- **LLM provider data handling** — user content sent to the provider is an explicit external
  trust boundary; record the chosen provider's data-retention terms here once finalized.

**_Deferred — Phase 8:_** encryption-at-rest, data inspection/management/delete controls,
on-device data locality (native surfaces), propose→approve audit trail.
