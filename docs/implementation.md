# CobbleCompanion — Implementation

> **How it works internally:** data models, schemas, configuration, error handling, and security
> implementation — enough for a developer to modify the system using only this doc. For *what the
> system is* (components, flows, decisions) see `architecture.md`; for *what we're building and in
> what order* see `development-plan.md`.
>
> **Status: incremental.** Specifies **Phases 0–4** (`development-plan.md` §3); later phases are
> marked **_Deferred — Phase N_**.

## 1. Data Model (Phases 0–4)

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
| `temperament` | text | **immutable** starting personality seed (`product-overview.md` §5.5) |
| `evolved_persona` | text, nullable (P2) | "who I've become with you" — re-synthesized from episodes, blended into the persona prompt beside the seed; null until the first evolution |
| `persona_updated_through_seq` | bigint, default 0 (P2) | transcript `seq` the evolved persona was last synthesized from (evolution cursor) |
| `consolidated_through_seq` | bigint, default 0 (P2) | highest transcript `seq` already rolled into episodes (consolidation cursor) |
| `created_at` | timestamptz | |

### `messages` — transcript (episodic-memory substrate)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `seq` | bigserial | monotonic per-row ordinal — authoritative chronological order |
| `companion_id` | uuid (FK → `companions.id`) | indexed with `seq` (`messages_companion_idx`) for recency recall |
| `role` | text | `user` \| `assistant` \| `system` |
| `content` | text | |
| `kind` | text | `message` \| `tool_step` \| `proposal` — `$type<MessageKind>()`, default `message` (P3). What the row *is*, so the rich conversation (grounded answers, read-only look-ups, held actions) reconstructs identically on reload. **Only `message` rows enter the LLM-context projection** (`getMessagesSince` and the recency window filter to `kind='message'`); `tool_step`/`proposal` are UI chrome — never re-fed to the model nor consolidated into episodes |
| `metadata` | jsonb | nullable `MessageMetadata` (P3): `citations` on a grounded `message`; `toolName` on a `tool_step`; `toolName`+`proposalId` on a `proposal` (the id wires the row to the live approval queue). Lets the surface re-render the row faithfully |
| `source_id` | uuid (FK → `sources.id`, **`ON DELETE SET NULL`**) | nullable; set on a file upload's attachment chip (a `user` turn) and its acknowledgement (an `assistant` turn) so the chat reconstructs the 📎 chip + "View status →" link on reload. `SET NULL` (not cascade): deleting a source must never delete an append-only transcript turn — it just drops the link |
| `created_at` | timestamptz | episodic memory (P2) builds on these timestamped turns |

> **Proactive ingestion notes.** A successful or failed read appends a single `assistant` turn
> here via the **Ingestion Announcer** (`packages/core/src/ingestion/announcer.ts`): an
> in-character note generated through the metered LLM gateway (debited to the owner's daily cap),
> with a single-sourced **canned fallback** (`@cobble/shared`) when the owner is over cap, when
> generation throws, or when no persona is available. It is appended *before* the job's terminal
> status flip, and an announcement failure is logged but never alters the job outcome
> (`architecture.md` §4.8). These notes carry no `source_id` (no chip/link — just a message).

> **One conversation per companion.** There is deliberately **no `conversations`/session
> table** (`architecture.md` invariant): a companion has exactly one continuous, lifelong
> conversation with its user, so messages attach directly to the companion. The whole
> conversation is `SELECT * FROM messages WHERE companion_id = ? ORDER BY seq`. This makes a
> second conversation structurally impossible.

> **Ordering note:** recency recall orders by `seq`, not `created_at` — many turns can share a
> `created_at` at sub-millisecond resolution, so a monotonic ordinal is the source of truth for
> transcript order. `seq` is a single global sequence, so it orders the whole transcript.

### `episodes` — consolidated episodic memory (Phase 2)
| Field | Type | Notes |
|---|---|---|
| `id` | uuid (PK) | |
| `companion_id` | uuid (FK → `companions.id`, cascade) | tenancy scope; indexed `(companion_id, occurred_end)` for the time-window filter + "latest episodes" scans, and `(companion_id, seq_end)` for the cursor |
| `summary` | text | the consolidated narrative ("you loved the ceviche in Lima…") |
| `seq_start` / `seq_end` | bigint | transcript `seq` range this episode consolidated — idempotent, incremental rebuilds |
| `occurred_start` / `occurred_end` | timestamptz | wall-clock span the episode covers; rendered as the date on each recalled block. The store can also filter recall to a time window, but no recall path passes one yet (see note) |
| `salience` | real, nullable | self-reported 0–1 weight, stored and displayed only. Filler is dropped at consolidation (the reflection pass omits it); recall ranking (RRF) does **not** use this value (see note) |
| `embedding` | `vector(1024)`, nullable | HNSW `vector_cosine_ops`; nullable → recalled lexically until embedded |
| `fts` | tsvector (generated from `summary`) | GIN-indexed |
| `created_at` | timestamptz | |

> **Derived, not canonical.** Episodes are a rebuildable overlay over the one transcript (no
> session entity — invariant #6). A background **consolidation** pass reflects the
> un-consolidated tail (`seq > companions.consolidated_through_seq`) into episodes and advances
> the cursor atomically; recall is the same vector + FTS hybrid (RRF) as `sections` —
> **topic-only** in production (`architecture.md` §4.3, §4.8). Personality evolution reads recent
> episodes to re-synthesize `companions.evolved_persona`.
>
> **Recall scope (P2).** Two episode signals exist in the store but are **not wired into recall**:
> (1) the **wall-clock time window** — `EpisodicStore.searchEpisodes` accepts an optional
> `after`/`before` filter (unit-tested), but neither the harness episodic arm nor the
> `/episodes/search` API passes one (`episodeSearchSchema` has no time fields, and nothing parses
> time from a turn), so production recall is topic-only and the `occurred_*` span is only a date
> annotation on the rendered block; (2) **salience** is ignored by RRF — it ranks by fused
> vector/FTS rank alone. Filler never reaches recall because the consolidation pass omits it, not
> because salience down-weights it. Wiring either into recall is deferred.

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
| `status` | text | `queued → parsing → segmenting → enriching → embedding → done` \| `failed`; `deferred` is off-line (parsed, awaiting the daily token cap to reset — `architecture.md` §4.8) |
| `sections_total` / `sections_done` | integer | drives "read N of M" |
| `error` | text, nullable | user-safe failure reason; detail stays in logs |
| `parsed_doc` | jsonb, nullable | parsed paragraphs held while `deferred`, so the AI passes resume without a re-upload; null otherwise |
| `created_at` / `updated_at` | timestamptz | |

> The durable status surface is what makes the in-process runner replaceable by a real worker
> with no schema/API change (`architecture.md` §4.8, §8), and lets deferred jobs survive a restart.

### `user_token_usage` — daily token cap state (Phase 1)
| Field | Type | Notes |
|---|---|---|
| `user_id` | uuid (PK, FK → `users.id`, cascade) | one row per user |
| `window_reset_at` | timestamptz | when the current fixed-daily (UTC) window rolls; overage carries as debt clamped to one cap |
| `used_tokens` | bigint | tokens spent in the current window (LLM + embedding) |
| `cap_override` | integer, nullable | per-account cap; null → the `TOKEN_CAP_PER_DAY` default |
| `top_up_tokens` | bigint, default 0 | manual feed grant; effective cap = `(cap_override ?? default) + top_up_tokens`. Added by an atomic SQL increment (concurrent feeds can't lose an update), persists across window rolls, and — being separate from `cap_override` — keeps tracking later changes to the default. Mirrors `companion_energy` exactly. |
| `updated_at` | timestamptz | |

> Postgres-backed so the cap is correct across replicas. Routes enforce it inline: chat/search
> 429 over cap, ingestion defers (`architecture.md` §4.8). `GET /usage` exposes the standing for
> the web client's live indicator. The manual top-up (`POST /companions/:id/budget/topup`, the Feed control)
> raises `top_up_tokens`; the per-user stamina store is the structural twin of the per-companion
> energy store (`packages/core/src/quota/stamina-store.ts` ↔ `energy-store.ts`).

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
(score = Σ 1/(K + r), with K=60 and r the 1-based rank within each arm), which is scale-free so the two scores never need calibrating.
Optional metadata filters: `source_id`, and `entity` (an EXISTS over the fact overlay's
subject/object — how a section whose text only says "he" is still found by "Pizarro"). Every
hit carries provenance (source title, chapter, topic, para/page range) + the verbatim text.

### `proposals` — approval queue (Phase 3)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` | uuid | cascade FK |
| `lead_id` | uuid, nullable | FK → `leads.id` (`on delete set null`). The reading-list lead this proposal came from (explore-origin); null for a chat-origin proposal. Resolving the proposal advances this lead's lifecycle |
| `tool_name` | text | the effectful tool the companion wants to run |
| `tool_args` | jsonb | the serialized call, run verbatim once approved |
| `tool_call_id` | text, nullable | the provider's tool-call id (audit/correlation) |
| `summary` | text | human-readable description shown in the approval card |
| `status` | text `$type<ProposalStatus>` | `pending` → `approved`/`rejected` |
| `created_at` / `resolved_at` | timestamptz (resolved nullable) | |

> **Exactly-once:** confirm/reject is a conditional update `WHERE status='pending'` that returns the
> row only to the winner (mirrors the deferred-job claim, `architecture.md` §4.8), so a double-confirm
> cannot double-execute. Index `(companion_id, status)`.
>
> **Lead closure:** resolving an explore-origin proposal advances its `lead_id` — a successful confirm
> marks the lead `ingested`, a reject marks it `discarded` (best-effort, never fails the user's action).
> Without the link a lead would be stranded at `read` forever — clogging `/leads` and never re-proposed.

### `tool_calls` — audit log (Phase 3)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` | uuid | cascade FK |
| `seq` | bigserial | monotonic order (`created_at` ties within a ms) |
| `name` / `args` / `result` | text / jsonb / text | one row per executed call — the DoD's "every tool call is logged" |
| `created_at` | timestamptz | |

### `leads` — reading-list inventory (Phase 3)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` | uuid | cascade FK |
| `seq` | bigserial | stable reading-list order |
| `url` | text | unique per `(companion_id, url)` → re-discovery is idempotent |
| `why` | text, nullable | where it was captured (the page it came from) |
| `status` | text `$type<LeadStatus>` | `new` → `read` → `ingested`/`discarded` |
| `created_at` | timestamptz | |

> The body-then-will substrate: filled by `web_fetch` link harvest, worked on command in P3
> (`/explore`), and by the motivation engine on idle in P4 (`architecture.md` §4.5).
>
> **Lifecycle:** `/explore` advances `new`→`read` and enqueues a proposal carrying the lead's id; the
> terminal states are written when that proposal resolves — confirm→`ingested`, reject→`discarded` (see
> `proposals.lead_id`). `/leads` lists only `new`+`read`, so a resolved lead leaves the reading list.

### `procedural_memories` — learned workflows (Phase 3 seed)
| Field | Type | Notes |
|---|---|---|
| `id` / `companion_id` | uuid | cascade FK |
| `seq` | bigserial | newest-first listing |
| `title` | text | the approved action's summary |
| `steps` | jsonb | ordered tool names the workflow ran |
| `created_at` | timestamptz | |

> Seeded on a successful approved action; browse-only — retrieval-as-hint is deferred to P5.

### Phase 4 — Proactivity Engine (✅ built)

The schema the motivation engine uses (full mechanism → `companion-motivation.md`; migrations
`0012` two-pool budget + companion knobs/dial/weights + proposals.origin, `0013` proactive_outcomes).

- **`proposals.origin`** — `text` enum `chat | explore | autonomous`, default `chat`. Lets the
  confirm route re-enter the loop only for `chat`-origin proposals (the §4.4 resolution) and bill
  effectful work to the right budget pool (chat→stamina, explore/autonomous→energy).
- **`companions`** gains: `proactivity_dial` (`off | gentle | active`, default `gentle` — the
  tunability dial); `personality_knobs` (jsonb `{focusLength, boredom, distractibility}` — the
  "creature" constants; **default constants in the PoC**, personalized via onboarding later, null →
  defaults); `drive_weights` (jsonb — per-drive weights the reinforcement loop updates; **starts
  neutral**, null → neutral defaults).
- **`companion_energy`** (new) — the **energy** pool (self-initiated work), mirroring
  `user_token_usage` (which becomes the **stamina** pool) but keyed per **companion**: window reset,
  used tokens, a manual top-up grant. Separate counters so autonomy can't starve interaction (§4.8).
- **`companion_affect`** (new, migration `0015`, Phase 4.2) — the companion's **rolling read of the
  user's mood**, one row per companion: `valence` ∈ [−1, 1] + a short natural-language `note`. The
  agent loop upserts it every user turn (last-write-wins); the prior read is fed forward to attune the
  next reply, and the turn-over-turn change is the reinforcement signal (`companion-motivation.md` §7).
  The read is taken via a structured **`report_affect` tool call** (named `valence` + `note` fields,
  provider-parsed) — no free-text parsing; a missing/malformed call degrades to neutral.
- **`proactive_outcomes`** (new) — one row per initiation for the reinforcement loop: the served
  drive, a drive snapshot at initiation, the linked **`note_message_id`** (the report note the user
  reacts to — migration `0014`), and the **reward** once resolved. **Phase 4.2: the reward is the
  *change* in the user's mood** across their reaction to the note (`delta = valence_now −
  valence_before`, sensed in the agent loop), applied as an additive nudge — not approve/reject, and
  not the 4.1 absolute-valence critic. Doubles as the helpful-vs-annoying measurement. (`proposal_id`
  is retained nullable for legacy rows.)

Presence is **not** a table — it is a volatile, heartbeat-fed in-memory signal (§4.5).

**_Deferred:_** growth/progression records + the stamina/energy game economy (P5); deeper RL policy
beyond the v1 EMA weight update. Added via new migrations.

## 2. Harness & Agent-Loop Internals

The design and diagrams of the loop live in `architecture.md` §4; this is the concrete mechanism.

### 2.1 Extension-point signatures

The loop defines these typed hooks (invariant #3). Phase 0 registers default no-op/passthrough
implementations; later phases supply real ones without changing the loop.

```ts
// memory-retrieval hook — assembles prior context for a turn. Takes the
// current user content because query-dependent recall (P1 semantic memory
// embeds the question) needs it; the P0 recency window ignores it. The object
// param keeps future fields additive. P1 changed both ends of this signature:
// the new `userContent` param AND the return — it now yields a RetrieveResult
// carrying the blocks plus the `usage` spent recalling them (the query
// embedding), so the harness can meter the whole turn against the daily
// cap (`user_token_usage`, §1).
interface RetrieveParams { companionId: string; userContent: string }
interface RetrieveResult { blocks: readonly ContextBlock[]; usage: TokenUsage }
type RetrieveContext = (params: RetrieveParams) => Promise<RetrieveResult>;

// a context block may carry provenance (P1 semantic recall); the harness
// surfaces a turn's provenance as a `citations` stream event before `done`
interface ContextBlock { role: MessageRole; content: string; provenance?: Citation[] }

// tool hooks — gate around every tool call (P3 ✅). The gate writes a pending
// proposal + returns Block for an effectful call (→ exit-to-approve); afterToolCall
// receives the executed call so it can log name+args+result.
type BeforeToolCall = (call: ToolCall, ctx: TurnCtx) => Promise<ToolCall | Block>;
type AfterToolCall  = (result: ToolResult, call: ToolCall, ctx: TurnCtx) => Promise<ToolResult>;
// TurnCtx carries { companionId, ownerId } so tools scope tenant state + bill tokens.

// initiation hook — produces a non-human ENTRY (P4)
type Initiator = (companionId: string) => Promise<Entry | null>;                   // null → stay idle
```

**Phase 1 implementation** (`packages/core/src/harness/semantic-retrieve.ts`): embeds
`userContent` via the Embedding Gateway, hybrid-searches the semantic store (§1), renders each
hit as a system-role grounding block with structured `provenance`, then appends the recency
window. Embedding-provider failure logs and degrades to recency-only — recall never breaks the
conversation.

Each grounding block is prompt-injection hardened: a trusted preamble (declaring everything
below it untrusted, titles included) is followed by a sentinel-fenced region holding **all**
document-derived strings — source/chapter/topic titles and the verbatim passage. Titles are
attacker-influenced (source/chapter titles come from ingested documents; topic titles are
LLM-derived from them), so they are sanitized before rendering: fence sentinels stripped
(repeated until stable, defeating splice recombination), control characters/newlines flattened,
length capped. Only numeric locators (paragraph/page ranges) render as trusted text. Citation
`provenance` carries titles verbatim — sanitization is prompt-only; UI rendering escapes
separately.

### 2.2 Context assembly (Phases 0–2)

A turn's prompt is composed, in order, from: **(1)** the companion identity row (`name`, `form`,
`temperament` → persona system prompt — P2 blends in `evolved_persona` beside the seed when
present), **(2)** the base system prompt, **(3)** `RetrieveContext` output. The hook is one slot;
`composeRetrieveContext` runs the arms in order — **P2 episodic** memory blocks (time-anchored,
fenced), then **P1** top-K semantic grounding blocks (verbatim sections with source/para
preambles), then the most-recent N transcript messages (the recency window, appended once by the
semantic arm). Each arm degrades independently. **P3:** the registry's tool list is advertised to
the gateway via `LlmStreamParams.tools` (not the prompt text); prior tool-call/result turns are
replayed into the message array in the OpenAI wire shape.

### 2.3 Turn & loop mechanics (Phases 0–3)

- A **turn** = one streamed LLM call; the gateway returns a `StreamResult { usage, toolCalls }`. With
  no tools registered, `toolCalls` is empty → the inner loop exits after one turn (the P0 path).
- **P3 inner loop:** when a turn returns tool calls, each is run through `beforeToolCall` — a read-only
  call dispatches via `dispatchTool` and its result re-enters as a `tool`-role message for the next
  turn; an **effectful** call is BLOCKED. **All** effectful calls in a turn are collected (not just the
  first) and each enqueues a `proposals` row; the loop then EXITs. `afterToolCall` logs every executed
  call. The model response **streams** throughout; usage accrues across all turns, debited once at exit.
- **Transcript fidelity (P3):** the loop persists what the user sees so it survives reload — a grounded
  answer carries its `citations` in `metadata`; each read-only call writes a friendly `tool_step` row
  (`Tool.stepSummary`) and emits a `tool_step` stream event; each held action writes a `proposal` row
  and emits a `proposal` event. `ChatStreamEvent` therefore spans `token` / `citations` / `tool_step` /
  `proposal` / `done` / `error`. The web reconciles against the transcript after any turn that produced
  tool-step/proposal rows (live == reload).
- **Approval re-entry:** the confirm route resolves the proposal exactly once, executes + logs the held
  call, writes its outcome as a `tool_step` row, then calls `Harness.continueAfterApproval` — which
  retrieves recent context, injects the outcome as an **ephemeral** observation (the persisted row is
  UI-only and filtered from context), and runs the loop so the companion narrates and continues. No new
  user message is persisted; the response **streams** back over SSE like a normal turn.
- **Streamed tool calls:** the OpenRouter gateway accumulates `choices[].delta.tool_calls` fragments
  by `index` (the first carries id+name+partial args, later frames append arg-string pieces) and
  `JSON.parse`s the assembled arguments at `[DONE]`; malformed args degrade to `{}` (failures are
  data) rather than throwing.
- **Dead-loop guard (§4.7):** the loop is bounded by `DEFAULT_MAX_TOOL_ITERATIONS` and an optional
  per-run token budget (both `HarnessOptions`, defaults in `harness.ts`); hitting either
  exits-with-partial.
- On exit, the turn is appended to `messages` (the transcript / episodic substrate, §1).

**_Deferred:_** proactive `Initiator` wiring + push (P4); transcript compaction when the context
window fills (P-later).

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
| `TOKEN_CAP_PER_DAY` | Per-user daily token cap (LLM + embedding) — the cost guardrail across all routes; fixed daily UTC window, overage carries as clamped debt (default 1 000 000). Per-account override → `user_token_usage.cap_override` |
| `INGESTION_QUEUE_MAX` | Backstop cap on queued+in-flight ingestion runs across all owners; submissions past it get 429 (default 100) |

**P3 tuning constants** are in-code defaults (not secrets, so not env-wired): the loop ceilings
`DEFAULT_MAX_TOOL_ITERATIONS` (default 6) + the optional per-run token budget (`harness.ts`,
overridable via `HarnessOptions`), `web_fetch`'s returned-text cap (`web-fetch.ts`, default 8000
chars) and link-harvest cap (`MAX_HARVESTED_LINKS`, default 20), and the `/explore` burst size
(`inventory.routes.ts`, default 3).

**_Deferred:_** worker tuning, proactivity cadence + intensity dial, push-notification credentials (P4+).

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
  session JWT is a documented future upgrade.) An **expired** token is an expected client condition,
  not a server fault: the API guard classifies `jose`'s `ERR_JWT_EXPIRED` and logs it at `info`
  (no stack), reserving `error`-level logs for genuine verification anomalies (bad signature, wrong
  audience, missing claims).
- **Client session persistence** — the SPA persists the ID token to **`sessionStorage`**
  (`packages/web/src/auth/session.ts`) so a page refresh restores the session instead of bouncing to
  the sign-in gate. On load the token is restored synchronously before the first authenticated
  request; its `exp` is decoded client-side (no verification — the API remains the authority) and an
  already-expired token is dropped rather than sent. `sessionStorage` (not `localStorage`) is a
  deliberate posture: the credential survives refresh and in-tab navigation but clears on tab/browser
  close. Because the ID token lives ~1h with no refresh token, this only restores a session within
  that window; full silent refresh / 401-driven re-auth is a future upgrade.
- **Transport** — HTTPS/TLS for client traffic; secure (TLS) Postgres connections.
- **Tenancy** — every query filtered by `owner_id`/`companion_id`; authorization checked at the
  API boundary before reaching the core.
- **Input validation** — schema-validate all request bodies and all external (LLM) responses at
  the boundary before use.
- **LLM provider data handling** — user content sent to the provider is an explicit external
  trust boundary; record the chosen provider's data-retention terms here once finalized.

**_Deferred — Phase 8:_** encryption-at-rest, data inspection/management/delete controls,
on-device data locality (native surfaces), propose→approve audit trail.
