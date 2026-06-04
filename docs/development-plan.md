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
| **3** | Tools, action & trust | Web | Tool/MCP use + propose→approve approval queue | Planned |
| **4** | Proactivity engine | Web | Motivated, tunable initiative ⭐ | Planned |
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

### Phase 4 — Proactivity Engine ⭐
**Goal:** prove Cobble can usefully initiate — the second core differentiator.

**Scope**
- Motivation model driving initiative: your goals & well-being, its own curiosity/learning,
  maintaining the bond, pending work & opportunities (`product-overview.md` §5.4).
- Idle/return-triggered proactive turns (in-app, since web); proposals and questions back to you.
- Tunable frequency/intensity controls.

**Done when:** on opening the app with no prompt, Cobble offers genuinely relevant proposals or
questions; users can dial it down; a holdout/measurement exists to track helpful-vs-annoying.

**Key risk:** annoyance. Gate behind tunability and measure engagement/dismissal from day one.

### Phase 5 — Bond & Growth (PoC complete)
**Goal:** make Cobble feel raised, not used — closing the PoC loop.

**Scope**
- Visible growth on four axes tied to memory (`product-overview.md` §5.5):
  knowledge (semantic/episodic), relationship/personality, unlockable abilities (procedural),
  and **visual/character evolution** (appearance/home/accessories).
- Leveling/progression surfaced in the UI.

**Done when:** a returning user can see and feel how their Cobble has grown; the web PoC
demonstrates all three differentiators (knowledge organism, embodiment groundwork, proactivity)
end-to-end. **Decision gate:** validate the concept before funding native surfaces.

## 4. Phases (Full Product)

### Phase 6 — Mobile Surface
Native mobile app as a "living room" the companion is summoned into. Adds: GPS/location-aware
recall, push notifications (the away-channel for proactivity), and **OS-as-tools** (files,
photos, calendar, contacts, health — permission-gated). Implements the **one-embodiment-at-a-time
summon** model and the companion-as-courier sync (`product-overview.md` §2.2, §5.2).

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
