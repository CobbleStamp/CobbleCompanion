# CobbleCompanion — Development Plan

> Canonical source for **priorities, requirements, and roadmap**. Product definition lives in
> `product-overview.md`; technical architecture in `architecture.md`. Each fact lives
> in exactly one place — this document sequences *what to build and in what order*, not *what
> the product is* or *how it is built internally*.

## 1. Strategy

**Prove the concept on the web first.** The web surface is install-free and the fastest to
iterate on (`product-overview.md` §5.2). We use it to validate the two hardest, most
differentiating claims before investing in native surfaces:

1. The companion is a **knowledge organism** — feed it sources, it organizes them into
   long-term memory, and recalls the right thing in context.
2. The companion is **proactive** — it initiates from its own motivations, usefully and
   without being annoying.

Mobile (GPS, OS tools, push) and desktop (files, local storage) are deferred until the core
being is proven, because they add platform cost without changing whether the core idea works.

### Guiding principles
- **Thin vertical slices.** Every phase ships an end-to-end experience a user can try, not a
  layer. Prove differentiators early; polish late.
- **Web-first, surface-portable.** Build the companion (model + harness + memory) as a
  cloud-resident core with a clean surface boundary, so mobile/desktop are added later as
  *clients*, not rewrites (`product-overview.md` §2).
- **Trust before autonomy.** The propose→approve model and data controls land alongside the
  first action-taking capability, not after.
- **Iron Laws apply** (`AGENTS.md`): no merge without tests (≥80% coverage), explicit types,
  evidence before claims, single-source docs.

## 2. Phase Overview

| Phase | Theme | Surface | Proves / Delivers | Status |
|---|---|---|---|---|
| **0** | Foundations & walking skeleton | Web | You can talk to Cobble end-to-end; stack decided | ✅ **Done** (PR #1) |
| **1** | The knowledge organism | Web | Ingest sources → semantic memory → grounded recall ⭐ | ✅ **Done** (PR #2) |
| **2** | Memory & continuity | Web | Episodic memory, companion identity, cloud "home" | ✅ **Done** |
| **3** | Tools, action & trust | Web | Tool/MCP use + propose→approve approval queue | ✅ **Done** |
| **4** | Proactivity engine | Web | Motivated, tunable initiative ⭐ | ✅ **Done** |
| **5** | Bond & growth | Web | Four-axis growth + visual character — the PoC complete | Planned |
| **6** | Mobile surface | + Mobile | Summon model, GPS recall, push, OS-as-tools | Planned |
| **7** | Desktop surface | + Desktop | File/workspace OS tools, heavier local storage | Planned |
| **8** | Hardening & launch readiness | All | Security, scale, privacy controls, monetization | Planned |

⭐ = the differentiators the web PoC exists to prove. **Phases 0–5 are the PoC.**

## 3. Phases (Web PoC)

### Phase 0 — Foundations & Walking Skeleton ✅ Done
**Goal:** a deployable web app where a user creates a Cobble and has a basic conversation —
proving the full request→harness→model→response loop and persistence work end-to-end.

**Scope**
- Resolve the `_TBD_` stack decisions (language/framework, web client, backend, store engine,
  LLM gateway/provider) and record them in `architecture.md` + `CLAUDE.md`.
- Cloud backend skeleton + persistence; LLM gateway; minimal agent harness loop.
- Web chat UI; account/auth; create-a-companion (name, form, temperament — seed only).

**Done when:** a new user signs in, names a companion, exchanges messages; conversation
persists across sessions; CI runs tests at ≥80% coverage.

**Delivered** (PR #1): TS monorepo (`packages/{core,api,web,shared,eval}`, `db/`, `infra/`).
Stack resolved in `architecture.md` §5 — TS end-to-end, Fastify API, React+Vite SPA,
Postgres+`pgvector` via Drizzle, OpenRouter gateway, Google Sign-In (+ `dev_bypass`). Single-turn
streaming harness with the `RetrieveContext`/tool/`Initiator` hook seams stubbed (`architecture.md`
§4); transcript-as-episodic-substrate (`messages.companion_id`); read-only memory browser; live
eval harness (`packages/eval`). CI runs Vitest at ≥80% coverage on `shared/db/core/api`.

### Phase 1 — The Knowledge Organism ⭐
**Goal:** prove the headline claim — feed Cobble sources and it recalls them accurately and in
context. This is the heart of the PoC.

**Scope**
- Source ingestion → parse, chunk, embed. **Formats:** file uploads (PDF, `.txt`, `.md`,
  `.docx`, `.pptx`), web links (HTML), and typed notes. Full acceptance contract (extensions,
  MIME, parser, out-of-scope formats) → `architecture.md` §4.8.
- **Semantic memory** store: organized facts/concepts + vector retrieval
  (`product-overview.md` §2.1).
- Grounded recall in chat: retrieval-augmented answers with provenance ("from your Peru book").
- Ingestion status/feedback UI ("Cobble has read 3 of 5 books").
- **Cost guardrail:** a per-user **daily token cap** (the one spend control — replaces per-route
  request limits) with a live usage indicator; over cap, chat/search 429 and ingestion **defers**
  until reset (`architecture.md` §4.8).

**Done when:** a user uploads sources and Cobble answers questions grounded in them with correct
citations; answers degrade gracefully when knowledge is absent (no confident hallucination).

**Key risks:** retrieval quality, large-document ingestion cost/latency, hallucination. Validate
with a fixed eval set of source→question→expected-answer pairs.

**Implemented** (this branch): the "improved staged hybrid" — verbatim sources/sections with
pgvector + FTS hybrid retrieval and a typed fact overlay (`ontology.md`), built by a two-pass
output-bounded ingestion pipeline off the request path (`architecture.md` §4.8); semantic recall
fills the harness memory hook with citation-carrying grounding; web surface adds the Sources
page ("read N of M"), chat citation chips, and memory search; the eval harness gained
source-grounded cases + semantic configs with the contextual-header A/B. **Gate passed**
(2026-06-04, `docs/eval/phase1-eval-20260604.txt`): the live eval shows semantic configs at
100% recall / 1.00 grounding / 0% hallucination, and the source-grounded `ceviche` case
goes from grounding 0.40 + hallucination under recency-only to 1.00 + no hallucination once
the source is retrieved — the differentiator the PoC exists to prove. The contextual-header
A/B was a tie on this set (no decisive winner; revisit on a larger eval set, `architecture.md`
§4.8). The manual e2e passed against the live stack: a `.md` upload read to `done`, a grounded
question returned the correct answer with a citation event, and an out-of-knowledge question
declined without fabricating.

### Phase 2 — Memory & Continuity
**Goal:** Cobble remembers your shared history and is recognizably *the same being* over time.

**Scope**
- **Episodic memory**: timestamped record of interactions, outcomes, context; recall by
  time/topic.
- Companion identity persisted as the cloud "home" (`product-overview.md` §2.2) — the
  substrate later surfaces load from.
- Personality evolution seeded at creation, shaped by accumulated episodes.

**Done when:** Cobble references past conversations accurately ("last week you mentioned…") and
its responses reflect accumulated understanding of the user.

**Implemented** (this branch): the **consolidated-episode** design — a background reflection pass
rolls spans of the one lifelong transcript into timestamped **episodes** (each carries a wall-clock
span and a self-reported salience) via a pgvector + FTS hybrid, recalled **by topic**, off the
request path, reusing the P1 runner/quota/sweeper pattern; episodic recall fills the same
`RetrieveContext` hook as P1 (no
loop change). **Personality evolution** re-synthesizes an `evolvedPersona` ("who I've become with
you") from accumulated episodes and blends it into the persona prompt alongside the immutable
seed temperament. Web adds the episode timeline + evolved persona to the memory browser; the eval
harness gained a Phase-2 episodic config (tiny recency window + episodic recall) that
`architecture.md` §4.3 / `companionmemory.md` §5 describe. **Gate passed** (2026-06-04,
`docs/eval/phase2-eval-20260604.txt`): the live eval shows the `episodic` config (recency
window of **2**) recalling **100%** of buried facts at **0% hallucination** vs **33%** for
`window-2` with the same window — episodic memory reaching beyond the recency window, the Phase 2
differentiator. The manual e2e passed against the live stack: a conversation crossed the
consolidation boundary → episodes formed (the key fact recorded at salience 0.8), the topic-match
hybrid returned it top-ranked, the `evolvedPersona` reflected the accumulated history, and a recall
question whose source turn was beyond the 20-message recency window was answered accurately from
episodic memory.

> **Recall scope.** Episodic recall is **topic-only** (vector + FTS, RRF). The episode's wall-clock
> span and salience are stored and displayed but **do not steer recall**: the store offers a
> time-window filter that no recall path passes yet, and RRF ignores salience (filler is dropped at
> consolidation, not at recall). The `"last week you mentioned…"` goal above is met by topic match,
> not by a time filter; wiring time/salience into recall is deferred (`implementation.md` §1).

### Phase 3 — Tools, Action & Trust
**Goal:** Cobble can *act*, not just answer — safely.

**Scope**
- Tool/skill framework (MCP-compatible); first tools: web search/crawl, reminders/calendar
  (read), a simple booking/research tool (stub or sandbox).
- Multi-step task execution (research → plan → execute).
- **Propose → approve**: approval queue + one-tap confirm for any cost/commitment/side-effecting
  action (`product-overview.md` §5.3, §7).
- Seed **procedural memory**: successful workflows become reusable.

**Done when:** Cobble completes a multi-step task that ends in a proposed action held for user
approval; nothing consequential executes without confirmation; every tool call is logged.

**Implemented** (this branch): the harness single-pass loop became the real **inner loop**
(`architecture.md` §4.1–4.2) — each turn streams, then runs the tools it requested and turns again,
guarded by a max-iteration + token ceiling (`§4.7`). A **tool framework + registry** (`core/tools/`)
ships three tools: read-only **`web_fetch`** (reuses the SSRF-guarded link resolver + content
parsers, and harvests outbound links into the lead inventory) and **`memory_search`** (P1 hybrid
store), and the effectful **`ingest_source`** (commits a page to long-term memory, reusing the P1
ingestion pipeline). **Propose→approve** is the `beforeToolCall` gate: a read-only call runs freely,
an effectful call is **held as a pending proposal and the loop EXITs** (`§4.4`); the **approval
queue** (`proposals` table) + confirm/reject routes resolve it **exactly once** (atomic claim) and
execute the held call via the shared `dispatchTool`. **Every tool call is logged** (`tool_calls`).
The **lead inventory** (`leads`) is the companion's reading list — the body-then-will substrate the
Phase 4 motivation engine will work on idle; in Phase 3 `POST /explore` works it on command.
**Procedural memory** is seeded: an approved workflow is recorded (`procedural_memories`) and
browsable. Web adds one-tap approval cards, a reading-list view, and the procedural section. **Gate
passed** (offline, deterministic — P3's differentiator is *safe action*, mechanically verifiable,
not a recall-quality score like P1/P2): the end-to-end DoD test
(`packages/api/src/routes/phase3-dod.test.ts`) drives a multi-step task (read → propose) to a held
proposal, asserts **nothing executed before confirmation** and **every tool call logged**, then
approves and asserts the action executes once + seeds a procedure. Full suite green at ≥80% coverage.

### Phase 4 — Proactivity Engine ⭐
**Goal:** prove Cobble can usefully initiate — the second core differentiator. This is the **"will"**
of the **body-then-will split**: Phase 3 ships the *body* (tools + propose→approve gate + audit log
+ the lead inventory, worked on the user's command), and Phase 4 adds the *will* that drives that
body on its own. The ordering is a **safety precondition**: autonomous, token-spending exploration
is only acceptable because every consequential act already routes through the Phase 3 approval gate
and every tool call is logged (`architecture.md` §4.4–4.5). The body is verifiable with
deterministic tests; the will only by measurement — so it lands on a trusted foundation.

**Scope** (full mechanism → `architecture.md` §4.5)
- Motivation model driving initiative: your goals & well-being, understanding you, its own
  curiosity/learning, **earning your appreciation** (learned), maintaining the bond, pending work
  & opportunities (`product-overview.md` §5.4). Drives are **learned** (interests read out of
  memory + the evolved persona), not configured.
- **Presence-aware behaviour.** The engine reads its environment — chiefly a **presence spectrum**
  (active / attentive / away / absent, from a client heartbeat + activity recency) — and picks a
  fitting expression: engage you when present, do solo work when you're away (surfaced on return),
  and **stay idle** when nothing is worth doing. *(Phase 4 v1 expresses this through autonomous
  proposals only; engaging you with unprompted messages is deferred — see below.)*
- **Lazy, web-appropriate trigger.** Proactive turns fire on user activity + on return + a periodic
  sweep — not an always-on per-companion drain. The companion **works its lead inventory** — the
  same exploration loop Phase 3 ran on command, now self-triggered. *(Genuine work **while you're
  away** — continuous between-visit activity — is **deferred to Phase 6**, where push gives it an
  audience.)*
- **Cheap arbitration, then a burst.** A token-free heuristic gate (drive × salience) decides
  *whether* to act; only on commit does an LLM burst run the move. "Idle is a valid outcome."
- **Attention model (the "creature"):** each initiation is a **bounded burst**, not a full drain
  of the inventory — shaped by personality parameters **focus length**, **boredom** (interest
  decays without payoff), and **distractibility** (a higher-salience lead preempts). Different
  Cobbles run different constants (tenacious deep-reader vs. magpie), seeded at creation.
- **Stamina & energy (the budget made legible).** Reframe the per-user daily cap into two pools —
  **stamina** (user-initiated work) and **energy** (the engine's self-initiated work) — so autonomy
  can never starve conversation (`architecture.md` §4.8). Phase 4 ships the mechanism plus a
  **simple meter + manual top-up**; the full feeding/"food" game economy is **Phase 5**.
- **Reinforcement (v1).** Hard approval signals (approved / rejected / dismissed / ignored) update
  interpretable per-drive weights, so the companion learns what lands — and a Cobble, starting
  **neutral**, is *raised* into its personality rather than born with one. *(The LLM-critic
  feeling-score and a deeper policy are deferred with conversational proactivity.)*
- Tunable frequency/intensity controls (a per-companion off/gentle/active dial).

Full mechanism (drive taxonomy, arbitration, seeding, learning, examples) →
`companion-motivation.md`.

**Done when:** on opening the app with no prompt, Cobble offers genuinely relevant **proposals**
(from working its reading list); users can dial it down; energy is consumed and, when exhausted,
initiation stops while chat keeps working; reward is captured to track helpful-vs-annoying.

**Key risk:** annoyance. Gate behind tunability + the energy budget, and measure
engagement/dismissal (the reinforcement signal) from day one.

**Deferred (designed here, built later):** **unprompted conversation** (tips/questions/check-ins) +
the LLM-critic + a sense of **purpose/agenda** → a later phase (Phase 4 v1 is proposal-only);
continuous work-while-away → Phase 6 (needs push); the stamina/energy **game economy** (food types,
feeding, store, rich meters) → Phase 5; deeper RL beyond the v1 weight update.

**Implemented** (this branch): the reserved `Initiator` seam is filled by a **motivation engine**
(`packages/core/src/motivation/`) that fills it on a **lazy trigger** — `motivation.request` on a
sent turn + on opening the transcript (return), plus a periodic `sweepMotivation`, all coalesced off
the request path by a `MotivationRunner` (mirrors the consolidation runner). Each tick reads
**drives × presence** and either stays idle (token-free) or runs a **bounded explore burst**: a
**presence spectrum** (`presence.ts`, fed by a heartbeat) gates self-initiation; a token-free
**arbitration** gate (`arbitration.ts`: `pressure = level × weight` vs the dial threshold) decides;
when it commits, `runExploreBurst` turns the **lead inventory** into **autonomous ingest proposals**
(the extracted P3 `/explore` path, now self-triggered). **Stamina/energy** split the old daily cap
into two pools — chat draws stamina, the engine draws **energy** (`companion_energy`), so autonomy
can never starve interaction; out of energy → the engine idles while chat runs on. The
propose→approve gate now stamps proposal **origin** (`chat|explore|autonomous`); confirm re-enters
the loop only for `chat` (the §4.4 open note, resolved). **Reinforcement v1**: each initiation logs a
`proactive_outcomes` row; approval/rejection applies a hard-signal reward that nudges the served
**drive weight** (EMA, neutral start), so a Cobble is *raised* into its disposition. Web adds a
two-pool **vitality meter** + one-tap feed and an **off/gentle/active** dial. **Gate passed**
(offline, deterministic — P4's differentiator is *safe, tunable, learning proactivity*, mechanically
verifiable): the DoD test (`packages/api/src/routes/phase4-dod.test.ts`) proves open-app→relevant
autonomous proposal, energy consumed, out-of-energy/dial-off → no initiation, and approval →
reward + weight shift without re-entering chat. Full suite green at ≥80% coverage. Canonical
mechanism: `docs/companion-motivation.md`.

### Phase 5 — Bond & Growth (PoC complete)
**Goal:** make Cobble feel raised, not used — closing the PoC loop.

**Scope**
- Visible growth on four axes tied to memory (`product-overview.md` §5.5):
  knowledge (semantic/episodic), relationship/personality, unlockable abilities (procedural),
  and **visual/character evolution** (appearance/home/accessories).
- Leveling/progression surfaced in the UI.
- **Stamina/energy game economy:** the Phase 4 vitality meters grow into a feeding loop — "food"
  the user gives that favours stamina or energy, top-up/economy, and richer visuals
  (`product-overview.md` §5.6).

**Done when:** a returning user can see and feel how their Cobble has grown; the web PoC
demonstrates all three differentiators (knowledge organism, embodiment groundwork, proactivity)
end-to-end. **Decision gate:** validate the concept before funding native surfaces.

## 4. Phases (Full Product)

### Phase 6 — Mobile Surface
Native mobile app as a "living room" the companion is summoned into. Adds: GPS/location-aware
recall, push notifications (the away-channel for proactivity), and **OS-as-tools** (files,
photos, calendar, contacts, health — permission-gated). Implements the **one-embodiment-at-a-time
summon** model and the companion-as-courier sync (`product-overview.md` §2.2, §5.2). The push
channel also unlocks the **eager "work while you're away"** proactivity designed in Phase 4
(`architecture.md` §4.5) — genuine between-visit activity that now has an audience.

### Phase 7 — Desktop Surface
Native desktop app: file/workspace OS tools, heavier local storage/compute. Confirms the
surface-portable architecture holds across three clients.

### Phase 8 — Hardening & Launch Readiness
Security & threat-model review, encryption in transit/at rest, data inspection/management/delete
controls, scale/cost work, and monetization. Resolve remaining open questions (§5).

## 5. Open Questions to Resolve (owned here)
Owned here (single-source). Each is assigned a decision point:

| Question | Decide by |
|---|---|
| ~~Final stack: framework, client, store engine, LLM provider~~ | **Decided (Phase 0):** TS end-to-end, Fastify, React+Vite, Postgres+`pgvector`/Drizzle, OpenRouter, Google Sign-In (`architecture.md` §5) |
| Single companion vs. multiple per user | Phase 2 (identity model) — **MVP: one companion per user**; multiple is a deferred capability |
| ~~One continuous conversation vs. multiple sessions per companion~~ | **Decided (Phase 0): one continuous, lifelong conversation per companion** — no session/thread entity (`architecture.md` §2, invariant #6) |
| Initial tool/skill integrations (maps, calendar, search, booking) | Phase 3 |
| Long-term memory retention vs. summarization over time | Phase 2, revisited Phase 8 |
| Surface rollout confirmed (web → mobile → desktop) | Phase 5 decision gate |
| Monetization model (subscription, ability packs) | Phase 8 |
| Push-notification cadence & away-proactivity rules | Phase 6 |

## 6. Out of Scope (this plan)
- Internal implementation detail and data schemas → `architecture.md`,
  `implementation.md`.
- The ontology contract for structured knowledge → `ontology.md`.
- Native surfaces before the web PoC decision gate (Phase 5).
