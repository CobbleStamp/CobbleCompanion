# CobbleCompanion — Technical Architecture

> **What it is:** components, responsibilities, interactions, and flows — enough for a new
> engineer to draw the system on a whiteboard. For the product's *what & why* see
> `product-overview.md`; for *scope & priorities* see `development-plan.md`; for *internal
> mechanisms* (data models, schemas, config, security implementation) see `implementation.md`.
>
> **Status: incremental.** Built up phase by phase; currently specifies **Phases 0–4**
> (`development-plan.md` §3). Content for later phases is marked **_Deferred — Phase N_**. The
> **Architectural Invariants** (§2) are the exception — load-bearing boundaries fixed now.

## 1. Purpose & Scope

CobbleCompanion is **one cloud-resident companion** (`model + harness + memory`) reached through
**surfaces** it embodies in, one at a time (`product-overview.md` §2). The architecture's job is
to keep that companion *core* surface-agnostic so surfaces (web now; mobile, desktop later) plug
in as clients. **Phase 0** delivered the smallest end-to-end slice: a user creates a Cobble on the
**web** surface and holds a persisted, single continuous conversation (§2, invariant #6).
**Phase 1** adds the knowledge organism: sources are ingested into **semantic memory** (§4.8) and
chat answers ground themselves in them with citations. **Phase 2** adds memory & continuity: a
background pass consolidates the transcript into **episodic memory** (recalled by topic, §4.3) and
the companion's **personality evolves** from those episodes. **Phase 3** adds tools, action & trust:
the loop gains a real **inner loop** that calls tools (§4.1–4.2), and the **propose→approve** gate
holds every effectful action in an **approval queue** for one-tap confirmation (§4.4); a **lead
inventory** (reading list) and a **procedural-memory** seed land as the body the Phase 4 will drives.
**Phase 4** adds the **will**: a **motivation engine** fills the `Initiator` seam (§4.5) and, on a
lazy idle/return tick, works the lead inventory into **autonomous proposals** shaped by drives ×
presence; a **stamina/energy** two-pool budget (§4.8) and a **reinforcement** loop that learns
per-drive weights round it out (full mechanism → `companion-motivation.md`).

**Non-goals / scope boundaries (Phases 0–4):** no growth/visual system or stamina/energy game economy
(Phase 5), no unprompted conversation / LLM-critic reward (a later phase — P4 v1 is proposal-only),
no native surfaces or OS tools (Phase 6–7). See `development-plan.md`.

## 2. Architectural Invariants (design decisions)

Fixed now to preserve extensibility. The implementation behind a seam may be a Phase 0 stub, but
the **boundary** does not move — these are the one-way-door decisions; everything else is
deferred to the phase that needs it.

1. **Core ↔ surface boundary.** The companion core is surface-agnostic and exposed only through
   the API (§5). Surfaces are clients with no companion logic → native surfaces are added as
   clients, never as a core rewrite.
2. **Memory behind an interface.** All memory is reached through a `MemoryStore` boundary; new
   memory kinds are added implementations, not caller changes.
3. **Harness with explicit extension points.** The agent loop defines named hooks for memory
   retrieval, tool invocation, and proactive initiation (§4); filling them is additive.
4. **Companion identity is the canonical "home."** A persisted companion record is the source of
   truth a surface loads from; one active embodiment at a time; surfaces hold no authoritative
   state (see State Management, §6).
5. **Multi-tenant from day one.** All state is scoped by `user` and `companion`.
6. **One continuous conversation per companion.** A companion holds exactly one lifelong
   conversation with its user — there is no conversation/session/thread entity. Transcript
   messages attach directly to the companion (`messages.companion_id`); the conversation *is*
   `messages WHERE companion_id = ? ORDER BY seq`. This is a product decision
   (`product-overview.md` §2) enforced structurally so duplicate/empty sessions cannot exist.
   (In the MVP a user owns a single companion; multiple companions per user is a future
   capability and does not change this per-companion invariant.)

## 3. Component Map

Phase 0–1 components and the layers they belong to. Components introduced in later phases are
listed below the diagram, not yet wired.

```mermaid
flowchart TB
  subgraph SURFACE["Surface — Web"]
    WEB["Web Client<br/>(React + Vite)"]
  end
  subgraph BOUNDARY["Surface ↔ Core Boundary"]
    API["API / BFF (Fastify)<br/>auth · sessions · streaming · uploads"]
  end
  subgraph CORE["Companion Core — surface-agnostic"]
    H["Harness<br/>agent loop + extension hooks"]
    GW["LLM Gateway<br/>provider-agnostic"]
    EGW["Embedding Gateway<br/>provider-agnostic (P1)"]
    MEM["MemoryStore (interface)<br/>transcript"]
    SEM["Semantic Store (P1)<br/>sources · sections · facts"]
    ING["Ingestion Pipeline + Runner (P1)<br/>parse → segment → enrich → embed"]
    ID["Identity Store<br/>companion 'home'"]
  end
  subgraph DATA["Persistence"]
    PG[("Postgres + pgvector")]
  end
  LLM["LLM Provider<br/>(OpenRouter)"]

  WEB -->|HTTPS · stream| API
  API --> H
  API --> ING
  H --> ID
  H --> MEM
  H --> SEM
  H --> GW
  H --> EGW
  ING --> SEM
  ING --> GW
  ING --> EGW
  GW -->|HTTPS| LLM
  EGW -->|HTTPS| LLM
  MEM --> PG
  SEM --> PG
  ID --> PG
```

| Component | Owns | Notes |
|---|---|---|
| **Web Client** | Chat UI (incl. citations, in-chat ingestion-status panel, persisted upload turns + live proactive notes), create-a-companion, auth flows, sources page, memory browser + search | Thin client over the API (invariant #1) |
| **API / BFF** | Auth, sessions, routing, response streaming, source intake (multipart), memory routes | The only thing surfaces talk to |
| **Harness** | The agent loop; defines memory/tool/initiation hooks | See §4; P1 fills the memory hook with semantic recall |
| **LLM Gateway** | Provider-agnostic chat-model access | Default OpenRouter; provider pluggable |
| **Embedding Gateway** | Provider-agnostic embedding access (P1) | OpenRouter `/embeddings`; deterministic fake for tests |
| **MemoryStore** | Boundary for the transcript (episodic substrate) | The companion's single transcript (`messages`), keyed by `companion_id`; a turn may carry an optional `source_id` (an upload's attachment + acknowledgement) so the chat reconstructs them on reload |
| **Ingestion Announcer** | Proactive transcript note when a read ends (P1, §4.8) | On `done`/`failed`, posts an in-character, **metered** assistant turn (canned fallback over cap / on failure); fired by the pipeline, decoupled from it |
| **Semantic Store** | Sources (verbatim), sections (vector + FTS), fact overlay, ingestion jobs (P1) | Hybrid retrieval with provenance; contract → `ontology.md` |
| **Ingestion Pipeline + Runner** | Two-pass source reading off the request path (P1, §4.8) | Durable status in `ingestion_jobs`; replaceable by a real worker |
| **Episodic Store** | Consolidated, time-anchored episodes (vector + FTS) + the consolidation cursor (P2) | Derived from the transcript (rebuildable); hybrid recall by topic (§4.3). A time-window filter exists on the store but is not yet wired into recall |
| **Consolidation Service + Runner** | Off-request reflection: transcript window → consolidated episodes, filler dropped (P2) | Mirrors the ingestion runner — coalesced, serial, quota-gated; post-turn trigger + startup/periodic sweep |
| **Personality Evolver** | Re-synthesizes `evolvedPersona` from episodes after consolidation (P2) | Cursor-gated, metered; blended into the persona prompt beside the seed |
| **Identity Store** | Companion "home" record (incl. P2 `evolvedPersona` + evolution/consolidation cursors) | Source of truth surfaces load from |
| **Token Quota Store** | Per-user daily token-budget state — the cost cap (P1, §4.8) | Postgres-backed (`user_token_usage`); routes enforce it inline |
| **Persistence** | Relational + vector storage | Postgres + `pgvector`; schemas → `implementation.md` |
| **Eval Harness** | Offline memory-vs-performance evaluation (`packages/eval`) | Not on the serving path; live OpenRouter. See `companionmemory.md` §5 |
| **Tool Registry + Tools (P3)** | The tools a turn advertises + dispatches (`core/tools/`): `web_fetch`, `memory_search` (read-only), `ingest_source` (effectful) | Read-only tools run freely; the gate holds effectful ones (§4.4). `web_fetch` reuses the link resolver; `ingest_source` reuses the P1 pipeline |
| **Approval Queue + Gate (P3)** | The `beforeToolCall` gate + the `proposals` store — holds effectful calls for one-tap approval, resolved exactly once | The mechanical realization of propose→approve (§4.4); confirm executes via `dispatchTool` |
| **Tool-Call Log (P3)** | Append-only audit of every executed tool call (`tool_calls`) | The `afterToolCall` hook records all calls — the DoD's "every tool call is logged" |
| **Lead Inventory (P3)** | The companion's reading list (`leads`) — discovered-but-unread URLs | Populated by `web_fetch` link harvest; worked on command in P3 (`/explore`), by the motivation engine on idle in P4 (§4.5) |
| **Procedural Store (P3)** | Learned, reusable workflows seeded from approved actions (`procedural_memories`) | Browse-only seed; retrieval-as-hint deferred to P5 |

**Phase 4 ✅ components** (now wired, `companion-motivation.md`): **Motivation Engine** (fills the
`Initiator` seam — drives × presence → bounded autonomous explore burst), **Presence model**
(volatile heartbeat-fed signal), **Energy Store** (`companion_energy` — the self-initiated half of
the §4.8 two-pool budget), **Motivation Runner + Sweep** (off-request ticks, mirrors consolidation),
and the **Reinforcement** outcome store + EMA weight update.

**_Deferred — later phases:_** Growth/Progression service incl. the **stamina/energy game economy**
+ onboarding personality seed (P5), unprompted conversation + LLM-critic reward (a later phase),
Mobile/Desktop clients, OS-tool bridges & Sync Courier (P6–7).

## 4. The Agent Loop & Harness

The harness is the companion's "nervous system" and the most product-defining part of the
architecture. It adopts a proven agentic-loop pattern — **turn primitive · outer + inner loops ·
steering · before/after-tool hooks · failures-as-data · transcript-as-truth · the human as the
loop's exit/entry boundary** — the same lineage as the sibling **CobbleTradeAdvice** project,
adapted here for a **cloud, multi-tenant, proactive** companion (the two adaptations: propose→approve
realized as a `beforeToolCall` gate, §4.4; and **proactive initiation** as a non-human loop entry,
§4.5).

The **loop shape is an architectural invariant** (§2 #3): it does not change between phases — each
phase only fills in more of it. **Phase 0 exercises only the trivial path** (empty tool set → the
inner loop turns exactly once → exit; proactive entry arrives in Phase 4). The §4.6 sequence diagram
shows that concrete Phase 0 realization. *(Hook signatures + concrete context assembly:
`implementation.md` §2.)*

### 4.1 The loop (outer + inner)

The **outer loop** drains queued entries (one run each); the **inner loop** turns. *A turn = one LLM
call plus the tool executions it triggers.* The inner loop keeps turning while the model keeps
calling tools and stops when the model returns a message with **no tool calls** — that stopping point
is the **EXIT**, where control returns to the user (or surface).

```mermaid
flowchart TD
    ENTRY(["ENTRY — user prompt · user reply · proactive trigger (P4)"])
    ENTRY --> OUTER{{"OUTER loop — one run per queued entry"}}
    OUTER --> TURN["TURN — one LLM call + the tools it triggers (§4.2)"]
    TURN --> Q{"tool calls?"}
    Q -->|yes| EXEC["execute tool(s) · beforeToolCall gate (P3)"]
    EXEC --> RES["grounded result → appended to transcript"]
    RES --> TURN
    Q -->|"no (nothing queued)"| EXIT(["EXIT — a no-tool-call message"])
    EXIT -->|"answer · question · proposed action awaiting approval (P3)"| USER(["USER / surface"])
    USER -->|"reply = next ENTRY"| ENTRY
    STEER["steering (optional) — injected after the<br/>current tool finishes, before the next turn"] -.-> TURN

    classDef human fill:#1e3a5f,stroke:#3b82f6,color:#e2e8f0;
    class ENTRY,USER human;
```

> **Phase 0:** the tool set is empty, so `tool calls? → no` always holds — the inner loop turns once
> and exits. **Phase 3 ✅:** the inner loop is real — the model may call tools, each runs (read-only)
> or is held by the gate (effectful), the result re-enters as the next turn, bounded by a
> max-iteration + token ceiling (§4.7). The loop shape is unchanged; proactive entries (P4) arrive
> the same way.

### 4.2 The turn (the primitive)

One turn, as a state machine. This is where the **before/after-tool hooks** and grounding live —
the seams Phases 1/3 fill (invariant #3).

```mermaid
flowchart TD
    CTX["assemble context (§4.3)"] --> LLM["LLM call (streamed)"]
    LLM --> MSG["assistant message<br/>(text and/or tool calls)"]
    MSG -->|"no tool calls"| OUT(["→ EXIT (§4.1)"])
    MSG -->|"tool calls"| EACH{"for each<br/>tool call"}
    EACH --> VAL["validate args"]
    VAL --> BEFORE["beforeToolCall — may BLOCK<br/>(approval gate for effectful/costly actions, P3 · §4.4)"]
    BEFORE --> RUN["execute tool"]
    RUN --> AFTER["afterToolCall — rewrite / terminate"]
    AFTER --> TR["tool result → appended to transcript"]
    TR -->|next turn| CTX
```

> **Phase 0:** no tools, so every turn is `context → LLM → message → EXIT`. **Phase 3 ✅:** the
> right-hand branch is live — `validate args → beforeToolCall (gate) → execute → afterToolCall (log)`;
> tool calls/results are replayed to the provider in the OpenAI tool-call wire shape, and the gateway
> accumulates streamed `tool_calls` fragments (`implementation.md` §2).

### 4.3 Context assembly (what enters each turn)

Each turn rebuilds context from the companion's "home" + its memory. The dashed inputs are the
**memory-retrieval hook**, filled per phase.

```mermaid
flowchart LR
    ID["companion identity<br/>name · form · temperament"] --> P[["assembled prompt → LLM"]]
    SYS["system prompt / persona"] --> P
    SEM["semantic recall (P1 ✅)<br/>top-K verbatim sections + provenance"] --> P
    EPI["episodic recall<br/>(P0: recent transcript · P2: episodic)"] --> P
    TOOLS["available tools<br/>(P3)"] -.-> P
```

> **Phase 1:** the memory-retrieval hook embeds the user's question, hybrid-searches the
> semantic store (vector + lexical + metadata, fused), and prepends each hit as a
> provenance-carrying grounding block; the hit's citations are streamed to the client before
> the answer. Retrieval failure degrades to recency-only — recall never breaks the
> conversation. (Hook signature → `implementation.md` §2.1.)

> **Phase 2:** the same hook gains an **episodic arm** composed ahead of the P1 semantic arm
> (`composeRetrieveContext`, so the recency window is still appended once, last): it embeds the
> turn, hybrid-searches the **episode store** (consolidated, time-anchored memories), and prepends
> each as a fenced "memory from your shared history" block. Episodic recall is **topic-only**: the
> same vector + FTS hybrid (RRF) as the semantic arm. Episodes carry a wall-clock span (rendered as
> the block's date) and a self-reported salience, but **neither steers recall** — the store offers a
> time-window filter that no recall path passes yet, and RRF ignores salience (filler is dropped at
> consolidation, not down-weighted at recall). The episodes themselves are formed
> **off the request path** by a background **consolidation** pass (reflection over the transcript →
> consolidated summaries with filler dropped, embedded; cursor-driven, idempotent, quota-gated — the
> P1 runner/sweeper shape), triggered post-turn and on a startup/periodic sweep. Consolidation also
> drives **personality evolution**: an `evolvedPersona` re-synthesized from episodes and blended
> into the persona prompt (input #1) beside the immutable seed temperament. Episodic recall
> degrades to no episodic blocks on failure — recall never breaks the conversation.

### 4.4 Human-in-the-loop & propose→approve

There are **no dedicated "ask" or "confirm" steps** — the loop runs until it has something to say,
then EXITs with a plain message; the user's reply is the next ENTRY. The product's **propose→approve**
trust model (`product-overview.md` §5.3) is realized mechanically as the `beforeToolCall` gate: a
read-only tool runs freely, but an **effectful/costly** tool call (book · send · pay) is **blocked**,
forcing an exit-to-approve. **Every** effectful call in the turn is held — the loop collects them all
rather than bailing on the first — and each is written to the transcript as a `proposal` row so the
held action survives a reload.

On **approval**, the confirm route resolves the proposal exactly once, executes the held call
(`dispatchTool`), logs it, records a friendly outcome row, and then **re-enters the agent loop**
(`Harness.continueAfterApproval`): the outcome is injected as an ephemeral observation, so the
companion *narrates* the result and continues whatever the user asked ("…then summarize what you
saved") — rather than the conversation dead-ending on a raw tool line. No suspended generator is
resumed; the transcript is the only state (§4.7). Approving an action mid-continuation can itself
produce a new proposal — the gate re-applies. **Reject** resolves the proposal without executing.
When the proposal is **explore-origin** (it carries the originating `lead_id`), resolving it also
closes that lead's lifecycle — confirm→`ingested`, reject→`discarded` — so a worked lead leaves the
reading list instead of being stranded at `read` (best-effort; never fails the user's action).

> **Decided (Phase 4 design) — who decides "what next" after an approved action (resolves with the
> motivation engine, §4.5).** Re-entry on approval is right for **chat**: a conversational partner is present, so
> even when the approved action *was* the whole request ("remember this page"), a natural
> confirmation or follow-up reads as companion-like — and a multi-step ask ("remember it **and**
> summarize it") *requires* the continuation. Crucially, **terminality is not knowable at propose
> time**: the model often can't summarize until the page is actually read, so it proposes the ingest
> alone and only decides whether to continue once it sees the result. So the model must get the
> post-approval turn and decide for itself — we don't try to predict it.
>
> Today the confirm route re-enters for **every** approval, including **explore**-origin proposals
> (the reading-list "go through your list" action, §4.5). That is the part to revisit here: for a
> **self-directed** origin there is no conversational task to continue, and choosing the companion's
> *own* next move is **agenda-setting — the motivation engine's job (§4.5), not a confirm-route
> reflex**. Per-approval re-entry is also the wrong *granularity* for a batch: explore approves N
> proposals through N queue cards → N disjoint mini-turns, each blind to the others. Keep the two
> concerns apart: *reacting to the person who just approved* is conversational (fine — ideally
> **once** per batch); *deciding the next self-directed action* belongs to the outer loop. **The
> Phase 4 resolution:** stamp each proposal with its origin (a `chat` | `explore` | `autonomous`
> marker on the `proposals` row), have confirm re-enter the loop only for `chat`, and let the
> motivation engine (§4.5) pick up post-action "what next" for the rest from the full updated state
> on its own cadence (a brief in-character acknowledgement to whoever approved is still fine).
> *(Until Phase 4 ships this, P3 simply re-enters on every approval — the known wart above.)*

```mermaid
flowchart TD
    CALL["tool call"] --> GATE{"beforeToolCall:<br/>effectful / costly?"}
    GATE -->|"no (read-only)"| RUN["execute"]
    GATE -->|yes| BLOCK["BLOCK → enqueue proposal"]
    BLOCK --> XEXIT(["EXIT — propose action, await approval"])
    XEXIT --> DEC{"user: approve / reject"}
    DEC -->|approve| RUN
    DEC -->|reject| DROP["drop proposal"]
```

> **Generalized invariant (P3 ✅):** the companion never executes a consequential, outward action
> without explicit user approval. Realized as the `beforeToolCall` gate: an effectful tool call is
> written to the `proposals` queue and the loop EXITs; the confirm route resolves it **exactly once**
> (a conditional `pending→approved` claim) and runs the held call. Reject drops it. Data model +
> exactly-once mechanics → `implementation.md` §`proposals`.

### 4.5 Proactive initiation (Phase 4)

The companion-specific extension of the pattern: an outer-loop **ENTRY can be generated by the
motivation engine**, not only by a human. This is what makes the companion proactive rather than
passive (`product-overview.md` §5.4).

```mermaid
flowchart LR
    MOT["motivation engine<br/>goals · curiosity · bond · pending work"] --> TRIG{"worth<br/>initiating?"}
    TRIG -->|no| IDLE["idle"]
    TRIG -->|yes| INIT["initiator → new ENTRY<br/>(no user message)"]
    INIT --> LOOP["OUTER loop (§4.1)"]
    LOOP --> OUT(["EXIT — proposal / question"])
    OUT -->|"in-app when present · gentle push when away"| USER(["user"])

    classDef human fill:#1e3a5f,stroke:#3b82f6,color:#e2e8f0;
    class USER human;
```

> **Phase 4 ✅ — implemented (v1, proposal-only).** The motivation engine
> (`packages/core/src/motivation/`) fills the `Initiator` hook (architecture.md invariant #3). It is
> the **"will"** of a deliberate **body-then-will split**: Phase 3 builds the *body*
> — the tools, the propose→approve gate (§4.4), the tool-call audit log, and the **lead inventory**
> (a persistent frontier of discovered-but-unread leads, e.g. URLs spotted while reading) — and
> Phase 4 builds the *will* that drives that body on its own. The ordering is a safety
> precondition, not a convenience: an autonomous, exploring, token-*spending* companion is only
> acceptable because **every consequential act already routes through the approval gate and every
> tool call is logged** (the §4.4 generalized invariant). The body is verifiable with deterministic
> tests; the will only by measurement over time (its named risk is annoyance, `development-plan.md`
> §3), so it lands on a foundation already trusted. The exploration loop is *identical* whether a
> human or the motivation engine triggers it — Phase 3 works the inventory **on the user's command**
> ("go through your reading list"); Phase 4 works it **on an idle tick**.

> **This engine owns post-action "what next" for self-directed work (paired with §4.4).** When an
> approved action did not come from a live conversation — an `explore`/idle-tick ingest rather than a
> chat ask — the question "what should I do now that this is done?" is *agenda-setting*, and that is
> precisely this engine's job, not the confirm route's. It sees the **full** updated state (the new
> memory, the remaining lead frontier) at once, runs on the creature's own cadence, and surfaces
> proactively — so it can react **once** to a finished batch instead of N times mid-approval. The
> confirm route should therefore **defer** here: re-enter the loop only for `chat`-origin approvals
> (a present partner to reply to, §4.4) and leave self-directed continuation to this engine. A brief
> in-character acknowledgement to *whoever approved* a proactive proposal is still fine — that is
> conversational, and distinct from deciding the next move. Until this engine exists, Phase 3 simply
> re-enters on every approval (the known wart called out in §4.4).

**Full mechanism — the drive taxonomy, the arbitration math, seeding from temperament, the learning
loop, and worked examples — is canonical in `companion-motivation.md`.** This section is the
loop-integration overview.

The engine's parts (each additive, no loop change):

- **Trigger (lazy, web-appropriate)** — the engine ticks on **user activity + on return** (the
  request path) and on a **periodic sweep** across companions worth ticking (the background-runner +
  sweep pattern already used for consolidation, §4.3). Each tick asks "is there anything worth
  doing?" → emit a non-human ENTRY, or stay idle. It is **not** an always-on per-companion drain.
  *(Genuine work **while the user is away** — continuous between-visit activity — is **deferred to
  Phase 6**, where push gives it an audience; on web, away-work is unseen until return, so it folds
  into the return tick.)*
- **Environment & presence (the dominant context)** — behaviour is shaped first by a **presence
  spectrum**: *active* (typing / just sent) · *attentive* (here but idle — the best moment for a
  tip/question) · *away-short* · *absent-long*. Derived from a client **heartbeat** (tab
  focus/visibility) + last-activity recency — a volatile signal, not persisted. Present → engage the
  user, don't wander into solo work unasked; away/absent → do solo work that surfaces on return; and
  **idle is always allowed**. Other environment inputs: available tools, the lead frontier, and
  remaining energy (below).
- **Drives (what it wants)** — **learned** user interests (read out of semantic/episodic memory, not
  a configured setting) + understanding-the-user + the companion's personality (seed temperament +
  evolved persona, §4.3) + pending **leads** (the inventory) + bond maintenance (time since last
  contact) + pending work/opportunities + an **approval/reinforcement** drive learned from feedback
  (below) (`product-overview.md` §5.4).
- **Arbitration (cheap gate, then a burst)** — a **token-free heuristic gate** scores candidate
  actions by drive × salience (against presence, the dial, energy, and the personality knobs) and
  decides *whether* to act — so **"idle" is a valid, free outcome**. Only when it commits does an
  **LLM burst** run the chosen move (the only token spend).
- **Attention model (the "creature")** — each initiation is a **bounded burst**, never a full drain
  of the inventory. Personality parameters shape it: **focus length** (steps before re-deciding),
  **boredom** (interest on a thread decays without payoff), **distractibility** (a higher-salience
  lead can preempt). **Default constants in the PoC** (per-companion personalization deferred to
  onboarding, `companion-motivation.md` §7) — the dynamics behind a tenacious deep-reader vs. a
  magpie that flits.
- **Budget (stamina & energy)** — self-initiated work draws the **energy** pool (§4.8); when energy
  is exhausted the engine stops initiating (the gate idles) while chat still runs on **stamina**, so
  autonomy can never starve interaction. The per-run ceiling (§4.7) is parameterized by the
  personality knobs and the tunability dial.
- **Reinforcement (learning what lands)** — after a proactive action the engine computes a **reward**
  and a simple update (EMA) nudges the per-companion **drive weights**, so the companion leans into
  what's appreciated. **Phase 4 v1 uses hard signals only** (proposal approved = strong+,
  rejected/dismissed = −, ignored = mild−). Weights are interpretable and seed the Phase 5
  relationship-growth axis. *(Deferred with conversational proactivity: an LLM-critic feeling-score
  blended in; and a deeper contextual-bandit policy.)*
- **Output** — **Phase 4 v1 ships the proposal path only**: a **proposal awaiting approval**
  (`origin = autonomous`, §4.4), delivered via the in-app approval queue. *(Unprompted
  messages/questions — and the transcript-poll delivery they need — are deferred,
  `companion-motivation.md` §10.)* Consequential acts still pass the §4.4 gate.
- **Tunability** — a per-companion **frequency/intensity dial** (off / gentle / active) scaling
  initiation rate and energy spend (Phase 4 DoD).

**Phase 3 built the substrate** the engine plugs into: the **lead inventory**, the `Initiator`
contract, and the **burst-budget knob** (the §4.7 per-run ceiling that Phase 4 parameterizes by
personality). **Documented here, built later:** unprompted conversation + the LLM-critic + a sense
of purpose/agenda → a later phase (Phase 4 v1 is **proposal-only**); continuous work-while-away →
Phase 6; the stamina/energy **game economy** (food/feeding, store, rich meters) → Phase 5; deeper RL.

### 4.6 Phase 0 realization (end-to-end)

The same loop, instantiated across the real Phase 0 components — single-pass, with streaming:

```mermaid
sequenceDiagram
    actor User
    participant Web as Web Client
    participant API as API / BFF
    participant H as Harness
    participant Id as Identity Store
    participant Mem as MemoryStore
    participant GW as LLM Gateway
    participant LLM as LLM Provider

    User->>Web: send message
    Web->>API: POST message (authed)
    API->>H: ENTRY → dispatch turn
    H->>Id: load companion "home"
    H->>Mem: retrieve context (recent transcript)
    Note over H: context assembled (§4.3); tool set empty
    H->>GW: invoke model
    GW->>LLM: HTTPS (streamed)
    LLM-->>GW: token stream
    GW-->>H: stream
    H-->>API: stream tokens
    API-->>Web: SSE / WebSocket
    Note over H: no tool calls → EXIT
    H->>Mem: persist turn
```

### 4.7 Loop invariants

- **Termination.** *Normal:* the model stops calling tools, or the gate forces an exit (a held
  proposal, P3). *Abnormal — a no-progress dead loop:* guarded (P3 ✅) by a **max tool-iteration
  count + a per-run token budget**; hitting either ends in **exit-to-user-with-partial** (logged).
- **Failures are data.** A provider error or a tool throw becomes an ordinary turn outcome (an error
  message / an error result) that re-enters the loop — uniform recovery, and gaps are surfaced, never
  fabricated.
- **Transcript is the source of truth.** Append-only; reconstructable into context; compaction
  summarizes the compactible remainder when the window fills (P-later). **The rendered conversation —
  live *and* after reload — is a projection of the transcript, never a richer separate reality (P3 ✅).**
  So everything the user sees is a persisted row: a grounded answer carries its `citations` (metadata),
  a read-only look-up is a `tool_step` row, a held action is a `proposal` row. Rows carry a **`kind`**
  (`message` | `tool_step` | `proposal`) and `metadata`; the **LLM-context projection includes only
  `message` rows** (tool steps + proposals are UI chrome and never re-enter the model's context, nor
  episodic consolidation). Live streaming is a *progressive preview* of rows that will be persisted; a
  turn that produced tool-step/proposal rows reconciles the surface against the transcript on settle.
- **State is authoritative only at the home.** Surfaces never hold loop state (§6); a run reads from
  and writes back to the cloud home.

### 4.8 Ingestion flow (Phase 1)

How a source becomes semantic memory — **two output-bounded reading passes** off the request
path. The economics are deliberate: input tokens are cheap and output tokens are the cost
lever, so the model *reads everything* but *emits almost nothing* (~1% of input in Pass 1,
~10% in Pass 2).

```mermaid
flowchart LR
    UP["upload (file · note · link)<br/>202 + queued job · 429 only if queue full"] --> RUN["Ingestion Runner<br/>(off request path)"]
    RUN --> PARSE["parse → atomic paragraphs<br/>(never split mid-paragraph)"]
    PARSE --> GATE{"owner over<br/>daily token cap?"}
    GATE -->|yes| DEFER["status: deferred<br/>(hold parse; sweeper resumes after reset)"]
    GATE -->|no| P1["Pass 1 — segment:<br/>LLM emits ONLY boundaries + topics"]
    P1 --> SECT["sections = verbatim paragraph slices<br/>(the model never rewrites text)"]
    SECT --> P2["Pass 2 — enrich:<br/>one context line + typed facts (ontology.md)"]
    P2 --> EMB["embed: [context header +] verbatim text<br/>→ pgvector · FTS"]
    EMB --> DONE["job done — recallable with citations"]
```

Design rules (the "improved staged hybrid"; memory guide → `companionmemory.md`):

- **Original text is canonical.** Sources are stored verbatim; sections are verbatim paragraph
  slices; the fact overlay (`ontology.md`) is an index *into* the text, rebuildable from it.
- **Paragraphs are atomic.** Segmentation groups whole paragraphs into cohesive sections —
  blind fixed-size chunking is structurally impossible.
- **Embedding input ≠ stored text.** The optional Pass-2 context header is prefixed onto the
  *embedding input only* (it injects the entities unresolved pronouns hide from the encoder);
  stored and displayed text is always pure original. Header on/off is an eval A/B knob.
- **Dual retrieval.** Semantic (vector cosine) + lexical (FTS) fused by reciprocal rank, plus
  metadata paths (source, fact-overlay entity) — every hit carries provenance (source, chapter,
  paragraph/page range) so answers cite and can show the original passage.
- **Failures are data.** A failed run lands on the job as a user-safe error; the durable
  status surface (`ingestion_jobs`) is what makes the in-process runner replaceable by a real
  worker with no schema or API change (§8). It also makes restart recovery clean: interrupted
  in-flight jobs are failed on startup (re-upload), while `deferred` jobs keep their parse and
  resume.
- **The companion speaks up when a read ends.** On a terminal outcome (`done`/`failed`, never
  `deferred`), the pipeline asks the **Ingestion Announcer** to post a short, in-character
  assistant turn to the transcript ("By the way — I've finished reading X…"). It is generated in
  the companion's voice through the metered gateway (so its tokens count against the daily cap)
  and **falls back to a canned line** when the owner is over cap, generation fails, or there is no
  persona — the user is always told, the companion never goes silent. The note is appended **before**
  the job flips to its terminal status, so a client polling the job sees the note already in the
  transcript; an announcement failure is logged and never changes the job's recorded outcome.
  Surfacing: the upload's own attachment + acknowledgement turns are persisted (`messages.source_id`)
  too, and the open chat pulls the proactive note in live off the ingestion-status poll.
- **Re-running a source is idempotent.** A run writes a source's whole section set in one call,
  *replacing* (not appending to) any prior sections for that source — so a re-run never duplicates
  sections/facts or inflates counts (orphaned facts cascade with their sections). This holds
  however a re-run is triggered, which lets the in-process runner give way to an at-least-once
  worker without a dedupe layer. The deferred-job sweeper reinforces this upstream: it **atomically
  claims** each parked job (`deferred → queued`, conditional) before enqueue, so two overlapping
  sweeps can't resume — and re-bill — the same job twice.
- **Cost guardrail = a per-user daily token cap.** The real resource is LLM/embedding **tokens**,
  so spend is metered against a **per-user cap over a fixed daily window** (resets 00:00 UTC);
  overage carries to the next day as **debt clamped to one cap** (never a multi-day lockout). The
  cap state lives in Postgres (`user_token_usage`), so it is correct across replicas — unlike a
  per-instance request limiter. Each route enforces it inline: **chat & search** pre-flight-check
  and return **429** when over cap; **ingestion defers** (see below). Actual token counts come from
  the provider's `usage` (estimated only if a model omits it). Because **ingestion is serial** and
  **chat is turn-based**, there is no in-app concurrency to outrun the post-hoc accounting — the
  serialization *is* the burst backstop, so the cap is the whole defense (threat model:
  legitimate-user cost control, not attacker resistance). The runner still caps queued+in-flight
  runs (`INGESTION_QUEUE_MAX`) as a memory backstop. Knobs → `implementation.md` §config.
  - **Abandoned chat turns are metered by cause.** A turn the **client aborts** mid-stream (it stops
    reading — a disconnect) is still debited for the tokens already streamed (estimated from the
    deltas seen), so a client can't stream a full answer and drop before the provider's trailing
    usage frame to get it free. A turn that breaks on a **provider/infra fault** (the stream throws)
    is **not** billed for the failed part — we err in the user's favor on our own failures; in a
    multi-turn tool run the already-completed turns are still billed, only the broken one is free.
    The metering wrapper (`meteredLlmGateway`, `usage.ts`) makes the distinction: a thrown error
    leaves the in-flight turn out of the accumulator, a consumer `.return()` deposits the estimate.
  - **Phase 4 — stamina & energy (two pools).** The single per-user cap splits by *who initiated*
    the work. **Stamina** is the user-initiated pool (chat, assigned tasks — the existing
    `user_token_usage`, per user). **Energy** is the self-initiated pool (the motivation engine's
    proactive turns and exploration — per **companion**, a new `companion_energy`). They never share
    a counter, so autonomous work can **never starve interaction**: when energy is exhausted the
    engine stops initiating (`Initiator` idles, §4.5) while chat keeps running on stamina. The user
    **provisions** both — a visible meter + manual top-up replace the hard-coded daily cap as the
    spend control (the food/feeding **game economy** that grows this is P5, `development-plan.md`).
    Each pool still rolls on a fixed window; the engine's per-run ceiling (§4.7) is parameterized by
    the personality knobs (§4.5). Effectful work is billed to the pool matching the proposal's
    `origin` — `chat`→stamina, `explore`/`autonomous`→energy.

#### Supported source formats (acceptance contract)

A source reaches a parser through one of **three input channels** — a **file upload**
(`POST .../sources/file`, multipart), a **typed note** (JSON `text`), or a **link** (fetched
URL). All three converge on **one content-type → parser registry**, so a format is parsed the
same way no matter how it arrived. The channels differ only in how they *identify* content:

- **Upload** — content type follows from the filename extension, then **confirmed against magic
  bytes — never the extension alone** (the route rejects a `.docx` that isn't a zip, a `.pdf`
  without `%PDF-`, etc.).
- **Link** — the resolver fetches the URL (SSRF-guarded, size-capped) and **detects the content
  type**: the HTTP `Content-Type` header first, then a magic-byte sniff, then the URL extension,
  then a plain-text fallback. So a link to a **PDF, Markdown, or plain-text** resource is read
  with that format's parser — not assumed to be HTML.

`INGESTION_MAX_BYTES` caps every upload and every fetched link body. This table is the canonical
list of what the system accepts; **Content type** is the registry key, reachable by any channel
whose check resolves to it.

| Content type | Extension(s) | MIME / magic | Reachable via | Parser | Status |
|---|---|---|---|---|---|
| `pdf` | `.pdf` | `application/pdf`; magic `%PDF-` | upload, link | `unpdf` (pdf.js), page-aware provenance | ✅ shipped |
| `html` | — | `text/html`, `application/xhtml+xml` | link | fetch → Mozilla Readability | ✅ shipped |
| `text` | `.txt` | `text/plain`; rejected if it looks binary (NUL byte without a Unicode BOM) | upload, link, note | BOM-aware UTF-8/UTF-16 decode → paragraph split (the note parser) | ✅ shipped |
| `markdown` | `.md`, `.markdown` | `text/markdown` | upload, link | markdown stripped to prose → paragraph split | ✅ shipped |
| `docx` | `.docx` | wordprocessingml MIME; zip magic `PK` | upload, link | `mammoth` raw-text body extract | ✅ shipped |
| `pptx` | `.pptx` | presentationml MIME; zip magic `PK` | upload, link | per-slide `<a:t>` extract, slide → page provenance | ✅ shipped |

**Explicitly out of scope** (unsupported uploads get a 400; unidentifiable link bodies are
rejected): legacy OLE binaries (`.doc`, `.ppt`), spreadsheets/tabular data (`.xlsx`, `.csv` —
the paragraph model doesn't fit rows), and binary link content with no recognized type (images,
video, archives). `.docx`/`.pptx` share the zip `PK` magic, so the extension (upload) or MIME
header (link) is the discriminator; the parser confirms the inner structure. The decoupled
design lives in `content-parser.ts` (registry), `source-parser.ts` (payload → document facade
the pipeline depends on), and `link-resolver.ts` (fetch + detect). Every parser's output is
control-character-sanitized at the boundary (`text/sanitize.ts`): extracted text routes through
`sanitizeText`, which drops NUL and other C0/C1 control characters (PDF/pdf.js extraction is the
common source of embedded NUL) so the canonical `raw_text` and everything derived from it is safe
for the Postgres `text` store — a NUL would otherwise abort the write. The persistence layer also
applies a NUL-only guard on write as a last line of defense.

> **Daily-cap deferral.** Parsing is free (no tokens); the **AI passes** (segment/enrich/embed)
> are the cost. When the owner is over their daily token cap, the pipeline parses the source,
> persists the parsed paragraphs on the job (`ingestion_jobs.parsed_doc`), sets status `deferred`,
> and stops — no re-upload needed. A periodic sweeper resumes deferred jobs (serially, re-checking
> the cap) as allowances reset, so the queue drains incrementally. Users can delete a parked job
> (`DELETE …/sources/:id`). This is why over-cap uploads still return **202**, not 429.

> **`kind` modeling:** `sources.kind` carries the format directly —
> `pdf | note | link | txt | md | docx | pptx` (`implementation.md` §`sources`). The column is
> free text typed in code (`$type<SourceKind>()`), so widening the set needed **no migration**;
> `origin` holds the filename for uploads and the URL for links. pptx records the slide number
> as `page`; docx/txt/md carry paragraph-ordinal provenance only.

## 5. Stack & Technology Decisions

Resolves the items flagged in `development-plan.md` §5. (Field-level config/env → `implementation.md`.)

| Concern | Decision | Why |
|---|---|---|
| Language / runtime | **TypeScript end-to-end** (Node + React) | I/O-bound LLM workload (single-thread is a non-issue); richest agent/tool/**MCP** + LLM ecosystem; shared types across surfaces |
| API framework | **Fastify** (Node) | TS-first, fast, light; swappable behind the API package |
| Web client | **React + Vite** (SPA) | Thin client; keeps the core↔surface boundary explicit. Next.js considered; SPA keeps the boundary cleaner |
| Store engine | **Postgres + `pgvector`** | Multi-tenant cloud home; one store for relational + vectors; scales across phases |
| Data access | Type-safe query layer (Drizzle) | Explicit types end-to-end; no raw SQL by default |
| LLM access | **Provider-agnostic gateway, default OpenRouter** | Swap models/providers without touching the harness |
| Embeddings | **Provider-agnostic gateway, OpenRouter `/embeddings`** — default `perplexity/pplx-embed-v1-0.6b` | Single vendor with the LLM gateway; dimensions pinned to the vector column (`implementation.md` §3) |
| Auth | **Google Sign-In (OIDC)** | The SPA gets a Google ID token (Google Identity Services); the API verifies it against Google's JWKS (`aud=GOOGLE_CLIENT_ID`, `email_verified`) and JIT-provisions users by email. The token is persisted client-side in `sessionStorage` so it survives a page refresh (mechanism + expiry handling in `implementation.md` §5). No third-party auth service, no tenant, no extra Pulumi stack. `dev_bypass` mode for local/tests |

## 6. Interactions, Boundary & State

- **Surface ↔ core contract.** The core is reached only through the API; the request/response
  and streaming contract lives in shared types. No surface-specific logic crosses into the core
  (invariant #1). Mobile (P6) and desktop (P7) will consume the *same* contract; their OS access
  is exposed *to the core as tools* (P3 framework), not as new core APIs.
- **Streaming.** Chat responses stream to the client (SSE or WebSocket) so the UI shows tokens as
  they arrive despite multi-second model latency.
- **External services.** The **LLM Provider** (OpenRouter) is the only external dependency in
  Phase 0 — outbound HTTPS via the LLM Gateway. User content crossing to the provider is an
  explicit trust boundary (§8).
- **State management.** Authoritative state lives in the cloud "home" (Postgres), scoped per
  `user`/`companion`. Surfaces are stateless views that load from and write back to the core;
  with one embodiment active at a time there is no cross-surface state to reconcile (invariants
  #4, #5).

## 7. Folder Structure (Phases 0–3)

```
/                      repo root
  docs/                canonical documentation
  packages/            TS monorepo (workspaces)
    core/              the companion (surface-agnostic) — invariant #1
      harness/         agent loop + extension hooks (§4); semantic + episodic recall (P1, P2 §4.3)
      llm/             provider-agnostic LLM gateway
      embedding/       provider-agnostic embedding gateway (P1; request-path memoizing wrapper P2)
      ingestion/       parse → segment → enrich → embed pipeline + runner + deferred-job sweeper (P1, §4.8)
      memory/          MemoryStore (transcript) + SemanticMemoryStore (P1) + EpisodicMemoryStore + consolidation service/runner (P2)
      tools/           tool framework + registry, the three tools, the approval gate, proposal/tool-call/lead/procedural stores (P3, §4.2/§4.4)
      personality/     evolvedPersona synthesis from episodes (P2)
      identity/        companion "home" model + store
      quota/           per-user daily token-cap state (P1, §4.8)
    api/               BFF / surface boundary (Fastify); memory + source + usage + proposal/inventory routes (P3)
    web/               React web client; chat w/ citations + ingestion-status panel + approval cards (P3), sources page, memory browser, usage badge
    shared/            shared TS types / contracts
    eval/              live memory-vs-performance harness (→ companionmemory.md §5)
  db/                  migrations & schema (→ implementation.md)
  scripts/             dev / seed / ops scripts
```
> Add new components here and to the Component Map (§3) when introduced (`CLAUDE.md` "When to
> Update Docs").

## 8. Deployment & Trust Model

**Deployment approach.** A single **GCP Cloud Run** service (the Fastify API, which also serves the
built React SPA from the same origin) runs the container image; `min_instances = 1` keeps the hot
chat **API** warm so the first message after idle isn't a cold start. **Background workers** (later:
ingestion, proactivity) will be async and scale to zero for cost. The workload is I/O-bound (mostly
awaiting the LLM), so a single Node process holds many concurrent conversations and scales
horizontally with replicas; CPU-heavy work (future PDF parse/embedding) moves off the request path
to workers. Infrastructure is managed as code with **Pulumi** under `infra/` (`infra/gcp` for Cloud
Run + Artifact Registry + Secret Manager); auth is Google Sign-In (no auth service to provision);
managed Postgres is Supabase (pgvector). (Specific tuning params, image build → `implementation.md` and `infra/*/README.md`.)

**Trust model (Phase 0 baseline).** Design-level boundaries; the security *implementation* and
the full threat model live in `implementation.md` and Phase 8 respectively (`development-plan.md` §4).

- **Tenancy isolation** — all state scoped by `user`/`companion`; authorization enforced at the
  API boundary before the core is reached.
- **Transport** — HTTPS/TLS everywhere; secure DB connections.
- **Input validation** — all client and external (LLM) data validated at the boundary before use.
- **Server-side fetch boundary (SSRF)** — link ingestion fetches user-supplied URLs from the
  server, so destinations are restricted to public HTTP(S): the URL is checked for scheme and
  blocked host/IP literals, **and the connection-layer DNS lookup re-validates every resolved
  address** so a public hostname cannot rebind to a private/metadata IP; redirects are refused
  and the body is read under a byte ceiling (`implementation.md`).
- **LLM provider trust boundary** — user content sent to the provider is an explicit external
  trust boundary; provider data-handling assumptions documented in `implementation.md`.

**_Deferred — Phase 8:_** encryption-at-rest specifics, data inspection/management/delete
controls, on-device data-locality for native surfaces, propose→approve audit-trail hardening.
