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
| **5** | Bond & growth | Web | Four-axis growth mirror + character card — the PoC complete | ✅ **Done** |
| **6** | Mobile surface | + Mobile | Summon model, GPS recall, push, OS-as-tools | Planned |
| **7** | Desktop surface | + Desktop | File/workspace OS tools, heavier local storage | Planned |
| **8** | Hardening & launch readiness | All | Security, scale, privacy controls, monetization | Planned |
| **9** | Tool acquisition — MCP | Web / server-host | Whitelisted HTTP MCP servers discovered, loaded & used at runtime, no redeploy | ✅ **Done** (PR #10) |
| **10** | Tool acquisition — CLI | Web / server-host | Whitelisted host CLIs discovered, loaded & driven at runtime, no redeploy | ✅ **Done** (PR #11) |
| **11** | User Model — core profile | Web | Cobble captures & uses the user's identity facts (name, pronouns, age, …) ⭐ | ✅ **Done** (§4c) |
| **12** | User Model — learned beliefs | Web | Learns preferences/interests/opinions (explicit + implicit); surfaces them unprompted **and acts on them**, refining from reactions ⭐ | ✅ **Done** (§4c) |
| **13** | User Model — understanding & hygiene | Web | Synthesized user-persona; decay & sensitive attributes; full edit/forget UI | ✅ **Done** (§4c) |
| **14** | Greeting / arrival reaction | Web | Companion notices you arrive and reacts — greets in context, picks up open threads, or rests when spent | ✅ **Done** (§4d) |
| **15** | Realtime delivery — standing event channel | Web | New messages (replies, proactive notes, greetings) reach an open client by push; navigating away and back is always current — no forced refresh | ✅ **Done** (PR #16, §4e) |

⭐ = the differentiators the web PoC exists to prove. **Phases 0–5 are the PoC.**

> **Phases 9–10 are a server-host capability workstream, independent of the native-surface phases
> (6–8).** They extend the existing web/cloud surface — they don't depend on mobile/desktop — so the
> numbering is a label, not a strict ordering after Phase 8. Full design → `companion-tools.md`.

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

**Delivered** (PR #1): the TS monorepo and its package layout (folder structure →
`architecture.md` §7); the canonical stack choices live in `architecture.md` §5 (not re-enumerated
here). A single-turn streaming harness with the `RetrieveContext`/tool/`Initiator` hook seams stubbed
(`architecture.md` §4); the transcript-as-episodic-substrate model (schema → `implementation.md` §1);
a read-only memory browser; and the live eval harness. CI runs Vitest at ≥80% coverage.

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
- **Spend control:** a per-companion **vitality wallet** (the one spend control — replaces per-route
  request limits) with a live remaining-balance indicator; when empty, chat/search 429 and ingestion
  **defers** until the wallet is refilled by feeding (`architecture.md` §4.8). (An account-wide
  real-money cap across a user's companions is deferred — `architecture.md` §9.)

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
loop change). **Personality evolution** re-synthesizes an **evolved persona** ("who I've become with
you") from accumulated episodes and blends it into the persona prompt alongside the immutable
seed temperament. Web adds the episode timeline + evolved persona to the memory browser; the eval
harness gained a Phase-2 episodic config (tiny recency window + episodic recall) that
`architecture.md` §4.3 / `companion-memory.md` §5 describe. **Gate passed** (2026-06-04,
`docs/eval/phase2-eval-20260604.txt`): the live eval shows the `episodic` config (recency
window of **2**) recalling **100%** of buried facts at **0% hallucination** vs **33%** for
`window-2` with the same window — episodic memory reaching beyond the recency window, the Phase 2
differentiator. The manual e2e passed against the live stack: a conversation crossed the
consolidation boundary → episodes formed (the key fact recorded at salience 0.8), the topic-match
hybrid returned it top-ranked, the evolved persona reflected the accumulated history, and a recall
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
guarded by a max-iteration + token ceiling (`§4.7`). A **tool framework + registry** ships three
tools: read-only **`web_fetch`** (reuses the SSRF-guarded link resolver + content parsers, and
harvests outbound links into the lead inventory) and **`memory_search`** (the P1 hybrid store), and
the effectful **`ingest_source`** (commits a page to long-term memory, reusing the P1 ingestion
pipeline). **Propose→approve** is the tool-call gate: a read-only call runs freely, an effectful call
is **held as a pending proposal and the loop EXITs** (`§4.4`); the **approval queue** + confirm/reject
routes resolve it **exactly once** (atomic claim) and execute the held call. **Every tool call is
logged.** The **lead inventory** is the companion's reading list — the body-then-will substrate the
Phase 4 motivation engine will work on idle; in Phase 3 `POST /explore` works it on command.
**Procedural memory** is seeded: an approved workflow is recorded and browsable. Web adds one-tap
approval cards, a reading-list view, and the procedural section. (Data model → `implementation.md`
§1; loop + gate → `architecture.md` §4.) **Gate passed** (offline, deterministic — P3's
differentiator is *safe action*, mechanically verifiable, not a recall-quality score like P1/P2): the
end-to-end Phase 3 DoD test drives a multi-step task (read → propose) to a held proposal, asserts
**nothing executed before confirmation** and **every tool call logged**, then approves and asserts the
action executes once + seeds a procedure. Full suite green at ≥80% coverage.

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
  and **stay idle** when nothing is worth doing. *(Phase 4.1 expresses solo work by **reading** leads
  into memory and posting one report note; unprompted conversation beyond that is deferred — below.)*
- **Lazy, web-appropriate trigger.** Proactive turns fire on user activity + on return + a periodic
  sweep — not an always-on per-companion drain. The companion **works its lead inventory** — the
  same exploration loop Phase 3 ran on command, now self-triggered. *(Genuine work **while you're
  away** — continuous between-visit activity — is **deferred to Phase 6**, where push gives it an
  audience.)*
- **Cheap arbitration, then a burst.** A token-free heuristic gate (drive × salience) decides
  *whether* to act; only on commit does the burst spend real tokens (reading leads into memory, **no
  approval**), sized to what energy affords. "Idle is a valid outcome."
- **Attention model (the "creature"):** each initiation is a **bounded burst**, not a full drain
  of the inventory — designed to be shaped by personality parameters **focus length**, **boredom**
  (interest decays without payoff), and **distractibility** (a higher-salience lead preempts).
  **v1 ships only focus length live** (the burst limit); boredom and distractibility are persisted
  but inert until the multi-step / multi-behaviour loop lands (`companion-motivation.md` §6, §10).
  Different Cobbles run different constants (tenacious deep-reader vs. magpie), seeded at creation.
- **Stamina & energy (the budget made legible).** Two per-companion **vitality wallets** —
  **stamina** (user-initiated work) and **energy** (the engine's self-initiated work) — that spend
  down with use and refill only by feeding, so autonomy can never starve conversation
  (`architecture.md` §4.8). Phase 4 ships the wallets plus a **remaining-balance meter**; the
  feeding/"food" game economy that refills them is **Phase 5**.
- **Reinforcement (mood change, Phase 4.2).** The companion learns from **conversation** the way a
  person does: the agent loop senses the user's mood on **every** turn and feeds the prior read
  forward to **attune** the next reply (the fast loop). After it reads and posts a report note, the
  **change** in mood across the user's reaction (`delta = valence_now − valence_before`) is the reward
  → an additive nudge to interpretable per-drive weights (a zero change is a no-op, so neutrality
  needs no threshold). No separate critic, no approve/reject button. v1 learns only on a drive-serving
  act; ordinary chat senses but doesn't yet move weights. A Cobble starting **neutral** is *raised*
  into its personality. *(Deferred: ordinary-chat learning; a deeper contextual-bandit policy.)*
- Tunable frequency/intensity controls (a per-companion off/gentle/active dial).

Full mechanism (drive taxonomy, arbitration, seeding, learning, examples) →
`companion-motivation.md`.

**Done when:** on opening the app with no prompt, Cobble **reads** genuinely relevant leads from its
list on its own and reports back in one note; users can dial it down; energy is consumed and, when
exhausted, initiation stops while chat keeps working; replies **attune** to the user's mood, and the
**change** in mood across the user's reaction to the note shifts the drive weight (helpful-vs-annoying,
learned from conversation — no button, sensed in the loop).

**Key risk:** annoyance. Gate behind tunability + the energy budget, and measure
engagement/dismissal (the reinforcement signal) from day one.

**Deferred (designed here, built later):** **ordinary-chat learning** (using the every-turn mood
change to move bond/understanding/persona, not only on a drive-serving act); **unprompted
conversation** beyond the report note (tips/questions/check-ins) + a sense of **purpose/agenda** → a
later phase; continuous work-while-away → Phase 6 (needs push); the stamina/energy **game economy**
(food types, feeding, the pantry, rich meters) → Phase 5; deeper RL beyond the additive weight nudge;
**approval for outward/ irreversible tools** (when such tools exist — autonomous reads are internal +
energy-bounded today).

**Implemented** (Phase 4.1–4.2, this branch): the reserved `Initiator` seam is filled by a
**motivation engine** on a **lazy trigger** coalesced off the request path. Each tick weighs
**drives × presence** and either stays idle (token-free) or runs a **bounded autonomous burst** that
**reads** the next leads into the companion's own memory **with no approval** and posts **one
in-character report note**. Work spends two per-companion vitality wallets — chat draws **stamina**,
autonomous reads draw **energy** — so autonomy can never starve interaction; out of energy the engine
idles while chat runs on. **Reinforcement is conversational:** the loop senses the user's mood on
every turn and feeds the prior read forward to **attune** the next reply; the **change** in mood
across the user's reaction to a report note is the reward — an additive nudge to the served drive
weight (neutral start, a zero change is a no-op, no separate critic, no button), so a Cobble is
*raised* into its disposition from conversation. The approval gate is kept for **chat** effectful
calls + the user-initiated `/explore`. Web adds a two-wallet **vitality meter**, one-tap feed, and an
**off/gentle/active** dial. (Data model → `implementation.md` §1; full mechanism →
`companion-motivation.md`.) **Gate passed** (offline, deterministic): the Phase 4 DoD test proves
open-app → autonomous read + report note + energy consumed; out-of-energy/dial-off → no initiation;
reaction-to-note → mood-change reward + weight shift. Full suite green at ≥80% coverage.

### Phase 5 — Bond & Growth (PoC complete)
**Goal:** make Cobble feel raised, not used — closing the PoC loop.

**Scope**
- Visible growth on four axes tied to real activity (`product-overview.md` §5.5), framed as a
  **mirror/instrument** — a readout of the companion's current standing, not a game ladder:
  **knowledge** (semantic/episodic), **bond** (shared-history depth), **initiative** (autonomous
  behaviour, from the proactive-outcome log), and **character** (the emerged drive disposition).
- Each axis shown as a descriptive **band** + gauge (no levels/XP); readings may move either way and
  young axes read honestly empty. A separate **capabilities** checklist of what the companion has been
  observed doing.
- **Stamina/energy game economy:** the Phase 4 vitality meters grow into a feeding loop — the user
  spends "food" from a per-user pantry that favours stamina or energy (the one deliberate game loop;
  `companion-economy.md`).

**Done when:** a returning user can see and feel how their Cobble has grown; the web PoC
demonstrates all three differentiators (knowledge organism, embodiment groundwork, proactivity)
end-to-end. **Decision gate:** validate the concept before funding native surfaces.

**Implemented** (this branch): growth is a **mirror** — **derived from substrate that already
exists**, never an XP grind, and allowed to move in either direction. A growth service reads the
semantic/episodic counts, the tool/procedure/affect logs, the proactive-outcome log, and the learned
drive weights, and computes **four axis readings** (Knowledge, Bond, Initiative, Character) — each a
descriptive **band** + an intra-band gauge fill — plus a **capabilities checklist** (six capabilities
flipped from real logs: web research, memory recall, reading sources, a learned routine, multi-step
tasks, mood attunement) and a **character card** ("Who *X* has become" — the emerged drive disposition
+ evolved persona). Young axes read honestly empty ("Hasn't ventured out yet", "Still forming"). A
stored **idempotent high-water mark** (highest band per axis + observed capabilities) lets the
readings recompute freely while the mark **never floors** the surface; it exists only so a reflection
fires **exactly once** per band/capability reached. Recompute runs **post-turn
only**, off the request path, posting one in-character **growth reflection** to the transcript on a
genuine advance; the growth read is a **read-only** snapshot of the live derived standing, so a read
(or a client poll) never advances the mark or writes to the transcript. The **feeding economy** (the
one deliberate game loop, decoupled from growth) turns the P4 vitality meters into a kitchen: the user
spends typed **foods** from a per-user **pantry** (seeded, no currency) to refill the two wallets.
**Procedural retrieval-as-hint** makes the capabilities
*functional*: a new `RetrieveContext` arm surfaces a relevant learned routine into context (no loop
change — invariant #3). Web adds a **Growth view** (four axis readings, capabilities checklist,
character card, kitchen). (Data model → `implementation.md` §1; mechanisms → `companion-economy.md`,
`companion-memory.md`.) **Gate passed** (offline, deterministic — growth is mechanical, not a
recall-quality score): the Phase 5 DoD test proves substrate change → a band rises + capabilities
observed + reflection posted; feeding consumes a food from the pantry and refills the right wallet
(out of that food → refused); recompute is idempotent (no double-reflection); and a learned
procedure resurfaces as a context hint. Full suite green at ≥80% coverage.

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

## 4b. Tool-Acquisition Workstream (post-PoC, server-host)

Lets the companion's toolset **grow at runtime without code or redeploy** — it *acquires* new
primitive abilities, complementing procedural memory, which *combines* the ones it has. A
server-host capability track, **independent of** the native-surface phases (6–8). Full design,
trust model, and security: `companion-tools.md`; architecture placement: `architecture.md` §9;
implementation design: `implementation.md` §6. Both phases share one spine — generic executors plus
**`search_tools`**/**`load_tool`** discovery meta-tools; a **catalog** of whitelisted tools indexed
off-context; a per-companion **equipped set** loaded on demand; and a **dynamic registry resolved
per model step** so a mid-turn `load_tool` is callable on the next loop iteration (loop shape
unchanged — invariant #3). The companion **discovers and loads only the tools a job needs** rather
than carrying every tool in context, so the catalog scales to many servers. The trust model is the
**developer's whitelist** (it defines the catalog): whitelisted + valid → runs free; otherwise
denied — a separate system from propose→approve, which still governs outward actions
(`architecture.md` §4.4).

### Phase 9 — Runtime Tool Acquisition: MCP
**Goal:** a developer can whitelist an HTTP MCP server and the companion uses its tools at runtime —
no code change, no redeploy — **discovering and loading** the right tool when a turn calls for it,
without carrying every tool in context.

**Scope**
- Refactor the static boot registry into a **composition of capability sources** (core + equipped),
  behind the unchanged `list()`/`get()` interface, **resolved per model step** so a `load_tool` is
  callable on the next loop iteration (loop shape unchanged — invariant #3).
- **Tool catalog:** index every whitelisted server's tools as **lightweight entries** (id, name,
  one-line description — no argument schemas), off-context; refreshed on whitelist change.
- **`search_tools`** (cheap off-loop LLM lookup over the catalog → ranked candidate ids) +
  **`load_tool`** (connect server if needed; fetch the **fresh** schema; equip it).
- **HTTP/SSE MCP client + adapter:** `initialize` + `tools/list`; adapt each MCP tool to the existing
  `Tool` interface; proxy `tools/call`; results re-enter context as **untrusted** (injection-hardened
  like §2.1 grounding).
- **Per-companion equipped set**, persisted (per tool: server ref + the last-fetched schema snapshot —
  no endpoint, auth-secret reference, or status; those resolve from the whitelist at call time): a
  single tier bounded by `maxEquippedTools` (LRU eviction), driving the per-step registry rebuild
  without a network round-trip. The fixed *core* tools live in code, never in this set. **Promotion =
  proactive loading**: a recalled procedural routine names the tools it needs that aren't equipped, and the
  companion `load_tool`s them up front — anticipation, not a frequency-pinned tier.
- **Trust/security:** developer whitelist defines the catalog → binary allow/deny; **HTTP/SSE only**,
  SSRF-guarded; no stdio; credentials via the secret manager (never stored/sent to the model).

**Done when:** a developer whitelists an HTTP MCP server; on a relevant user turn the companion
**`search_tools` → `load_tool` → calls** a tool from that server, the loaded tool becoming callable
on the next loop iteration; the equipped tool **survives a restart**; an **off-whitelist**
server never appears in the catalog and cannot be loaded; the catalog scales to many servers without
inflating per-turn context; `tools/call` results are sanitized as untrusted; every call is logged
(`tool_calls`).

**Key risks:** discovery latency (search→load adds round-trips — mitigated by proactive loading of a
recalled routine's tools before the job starts), catalog staleness (mitigated by fetching the
authoritative schema at load), server
availability/latency, and untrusted tool output — validate the SSRF boundary and injection-hardening
on MCP results.

**Implemented** (PR #10): the full **discover → load → call → remember** spine plus the **MCP
executor**, off by default (empty whitelist). The static boot registry became a **composition of
capability sources** resolved **per model step** behind the unchanged tool-registry interface, so a
tool loaded mid-turn is callable on the next loop iteration (loop shape unchanged — invariant #3) and
degrades to the static registry if resolution throws, so acquisition never breaks a turn. A
deployment-wide **catalog** indexes every whitelisted server's tools as lightweight entries (id, name,
one-liner — no schemas); **`search_tools`** is a cheap off-loop LLM lookup over it → ranked ids, and
**`load_tool`** connects the server if needed, fetches the **fresh** schema, and equips it. The
per-companion **equipped set** is a single LRU-bounded tier; the fixed core tools (native + the two
discovery meta-tools) live in code, never counted. **Promotion = proactive loading**: a recalled
procedural routine names tools it needs that aren't equipped and the companion loads them up front.
The executor is a provider-agnostic MCP gateway + adapter (namespaced, collision-safe tool names;
results fenced as untrusted external data) over the official MCP SDK — **HTTP/SSE only**, routed
through an **SSRF-guarded** fetch (connection-layer DNS re-validation, not just a string check). The
**whitelist** is the entire MCP trust decision — binary allow/deny, admission **per-server** (a
whitelisted server admits every tool it advertises). (Schema + config → `implementation.md` §1, §3;
trust model + full mechanism → `companion-tools.md`.) **Gate passed** (offline, deterministic — like
P3/P5, the differentiator is *mechanical*: acquisition without redeploy, not a recall-quality score):
the Phase 9 DoD test proves a relevant turn drives `search_tools → load_tool → call` with the loaded
tool callable on the **next** iteration (every call logged); an **off-catalog** id is denied before
any gateway call (and still audited); only the small core set is advertised regardless of catalog
size (no acquired tool until loaded — the catalog scales without inflating per-turn context); and an
equipped tool **survives a process restart** (a cold instance rebuilds the registry from the
persisted equipped row, no re-discovery). Full suite green at ≥80% coverage. Canonical mechanism:
`docs/companion-tools.md`.

### Phase 10 — Runtime Tool Acquisition: CLI
**Goal:** a developer can whitelist a host CLI; given the tool's docs, the companion learns to drive
it and preserves the working invocation — no code change, no redeploy.

**Design note (resolved):** CLI tools work **like MCP tools** — a second capability source over the
same discover → load → call → remember spine; the only difference is the transport at the leaf (a
local subprocess instead of HTTP). CLI tools are **developer-described folders** (the analogue of an
MCP server's self-description), so the model fills a fixed argument schema rather than composing
free-form commands, and "remember" reuses the existing procedural + proactive-loading spine (no
CLI-specific learning machinery). Full design → `companion-tools.md`.

**Scope**
- **`CLI_TOOLS_PATH` tool folders** — each whitelisted tool is a folder (`TOOL.json` = binary +
  model-facing argument schema + argv template + mandatory limits; `TOOL.md` = the usage prompt). The
  **folder set is the CLI trust boundary** (read-only, deployment-controlled), config not DB.
- **CLI sandbox** — the executor each `cli__<ref>` tool delegates to: **no shell** (argv verbatim),
  scrubbed env, per-tenant ephemeral working dir, time/output ceilings (mirrors the `web_fetch`
  byte-cap posture). Portable subprocess tier; OS-level/network isolation deferred (`companion-tools.md`
  §7/§9).
- **Argument validation** — the model fills the tool's JSON-Schema `parameters`; an argv template
  renders validated values into **discrete argv elements**. Binary allow/deny, no per-call approval,
  no free-form command or per-arg regex policy.
- **Same spine, symmetric with MCP** — a `CapabilitySource` refactor lets CLI plug into the existing
  catalog / `search_tools` / `load_tool` / per-step registry / proactive loading unchanged.
- **Trust/security:** developer-whitelist (the folder set); output sandboxed + treated as untrusted;
  a removed folder revokes the tool immediately (call-time re-read).

**Done when:** a developer drops a tool folder under `CLI_TOOLS_PATH`; on a relevant turn the
companion **`search_tools` → `load_tool` → calls** it (callable on the next loop iteration); the
equipped tool **survives a restart**; an **unknown/invalid** id is denied before any subprocess;
output is **sandboxed + untrusted**; every run is logged.

**Key risks:** host-execution safety (mitigated by the read-only trusted folder set + the no-shell
sandbox on the multi-tenant host; network isolation deferred to Phase 8), and
prompt-injection-to-execution (bounded by the fixed binary + schema-validated argv — no value can
become a command).

**Implemented** (PR #11): the CLI track as a **second capability source over the Phase 9 spine**,
off by default (no tools directory configured). A capability-source refactor made the three MCP-only
seams (catalog builder, `load_tool` schema resolution, equipped-registry resolver)
**source-polymorphic** — MCP became one such source, with MCP behaviour provably unchanged (the
Phase 9 DoD passes verbatim). The CLI source treats tools as **developer-described folders** (a
`TOOL.json` declaring the binary, a `parameters` JSON Schema, an argv template, and mandatory per-run
limits, plus a `TOOL.md` usage prompt): the model's args are validated against the schema, each
parameter is rendered into a **discrete argv element** (no shell, injection-inert), run through a
sandbox, and the output fenced as untrusted. The store **re-reads the def at call time**, so a
removed folder is revoked immediately. The production sandbox spawns with no shell, a scrubbed env, a
per-tenant ephemeral cwd, and wall-clock + output-byte kills; the production store scans the tools
directory, skips+logs invalid folders, and rejects path-traversal refs. The folder set under the
configured tools path is the entire CLI trust boundary (admit-by-deploy). (Schema + config →
`implementation.md` §1, §3; trust model + the `TOOL.json` contract → `companion-tools.md`.) **Gate
passed** (offline, deterministic): the Phase 10 DoD test drives `search_tools → load_tool → call`
over a real file-system tool store (temp fixture) + a fake sandbox with every call logged; an
off-catalog id is denied before any subprocess; only the core set is advertised regardless of catalog
size; and an equipped CLI tool **survives a process restart**. A separate test exercises the real
subprocess sandbox (argv verbatim, byte cap, timeout kill, missing binary). Full suite green at ≥80%
coverage. Canonical mechanism: `docs/companion-tools.md`. **Deferred** (Beyond the PoC): tool-doc
ingestion into semantic memory, an experimentation/probe harness, and OS-level sandbox + network
isolation.

## 4c. User-Model Workstream (knowing & understanding the user)

The PoC (Phases 0–5) makes the companion know the *world* (semantic memory) and remember its
*shared history* (episodic) — but it holds almost nothing structured about **the user**: only a
set-once display name, with preferences living as un-queryable episode narrative
(`companion-memory.md` §4 documents the gap). This workstream closes it: the companion builds an
explicit, legible **User Model** — the symmetric mirror of the `evolvedPersona` it already grows
for *itself*. Like the tool-acquisition workstream (§4b), the numbering is a label, not a strict
ordering after Phase 10; it extends the existing web surface and depends only on the PoC memory
spine.

**Design decisions (locked):** one ontology, the **user is a privileged entity** (`ontology.md`);
a **separate, per-user `user_facts` table** (keyed by `user_id` — facts are objective truths about
the person, shared across the user's companions; only the Tier-3 synthesized persona is
per-companion) (`implementation.md` §1); the user's **name is a Tier-1 user-fact, not a `users`
column** (the old `display_name` + `setUserDisplayName` are retired) — seeded from Google's `name`
claim at sign-in (`source=auth_seed`) and refined in conversation; user-facts carry a **`source`**
origin (`transcript` \| `auth_seed` \| `user_edit`) so provenance covers seeds and edits, not just
transcript turns; extraction is **hybrid** —
inline salient capture (post-turn perception) + **background reflection** (extends consolidation);
**full trust, no approval gate** for memory writes (everything legible/editable/forgettable
instead); and an **eval dataset (`user-extract`)** is the quality gate so extraction can be
iterated. **Phase 12 additions (locked):** the reflector reads the **raw transcript window** (not the
lossy episode summaries — the implicit signal is in the un-summarized record); revision is
**current-state supersession** (last-wins on the current row, prior retained as history — *not*
contradiction-deletion); the Tier-2 belief set is **closed** (`prefers`/`dislikes`/`interestedIn`/`believes`);
and the **belief-learning loop is in-scope** — beliefs drive the motivation engine *and* the engine's
reinforcement refines belief salience (decay deferred to Phase 13). **Phase 13 additions (locked) —
a memory that behaves like a memory:**
- **Tier-3 blend is additive.** The synthesized `user_persona` is an extra persona paragraph; Tier-1
  identity facts stay rendered **verbatim** as exact ground truth, never paraphrased through the
  narrative. Synthesized by a `LlmUserPersonaSynthesizer` that **mirrors the Personality Evolver**
  (own cursor, re-synthesize only when facts/episodes advanced, off-request).
- **`user_facts` is current-state only.** Supersession becomes a **replace** (latest wins; the old value
  is *not* kept in the table) — the **superseded chain is dropped** (`superseded_at`/`superseded_by`
  removed). The *timeline* of the self ("loved coffee, then quit") lives where it belongs, in **episodic
  memory** (the lossless transcript + episodes); `user_facts` is the semantic-style "what's true now"
  overlay, not a second home for history.
- **Forgetting is the tail of decay, not a binary delete.** Tier-2 belief `salience` **decays lazily**
  (`effective = stored × decay(now − updated_at)`, uniform half-life, computed in the two read paths — no
  sweeper); as it fades a belief is spoken more tentatively and below a floor stops surfacing — *that* is
  forgetting (graceful, partial, like a person). **No tombstone:** if the transcript still supports a
  forgotten belief the reflector may re-learn it — accepted as natural relearning, not a bug.
- **A `deleteFact` control for what doesn't decay.** Tier-1 identity has **no salience and no decay**, so
  the user removes it by hand — **edit** (replace) / **delete** (a single-row `deleteFact`, replacing the
  Phase-11 soft-supersede). The same control is extended to Tier-2 for immediacy. **Sensitive** rows
  (gated at write — see below) get a **true purge** (and optionally forgetting the originating transcript
  turn) — the one place erasure must be complete.
- **Uncertainty-aware recall + self-correction.** A belief is rendered by its **confidence × effective
  salience**: fresh/reinforced → asserted, faded/low-confidence → hedged ("I have a vague sense you're
  into jazz — or was it blues?"). The companion is **licensed to ask** when unsure; the answer reinforces
  or replaces — closing a conversational self-repair loop. (No data is ever corrupted; "partial/wrong
  memory" is an effect of *rendering* uncertainty, not storing falsehoods. A heavier conflict-detection
  engine is deferred.)
- **Sensitive attributes are gated at write.** A low-confidence inference about a closed set of protected
  matters (gender/age/health/religion/sexuality/ethnicity/political) is **not persisted**; explicit user
  statements always pass; persisted sensitive rows carry a `sensitive` flag.

Canonical mechanism end-to-end → `companion-memory.md` §4; components → `architecture.md` §3, §4.3, §4.5;
reinforcement → `companion-motivation.md` §7.

### Phase 11 — User Model: core profile ⭐
**Goal:** the companion knows the user's stable identity and uses it naturally.

**Scope**
- The per-user `user_facts` table (with the `source` origin column) + `UserModelStore` behind the
  MemoryStore seam (`implementation.md` §1). Retire the `users.display_name` column and the
  `setUserDisplayName` stub — the name becomes a Tier-1 `user_fact`, **seeded from Google's `name`
  claim at provision** (`source=auth_seed`, modest confidence).
- **Inline salient capture**: post-turn perception (sibling to affect sensing) extracts **explicit**
  identity facts; a stated name is captured as the singular `name` attribute (`source=transcript`),
  superseding the seed; the persona asks for a name only when Google supplied none.
- **Tier-1 core profile** assembled into the persona prompt every turn (name + singular identity
  attributes), so replies address a known person.
- Memory browser shows the profile and makes each fact **editable / forgettable** (the read-only
  browser gains its first write affordance, scoped to the user model).
- `user-extract` eval dataset (explicit-attribute cases) — the extraction quality gate.

**Done when:** the user states an identity fact ("call me Sam", "I'm in Berlin") in conversation, it
is captured, carried into subsequent turns' context, and the user can correct or delete it; the
`user-extract` eval passes on the explicit cases.

### Phase 12 — User Model: learned beliefs ⭐
**Goal:** the companion continuously learns the user's preferences, interests, and opinions, brings
them to bear unprompted in conversation, **and acts on them** — refining them from how the user
reacts when it does.

**Scope**
- **Hybrid extraction, both paths widened to beliefs.** *Inline salient capture* expands from Tier-1
  identity to **explicit** Tier-2 beliefs ("I'm vegetarian", "I love jazz") — captured and usable the
  next turn, closing the Phase-11 leak that silently dropped non-identity statements. *Background
  reflection* (the **User-Model Reflector**) does the heavy lifting off-request: it reads the **raw
  transcript window** (the same window consolidation reads — un-lossy, where the implicit signal
  lives, not the filler-dropped episode summaries), deriving **implicit** beliefs no single message
  states ("keeps circling back to Rust → `interestedIn: Rust`"), with provenance (`learned_from_seq`),
  confidence, and salience. Its **own cursor** (`user_facts_through_seq`) makes it independently
  idempotent. Closed predicate set `TIER2_PREDICATES` = `prefers`/`dislikes`/`interestedIn`/`believes`,
  validated at extraction; polarity rides the predicate.
- **Write hygiene centralized in the reflector** (so it lives in one place): embedding **dedup** of
  restatements, and **current-state supersession** — when new evidence updates the *same matter*, the
  latest becomes the current row and the prior is retained as **superseded history**, not deleted.
  Last-wins for *now*; the timeline of the self lives in episodic memory + the superseded chain (it is
  **not** a contradiction — "loved coffee, then quit" are both true across time; `ontology.md` §4).
  Salience here is an **event-driven** strength weight (bumped on reinforcement); **time-decay and the
  stale-drop cutoff are Phase 13**.
- **Tier-2 retrieval arm** in `composeRetrieveContext`: hybrid (vector + FTS, RRF) over the *current*
  (non-superseded) Tier-2 `user_facts`, surfacing the top-K relevant beliefs per turn as a fenced
  block, composed ahead of the semantic arm so recency stays last (`architecture.md` §4.3). Adds
  `embedding`/`fts`/`salience` columns + HNSW/GIN indexes to `user_facts` (`implementation.md` §1).
- **Belief-learning loop — beliefs drive the will, and the will refines beliefs** (`architecture.md`
  §4.5, `companion-motivation.md` §7). The motivation engine's curiosity/interest drive **sources its
  candidate topics from the explicit Tier-2 belief set** instead of scraping episodes; a belief-driven
  burst records the originating belief (`proactive_outcomes.driven_by_user_fact_id`); and the existing
  change-in-mood reward, when the act was belief-driven, **also adjusts that belief's salience** —
  reinforced when the user appreciated it, weakened when it was unwelcome. Beliefs are thus learned from what
  the user *says* (reflection) **and** from how they *react to the companion acting on them*. *(Active
  probing for unknown interests is deferred.)*
- **Eval gate:** a **reflector eval** — seed a multi-turn window, run the reflector, judge (LLM-judge)
  that the implicit belief was derived and a same-matter newer state superseded rather than duplicated;
  plus a **deterministic DoD test** for the loop (a belief drives a burst → the report note carries the
  link → a positive reaction bumps the belief's salience, a flat one doesn't). `user-extract` also
  gains a few explicit-belief cases.

**Done when:** a preference the user expressed earlier resurfaces, unprompted and correctly, in a
later relevant turn; a same-matter newer state supersedes the prior current belief (history retained),
not duplicated; and the engine **acts on a learned interest on its own, with the user's reaction
refining that belief** — reinforced when appreciated, weakened when unwelcome.

**Implemented** (this branch): the Tier-2 learned-belief overlay on the existing `user_facts` table
(`embedding`/`fts` hybrid-recall columns + an event-driven `salience`). **Inline capture** widened
from Tier-1 identity to also grab **explicit** beliefs, embedded at capture. A background
**User-Model Reflector** — the mirror of the Personality Evolver, fired by the consolidation pass on
its **own cursor** (`user_facts_through_seq`) — reads the **raw transcript window**, infers **implicit**
beliefs, and reconciles each against the nearest current beliefs (`add`/`reinforce`/`supersede`;
current-state last-wins, history retained). A **Tier-2 retrieval arm** surfaces the relevant current
beliefs as a fenced "what I know about you" block, ahead of the semantic arm. The **belief-learning
loop** closes it: the motivation engine's curiosity sources its topics from the user's interest
beliefs and attributes a burst to the one it served (`proactive_outcomes.driven_by_user_fact_id`); the
existing change-in-mood reward then also moves that belief's salience — strengthened when welcomed,
weakened when unwelcome. Web shows the beliefs read-only in the memory browser. **Gate passed** (offline,
deterministic — like P3/P5, the differentiator is *mechanical*): the Phase 12 DoD test drives all three
Done-when criteria through the real app wiring (capture → resurface; reflector supersedes-not-duplicates;
belief drives a burst → a welcomed reaction raises its salience). The live `user-extract` eval gained
explicit-belief cases and a new `user-beliefs` reflector eval covers implicit inference + supersession.
Full suite green at ≥80% coverage. Canonical mechanism: `docs/companion-memory.md` §4.

### Phase 13 — User Model: understanding & hygiene
**Goal:** isolated facts become a coherent, current understanding the user fully controls.

**Scope**
- **Tier-3 user persona (additive).** A new `LlmUserPersonaSynthesizer` — the mirror of
  `LlmPersonalityEvolver` — synthesizes `companions.user_persona` ("who this person is to you") from the
  per-user `user_facts` + per-companion episodes, on its **own cursor** (`user_model_updated_through_seq`),
  re-synthesizing only when the facts/episodes advanced past it; it hangs off the consolidation pass right
  after the reflector, off-request and never throwing. **Additive blend:** the persona prompt keeps
  rendering Tier-1 identity facts **verbatim** (name/pronouns/location are exact ground truth, never
  paraphrased) and appends the Tier-3 narrative as a distinct paragraph beside `evolvedPersona` — no loop
  change (`architecture.md` §4.3).
- **Current-state overlay (drop the chain).** `user_facts` becomes "what's true now," not a timeline: the
  reflector's `supersede` becomes a **`replace`** (latest wins, old value gone), and the
  `superseded_at`/`superseded_by` columns + supersede-then-backfill machinery built in Phase 12 are
  **removed**. The self-timeline lives in **episodic memory** (lossless transcript + episodes), its proper
  home — `user_facts` no longer duplicates it (`ontology.md` §4).
- **Forgetting as the tail of decay (lazy).** One pure `effectiveSalience(salience, updatedAt, now) =
  salience × exp(−ln2 · age / halfLife)` (uniform configurable half-life) is applied in the **two** places
  Tier-2 salience is read — the retrieval arm (`searchBeliefs`) and the engine's `topInterestBelief`. No
  sweeper, no write churn. As a belief fades it is spoken more tentatively and below a `STALE_SALIENCE_FLOOR`
  stops surfacing — graceful, partial forgetting, like a person. **No tombstone:** a forgotten-then-restated
  belief is re-learned (natural self-correction, not a bug). Tier-1 identity has no salience, so it does not
  decay (below).
- **Uncertainty-aware recall + ask-when-unsure.** The Tier-2 arm renders each belief by its **confidence ×
  effective salience** — fresh/reinforced asserted, faded/low-confidence hedged — and the companion is
  **licensed to ask** to confirm when unsure; the answer reinforces or replaces (a conversational self-repair
  loop). No data is corrupted — "partial/wrong memory" is a *rendering* effect, not stored falsehood. (A
  heavier active conflict-detection engine is deferred.)
- **Sensitive attributes (write-gate).** A low-confidence inference about a closed `SENSITIVE_MATTERS` set
  (gender/age/health/religion/sexuality/ethnicity/political) is **not persisted**; an explicit user statement
  always passes; a persisted sensitive row carries a `sensitive` flag for the UI.
- **Management UI + the controls that matter.** **Edit** (replace a value) and **delete** (a single-row
  `deleteFact`, replacing the Phase-11 soft-supersede) cover the whole model — **necessary for Tier-1**
  (nothing else removes a stable identity fact), available on Tier-2 for immediacy (decay would otherwise get
  there). **Sensitive** rows get a **true purge** (and optionally forgetting the originating transcript turn)
  — the one place erasure must be complete. The Tier-3 persona is shown read-only (like `evolvedPersona`);
  sensitive rows are badged; a faded belief reads as faded.

**Done when:** the synthesized user-persona measurably shapes tone/framing (the **`user-persona`** judge
eval — persona-on vs persona-off A/B); a belief past its half-life fades from retrieval (and reads
tentatively before it goes); the user can inspect, **edit**, and **delete** anything the companion holds,
with sensitive data truly purged — proven by a deterministic DoD test (decay drops a stale belief from
recall; `deleteFact` removes a Tier-1 fact; a low-confidence sensitive inference is refused at write and an
explicit one is purgeable).

**Deferred (designed here, built later):** a user-facing "don't infer X about me" consent toggle; an active
conflict-detection engine (Phase 13 ships the cheap ask-when-unsure, not a contradiction scanner);
per-predicate decay rates (v1 is one uniform half-life).

**Implemented** (this branch): `user_facts` became a **current-state overlay** — the reflector's
`supersede` is now a **`replace`** and the Phase-12 superseded chain was dropped (the timeline lives in
episodic memory). Forgetting is the **tail of lazy decay**: one pure `effectiveSalience` view (uniform
half-life) in the Tier-2 arm + the engine's interest-sourcing fades an un-reinforced belief out of recall
on its own, and the arm renders by **certainty** (a faded/low-confidence belief reads `(uncertain)` and
invites the companion to confirm — conversational self-repair). Sensitive inferences are **gated at write**
(a closed `SENSITIVE_MATTERS` heuristic + a higher confidence bar; explicit statements pass, flagged). The
**Tier-3 `LlmUserPersonaSynthesizer`** (mirror of the Personality Evolver) re-synthesizes
`companions.user_persona` on its own cursor after the reflector, blended **additively** beside
`evolvedPersona`. The browser gained full **edit/delete** on Tier-1 *and* Tier-2, a `sensitive` badge, and
the read-only Tier-3 persona; the user's **`deleteFact`** is a true row delete (the sensitive purge). **Gate
passed** (offline, deterministic — like P3/P5): the Phase-13 DoD test proves decay fades a stale belief from
recall (row kept), `deleteFact` removes a fact via the API, and a low-confidence sensitive inference is
refused at write while an explicit one is flagged + purgeable; a live **`user-persona`** judge eval covers
the persona-shapes-tone claim. Full monorepo green at ≥80% coverage. Canonical mechanism:
`docs/companion-memory.md` §4.

## 4d. Greeting Workstream (arrival reaction)

The motivation engine (Phase 4) only ever expresses itself by **reading leads and posting a report
note** — it has no reaction to the user *arriving*. Phase 4 explicitly deferred "unprompted
conversation beyond the report note" to a later phase; this workstream builds the first slice of it:
the companion **notices the user return and reacts in context** — greeting, picking up an open
thread, or staying quiet. It is the first **`connection`-driven conversational move**, the social
counterpart to the curiosity-driven explore burst, and it **reuses the Phase 4 machinery** unchanged
(arbitration shape, the off/gentle/active dial, the change-as-reward loop). Like §4b/§4c the numbering
is a label, not a strict ordering; it extends the web surface and depends only on the PoC spine plus
the user model (Phases 11–13). Full design → `companion-greeting.md`.

### Phase 14 — Greeting / Arrival Reaction ✅ Done
**Goal:** when the user comes back to the chat, the companion knows they've arrived and reacts the way
a being would — a warm hello scaled to how long they've been gone and how well it knows them, picking
up whatever was left unfinished — or it rests, quietly, when there's nothing worth saying or it's out
of stamina.

**Scope** (full mechanism → `companion-greeting.md`)
- **Arrival detection from a durable `last_seen_at`.** A per-companion timestamp (`implementation.md`
  §1) updated on the **presence heartbeat** (which fires on mount even with no message), *not* the
  transcript (a silent visit leaves no turn) and *not* the volatile presence store (resets on
  restart). The gap is computed **before** the write; idempotency falls out (one genuine return ⇒ at
  most one greeting, no separate `last_greeted_at`) (`companion-greeting.md` §3).
- **The `decideGreeting` gate** — a token-free sibling to `decideMove`: first-meeting override →
  dial (`off` = reactive-only) → continuation floor → dial threshold (substance × gap) → stamina gate
  (`companion-greeting.md` §4).
- **Stamina-gated voicing, with a token-free exhausted fallback.** A greeting is interaction → billed
  to **stamina** (not energy); an empty wallet yields a fixed "I'm exhausted" line (no LLM call, shown
  once per arrival) that doubles as a feeding nudge (`companion-economy.md`).
- **Content = relationship depth × gap × open loops** (`companion-greeting.md` §5): depth from the
  user model (Phases 11–13); gap/clock set tone; the single most-relevant open loop (pending approval
  > unanswered question > away-work to share > settled ingestion) is picked up — voiced in-character,
  never templated.
- **First-meeting introduction** that fires even at `off` (the dial governs *ongoing* initiative): the
  companion introduces itself, sets honest expectations, and asks an opening question — bootstrapping
  the user-model pipeline (`companion-greeting.md` §6). **Locked default**; an "absolutely-literal
  `off`" override is a deployment choice owned here.
- **Async delivery with a `composing` contract** — the user always sees a typing indicator within a
  beat; preferred implementation is a server→client event stream that also subsumes the proactive-note
  poll (`companion-greeting.md` §7).
- **Reward-loop integration** — a greeting is a `proactive_outcomes` initiation, so the change-in-mood
  reward reinforces/decays the `connection` drive weight: cold greetings make the companion greet less
  and lighter, *learned* not hand-tuned (`companion-greeting.md` §8).

**Done when:** opening the chat after an absence produces, with no user prompt, an in-character
greeting scaled to the gap and relationship depth that picks up an open loop when one exists; a
brand-new companion introduces itself on first open (even at `off`); a brief tab-away or an `off` dial
produces silence; an exhausted companion shows the fixed fallback (once) instead of a voiced greeting;
the same return never double-greets; and the user sees a `composing` indicator before the greeting
streams.

**Key risk:** neediness (the failure mode greetings exist to avoid). Gated behind the dial + the
continuation floor + the substance threshold, and self-corrected by the change-as-reward loop measured
from day one (the same signal that governs the explore burst). The voiced *quality* (right depth, no
faked familiarity, one loop not a list) is the softer risk — validate with a greeting eval (judge the
brief→greeting on depth-appropriateness and loop selection) alongside the deterministic gate test.

**Deferred (designed here, built later):** richer **arrival reactions** beyond a greeting (surfacing a
proposal / reporting away-work as the *primary* act); **departure/farewell** reactions (the falling
edge); **proactive mid-absence outreach** (push — Phase 6, needs an audience); **cross-room arrival**
(greeting on a different surface than the user left from). Full list → `companion-greeting.md` §10.

**Implemented** (this branch): the durable per-companion `last_seen_at` column (nullable — NULL = a
first meeting; `implementation.md` §1) backs a token-free **`decideGreeting`** gate (the sibling of
`decideMove`: first-meeting override → `off` → continuation floor → dial threshold over gap × open
loop) and a **`GreetingService`** that voices ONE in-character greeting billed to **STAMINA** (a
greeting is interaction, not solo work) — or shows the fixed token-free **exhausted line** when stamina
is gone — and records a **`bond`** proactive outcome so the change-as-reward loop learns to greet less
when greetings land cold. The open loop is the single most relevant of a pending approval (P3) or an
unanswered question the companion left; depth comes from the user model. A new SSE endpoint
**`POST /companions/:id/greeting`** streams a **`composing`** cue then the greeting as `done`; the web
client opens it on **mount and on tab-return**, shows a typing indicator, and appends the greeting —
and the arrival clock is stamped **after** the gap is read so an idle return never re-greets. The gate
also won't stack a greeting on an outcome still awaiting a reaction. (Mechanism →
`companion-greeting.md`; schema → `implementation.md` §1.) **Gate passed** (offline, deterministic —
like P3/P5, the differentiator is *mechanical*): the Phase 14 DoD test proves first-meeting introduces
itself even at `off`; a real-gap return greets, spends stamina (not energy), records a `bond` outcome,
and stamps the clock; a brief tab-away and an `off` dial stay silent; an exhausted companion shows the
fixed line with no outcome; and a greeting never stacks on a pending note. The `decideGreeting` gate is
exhaustively unit-tested; the full monorepo is green at ≥80% coverage.

## 4e. Realtime Delivery Workstream (standing event channel)

Through Phase 14, the surface receives backend-produced messages two ways, both with seams: the
**per-turn SSE** lives only for the turn that opened it and is **owned by the chat component** — so
in-app navigation (open Memory, come back) tears it down and the streamed reply lands nowhere; and a
genuinely backend-initiated message (an ingestion note, a greeting) reaches an open chat only by
**polling** (the ingestion-status poll drives a transcript refresh). The visible bug: send a message,
navigate away and back before it persists, and the reply never appears until a manual refresh.

This workstream adds a **standing per-companion push channel** so every appended transcript row
reaches any open surface the moment it persists, and a surface re-established after navigation is
immediately current. It is the substrate the proactive product needs anyway (backend-initiated
messages become first-class push, not a poll). Like §4b–§4d the numbering is a label, not a strict
ordering; it extends the web surface and depends only on the PoC spine. Full mechanism →
`architecture.md` §6 + `implementation.md` §2.4.

### Phase 15 — Standing Companion Event Channel ✅ Done
**Goal:** new messages — turn replies, ingestion notes, greetings, proactive nudges — reach an open
client by **push** the instant they persist; opening, navigating away, reconnecting, or running a
second tab always converges on the durable transcript without a manual refresh.

**Scope** (full mechanism → `architecture.md` §6, `implementation.md` §2.4)
- **Publish on append.** A `PublishingMemoryStore` decorator over the one `appendMessage` chokepoint
  emits each appended row to an in-process **Companion Event Bus** — every persistence path (turn,
  greeting, announcer, upload) publishes with no call-site change.
- **Standing SSE route.** `GET /companions/:id/events` streams the bus to a surface; heartbeat-kept,
  close-cleaned (unsubscribe on disconnect). Open-ended `streamChannel`, distinct from the finite
  per-turn `streamSse`.
- **Subscribe-then-snapshot establishment.** The client opens the channel **first**, then snapshots
  the transcript, and **merges by message id** — closing the navigation/reconnect race (a reply that
  persists after the snapshot still arrives live). Reconnect with backoff + snapshot-per-reconnect;
  no server-side replay (deferred).
- **Reconciliation by id.** The per-turn stream, the snapshot, and the channel can all deliver the
  same row; the client dedupes by id and replaces id-less optimistic lines with their authoritative
  event. The ingestion-status-poll *delivery* path is superseded (the poll remains only for the
  reading-progress UI).

**Done when:** a message appended by any path appears in an already-open chat with no refetch trigger;
navigating to Memory and back surfaces a reply that persisted while away, with no manual refresh and
no duplicate; a dropped channel reconnects and re-syncs; and a second open tab stays current. Full
monorepo green at ≥80% coverage.

**Key risk:** standing-connection lifecycle — leaked bus subscriptions / sockets if close-cleanup or
the heartbeat is wrong (the main new infra), and the optimistic-line reconciliation (dedup of the
user's own just-sent messages). Both isolated behind tested units (the bus, the `mergeMessage`
reducer).

**Deferred (designed here, built later):** `Last-Event-ID` server-side **replay** (snapshot-on-reconnect
covers gaps for now); **multi-replica fan-out** (the bus interface swaps to Postgres `LISTEN/NOTIFY`
when running >1 instance, `architecture.md` §9); routing the **turn itself** over the channel for live
token-streaming continuity *while* on another view (this phase recovers the final message on return,
not the live typing); **WebSockets** (SSE fits — server→client push, client→server stays POSTs).

**Implemented** (PR #16): the standing per-companion push channel end-to-end. A
**`PublishingMemoryStore`** decorator wraps the one `appendMessage` chokepoint at the composition root
and publishes every appended row to an in-process **`InProcessCompanionEventBus`** (best-effort,
try/catch, logged at `error`, never failing the append) — so every persistence path (turn reply,
greeting, ingestion announcer, upload) emits with no call-site change. The standing
**`GET /companions/:id/events`** route (`requireAuth` + ownership) opens an open-ended `streamChannel`
(distinct from the finite per-turn `streamSse`) that subscribes to the bus, writes each row as
`{ type: 'message', message }`, heartbeats with `: ping`, and unsubscribes on disconnect. The web
client does **subscribe-then-snapshot** establishment — opens the channel first, snapshots the
transcript, and **merges by message id** (the `mergeMessage` reducer dedupes the per-turn stream,
snapshot, and channel, and replaces id-less optimistic lines with their authoritative event) — closing
the navigate-away-and-back race; it reconnects with backoff + snapshot-per-reconnect. The poll-based
note-delivery path was retired (the ingestion poll now drives only the reading-progress UI). (Mechanism
→ `architecture.md` §6; impl → `implementation.md` §2.4.) **Gate passed** (offline, deterministic — the
differentiator is *mechanical*: convergence without a refetch trigger): the bus and the `mergeMessage`
reducer are unit-tested (subscription lifecycle, close-cleanup, id dedup, optimistic-line
reconciliation), and the event route + publishing store have integration coverage. Full monorepo green
at ≥80% coverage.

## 5. Open Questions to Resolve (owned here)
Owned here (single-source). Each is assigned a decision point:

| Question | Decide by |
|---|---|
| ~~Final stack: framework, client, store engine, LLM provider~~ | **Decided (Phase 0):** see `architecture.md` §5 (canonical stack) |
| Single companion vs. multiple per user | Phase 2 (identity model) — **MVP: one companion per user**; multiple is a deferred capability |
| ~~One continuous conversation vs. multiple sessions per companion~~ | **Decided (Phase 0): one continuous, lifelong conversation per companion** — no session/thread entity (`architecture.md` §2, invariant #6) |
| Initial tool/skill integrations (maps, calendar, search, booking) | Phase 3 |
| Long-term memory retention vs. summarization over time | Phase 2, revisited Phase 8 |
| Surface rollout confirmed (web → mobile → desktop) | Phase 5 decision gate |
| Monetization model (subscription, ability packs) | Phase 8 |
| Push-notification cadence & away-proactivity rules | Phase 6 |
| ~~Tool whitelist governance — where the CLI/MCP whitelist lives (config vs DB) and the operator flow to admit a tool~~ | **Decided (Phases 9–10):** both whitelists live in deployment config (not the DB), admit-by-deploy, no per-call approval. Trust model + the exact config surface → `companion-tools.md` §6 |
| User-addable tools (vs developer-whitelisted only) | Deferred — after the tool-acquisition workstream (`companion-tools.md` §9) |
| External-tool cost metering (the monetary cost of CLI/MCP calls, beyond LLM tokens) | Deferred — revisit with the workstream / Phase 8 |
| ~~User-model ownership: `user_facts` keyed by `companion_id` vs `user_id`~~ | **Decided (§4c): `user_id` (per-user).** Facts are objective truths about the person, shared across the user's companions; learned *by* a companion (`learned_by_companion_id`, nulls on delete). Only the Tier-3 synthesized persona is per-companion. The name is one such per-user fact (no `display_name` column) |

## 6. Out of Scope (this plan)
- Internal implementation detail and data schemas → `architecture.md`,
  `implementation.md`.
- The ontology contract for structured knowledge → `ontology.md`.
- Native surfaces before the web PoC decision gate (Phase 5).
