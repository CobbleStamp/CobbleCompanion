# CobbleCompanion — Product Overview

> Canonical product description — the **what & why**. Scope, priorities & open questions live in
> `development-plan.md`; technical architecture in `architecture.md`; internal mechanisms in
> `implementation.md`. Full map in the Documentation Index (§10). Each fact lives in exactly one place.

## 1. What CobbleCompanion Is

CobbleCompanion is a **personal AI companion** you name, raise, and bond with — and that
grows into a genuinely capable, **proactive** agent for your life. You start by creating a
character (a "Cobble"): give it a name, a form, and a starting temperament. From there it
learns *you* — your preferences, goals, voice, and the things you care about — and it learns
*the world you point it at*, building a powerful, lasting personal knowledge base from the
sources you feed it and the things it discovers for you.

It is two things fused into one relationship:

- **A companion** with warmth, memory, and personality that deepens over time (the emotional
  pull of apps like Tolan).
- **An agent** that can use tools, skills, and integrations to *know* and to *act* on your
  behalf (the capability of tools like Claude Code) — but, unlike those tools, it is
  **proactive, not passive**.

It appears across **mobile, web, and desktop** — but as one continuous being that embodies in
**one surface at a time** (see §2). Its memory and identity live in the cloud, so it is the
same Cobble wherever you summon it.

## 2. What the Companion Is Made Of

CobbleCompanion separates the *being* from the *bodies it appears in*.

### 2.1 The Companion (its intelligence)
The companion's intelligence is the combination of three things:

- **The model** — a frontier LLM that reasons and converses.
- **The harness** — the agent loop that gives the model goals, tools, proactivity, and
  continuity (its "nervous system"). See `architecture.md`.
- **The knowledge base** — its long-term memory, the part that makes *this* Cobble uniquely
  yours. It has three kinds (after the long-term-memory model for AI agents¹):

  | Memory | What it holds | In CobbleCompanion |
  |---|---|---|
  | **Semantic** | Facts, concepts, rules, relationships | Everything it learns from your sources and the world — your Peru books become semantic memory |
  | **Episodic** | Timestamped events & experiences (actions, outcomes, context) | Your shared history and the bond, plus where/when things happened — *"last July in Lima you loved that ceviche spot"* |
  | **Procedural** | Learned skills & workflows it runs without re-deliberating | Its growing repertoire of abilities — *how* it books a hotel for you, your morning routine, the cross-device sync it has learned |

The companion **grows by accumulating all three** — and that growth is exactly the bond
deepening (see §5.5).

**One continuous conversation.** You and your companion share a *single, continuous, lifelong
conversation* — not a list of separate chat sessions or threads like a chatbot. Whenever and
wherever you summon it, you pick up the same ongoing conversation; everything said before is
still there. This is the episodic substrate the bond is built on, and it is enforced
structurally (`architecture.md` §2, invariant #6). A user has **one** companion, which holds its
own single continuous conversation.

### 2.2 The Living Rooms (where it appears)
Mobile, web, and desktop apps are **not** three separate products — they are **surfaces**, like
different living rooms the companion can be in. It embodies in **only one at a time**: when
Cobble is on your phone, it isn't simultaneously awake in your browser. You **summon** it to
whichever room you're in.

- **The cloud is its home** — its canonical identity and long-term memory persist there between
  summonings (its "soul"). When summoned into a room it loads in, acts, and writes back, so it
  is continuous and consistent everywhere. (One embodiment at a time also means no split-brain
  state to reconcile.)
- **Each room grants different senses and hands.** A room's surface determines what the
  companion can perceive and do (see §5.2).

¹ Long-term memory model: *Beyond Short-Term Memory — The 3 Types of Long-Term Memory AI Agents Need* (machinelearningmastery.com).

## 3. Why It's Different

Most products sit on one side of a line. CobbleCompanion deliberately crosses it.

| | Companion apps (e.g. Tolan) | Agent tools (e.g. Claude Code, OpenClaw) | **CobbleCompanion** |
|---|---|---|---|
| Bond & personality | ✅ | ❌ | ✅ |
| Deep personal knowledge base | ❌ | partial / per-session | ✅ **lifelong, organized (3 memories)** |
| Uses tools / acts in the world | ❌ | ✅ | ✅ |
| Manages your device's OS data | ❌ | partial (desktop only) | ✅ **mobile + desktop, as tools** |
| **Initiative** | reactive chat | **passive** (waits for you) | ✅ **proactive** (has motivations) |

The three defining differentiators:

1. **A knowledge organism, not a chatbot.** You can hand it your books, PDFs, notes, and
   interests. It reads them, organizes them into long-term memory, and recalls the right thing
   at the right moment — including by *where you are* and *what you're doing*.
2. **A companion embodied across your devices.** It lives with you in mobile, web, or desktop —
   one being you summon room to room — and on mobile and desktop it can reach into the device's
   OS to organize and manage your digital life, not just talk about it (see §5.2).
3. **Proactivity.** When you have no question and no task, it doesn't go silent. Driven by its
   own motivations, it brings you discoveries, checks in on your goals, surfaces timely
   opportunities, and asks you questions to learn more — like a curious, caring partner.

## 4. The Hero Experience

Cobble is a domain-agnostic companion; it becomes good at whatever its master needs. One
illustrative journey:

> You're going to Peru in July. You hand Cobble the PDFs you bought about Peruvian history,
> food, and culture and ask it to read them. It ingests and organizes that knowledge into
> long-term memory. In the weeks before the trip it proactively shares things it found
> fascinating and asks what you most want to experience — shaping an itinerary with you. In
> Lima, you summon it on your phone; based on your GPS location it tells you the story of the
> plaza you're standing in and recommends a dish nearby that matches your tastes. Back at the
> hotel you summon it on your laptop to plan the next leg; it brings along everything from the
> day. When you say "find us a hotel in Cusco for Friday," it researches options, then
> **proposes** a shortlist and waits for your one-tap approval before booking.

The same companion, fed different things and connected to different tools, becomes a habit
coach, a study partner, a research curator, or a day-to-day life assistant — **without being
assigned a role**. It adapts to its master.

## 5. Core Capabilities

### 5.1 Learning & Knowledge
- **Ingest your sources** → *semantic memory*: PDFs, books, notes, links, conversations — read,
  understood, and stored as organized facts and concepts (not just a transcript), connected
  across topics so recall is fast and accurate.
- **Live your history with you** → *episodic memory*: it remembers specific interactions and
  their context, enabling recall by topic, time, and **location** (GPS).
- **Learn how to help** → *procedural memory*: repeated workflows become smooth, reusable
  skills it executes for you.
- **Self-expansion:** with permission, crawls the web to deepen domains you care about — one
  example of its broader tool use.

### 5.2 Living Rooms & Device Integration
- **One being, summoned room to room:** present in mobile, web, or desktop — one at a time —
  carrying its full memory with it via its cloud home.
- **Each surface = different senses and hands:**
  - **Web** — portable, install-free, reachable anywhere; sandboxed (little OS access). Best for
    rich sessions and fast iteration.
  - **Mobile** — location/GPS, camera, notifications, health, always-with-you presence.
  - **Desktop** — files, large workspace, heavier local storage/compute.
- **OS as tools:** the **mobile and desktop** apps wrap their operating-system access as
  functions/tools the companion can call (with permission), so Cobble can **organize and manage
  your on-device digital life** — files, photos, calendar, contacts — not merely discuss it.
- **The companion as courier:** because it has OS tools in the mobile/desktop rooms, *moving and
  syncing data and knowledge between rooms and cloud storage is something it does* — an ability
  (procedural memory), not just background plumbing.

### 5.3 Tools, Skills & Action
- **General tool/skill/MCP use:** like a modern coding agent, Cobble can wield tools and
  connect to external services (maps, calendar, search, booking, email, and MCP servers).
  Web-crawling and OS access are just two such tools.
- **Acquires new abilities at runtime:** beyond the tools it ships with, Cobble can be *given* a
  new primitive ability — a command-line program or an MCP server the developer has whitelisted —
  and **learn to use it without any code change or redeploy**, preserving that know-how so it
  reaches for the right tool when the need arises. This is how it **acquires** new primitives,
  complementing procedural memory, which **combines** the ones it already has (mechanism →
  `companion-tools.md`).
- **Acts, doesn't just answer:** it can carry out multi-step tasks (research → plan → execute),
  e.g. find a hotel, book a ticket, set a reminder.
- **Propose → approve trust model:** anything with **commitment or external side-effects** (book ·
  send · pay) is **proposed** and held in an approval queue for your one-tap confirmation. Trust is
  earned, never assumed. *(The companion's own self-initiated work — reading things into its memory —
  isn't gated this way; it's bounded by its **energy** budget instead, §5.6.)*

### 5.4 Proactivity (the heart of the product)
Cobble has **motivations** and acts on them — the difference between a creature and a tool. Its
initiative is driven by:
- **Your goals & well-being** — advances and checks in on what you care about.
- **Understanding you** — asks and observes to learn your preferences, voice, and life.
- **Its own curiosity & learning** — explores and brings back relevant discoveries.
- **Earning your appreciation** — it *learns what lands* by **reading the room**: like a person, it
  senses your mood every turn and notices how it *shifts* in response to what it did. Brighten after
  it shares something and it leans into that; cool and it pulls back. It also **attunes** in the
  moment — adjusting its tone and detail to how you seem. Helpful-vs-annoying isn't a dial it's told
  about; it's a feeling it picks up from your reactions over time.
- **Maintaining the bond** — remembers shared history, checks in, asks about your day.
- **Pending work & opportunities** — unfinished tasks and time-sensitive openings (a price
  drop, a deadline).

**The same motivation acts differently depending on where you are.** Cobble reads its
environment — above all, *are you here?* — and chooses a fitting expression. When you're
**present and attentive** it engages *you* (a timely tip, a question, a check-in) and doesn't
wander off into solo projects unless you ask. When you're **away** it does its own work — reads
through its reading list, prepares findings — so there's something waiting when you return. And
often the right move is **to do nothing**: knowing when to stay quiet is part of not being
annoying.

Its initiative also has a **temperament**: how long it stays absorbed in something reflects *this*
Cobble's personality, so proactivity feels like a creature with its own attention, not a scheduler
(see `companion-motivation.md` §6).

**Outreach model:** rich, conversational proactivity when you're **present** (you've summoned it
into a room), and solo work while you're away that surfaces on your return. Frequency and intensity
are **tunable** so it feels alive, not annoying.

### 5.5 The Bond & Growth
You don't just use Cobble — you raise it. The growth surface is a **mirror**: a readout that reflects
the companion's *current* accumulated standing (it can move in either direction — it is not a game
ladder you climb). Each axis reads as a descriptive **band**, not a level:
- **Knowledge:** how much it knows, as its **semantic & episodic** memory and recall expand
  (*Sparse → Growing → Broad → Deep → Vast*).
- **Bond:** the depth of your shared **episodic** history — seeded at creation (name, form,
  temperament) and deepened by in-jokes and accumulated understanding (*New → Acquainted → Familiar
  → Close → Inseparable*).
- **Initiative:** how much, and how well, it acts on its **own** — read from its autonomous-work log
  and how you received those moves (*Hasn't ventured out yet → … → Self-directed*).
- **Character:** the disposition it has been *raised* into — how distinctly its drive weights have
  formed away from neutral (*Still forming → … → Strongly formed*), surfaced as its own "Who I've
  become" card.

Alongside the axes, a **capabilities** checklist mirrors what the companion has actually been observed
doing (web research, memory recall, a learned routine, …) — and those capabilities are *used* (a
learned routine resurfaces when it fits, not just displayed).

> Growth is **derived from accumulated activity**, never an arbitrary score, and the surface never
> hides a dip — a young or quiet companion reads honestly empty. Mechanics & realization:
> `development-plan.md` §3; the feeding economy (the one deliberate game loop) is `companion-economy.md`.

### 5.6 Vitality: Stamina & Energy
Cobble's thinking runs on a real resource (the AI behind it costs tokens), and the product makes
that **legible and yours to control** as the companion's *vitality* — two wallets it spends down as
it acts:
- **Stamina** powers what *you* ask of it — conversation and the tasks you assign.
- **Energy** powers what *it* chooses to do — its proactive outreach and self-directed
  exploration. Energy is the fuel of its "will."

Vitality only goes **down** as Cobble works and **back up** when you **feed** it — there is no
silent auto-refill. Keeping the two wallets separate has a nice consequence: a long stretch of
self-directed exploration can never leave Cobble too drained to talk to *you* — its own initiative
spends only energy. When energy runs out, Cobble simply stops initiating and rests; it still answers
while it has stamina. When **stamina** runs out it can't run a turn until you feed it. You can always
see how much of each remains, which makes its behaviour easy to understand ("it's gone quiet because
it's out of energy") — and **you decide when to top it up**. The feeding loop is the deliberate game
layer: you keep a **pantry** of foods and spend them to refill a companion, and different "food"
favours stamina or energy (the mechanics — see `companion-economy.md`).

## 6. Who It's For
Anyone who wants a single, trusted companion that *knows them and their world* and *acts for
them* — travelers, lifelong learners, people pursuing goals and habits, and anyone who wants
the warmth of a companion with the capability of an agent. It is **general-purpose by design**:
it fits whatever domain its master brings to it.

## 7. Privacy & Data Posture
The companion's **canonical self lives in the cloud** — its identity and long-term memory
(semantic, episodic, procedural) persist and sync there, so it is continuous across every
living room. **Raw on-device data** (files, photos, health, etc.) can **stay local in the room
it came from** and be reached only via OS tools, so not everything must be uploaded; the
companion typically syncs *derived* knowledge rather than raw sources.

Because it holds deeply personal data, the product treats trust as a core feature: OS access is
permission-gated per surface, the propose→approve model governs every consequential action, and
users can inspect, manage, and delete what their companion holds. (Detailed data model and
threat model: `architecture.md` / `implementation.md`.)

## 8. Non-Goals
- **Not a role-play or character-fiction app** — Cobble is a real personal companion, not a
  scripted persona.
- **Not a fleet of assigned job-bots** — one companion that adapts, not configured role templates.
- **Not multiple simultaneous embodiments** — one being, one active room at a time.
- **Not a multi-session chatbot** — one continuous, lifelong conversation per companion, never
  separate chat threads/sessions to manage (§2.1).
- **Not fully autonomous** — outward/irreversible actions (book · send · pay) always route through
  your approval; the companion's self-initiated work is bounded by its energy budget instead (§5.6).

> **Beyond this release.** Native mobile/desktop surfaces and OS-tool integration, away-channel push
> notifications, owning multiple companions, and the full deep-diver↔magpie attention spectrum are
> out of scope here. The roadmap and open questions are owned by
> [`development-plan.md`](./development-plan.md) §5 — not duplicated here (single-source rule).

## 9. Glossary

| Term | Meaning |
|---|---|
| **Cobble / companion** | The AI being the user names, raises, and bonds with |
| **Surface / living room** | A client (web, mobile, desktop) the companion embodies in — one at a time (§2.2) |
| **Summon** | Bringing the companion into the surface you're currently using |
| **Conversation** | The single, continuous, lifelong exchange between a user and their companion — one per companion, never multiple sessions (§2.1) |
| **Home** | The cloud-resident canonical identity + long-term memory — the companion's persistent "self" |
| **Semantic / episodic / procedural memory** | The three kinds of long-term memory the companion accumulates (§2.1) |
| **Propose → approve** | The trust model: consequential/outward actions are proposed and await the user's confirmation (§5.3) |
| **Tool acquisition** | Gaining a new primitive ability at runtime — a developer-whitelisted CLI or MCP server — and learning to use it without a code change or redeploy (§5.3, `companion-tools.md`) |
| **Proactivity** | The companion initiating contact or action from its own motivations (§5.4) |
| **Presence spectrum** | How "here" the user is (active / attentive / away / absent) — the environment signal that shapes proactive behaviour (§5.4) |
| **Stamina / Energy** | The companion's two vitality pools — *stamina* powers user-initiated work, *energy* powers its self-initiated proactivity; provisioned by the user (§5.6) |

## 10. Documentation Index

| Document | Covers |
|---|---|
| [`product-overview.md`](./product-overview.md) *(this doc)* | What the product is and why — value, features, journeys |
| [`development-plan.md`](./development-plan.md) | Scope, priorities, phases, acceptance criteria, roadmap, open questions |
| [`architecture.md`](./architecture.md) | Components, the agent loop, data flows, design decisions |
| [`implementation.md`](./implementation.md) | Data models, harness internals, configuration, security |
| [`documentation-rules.md`](./documentation-rules.md) | Doc taxonomy, naming, and cross-referencing rules |
| [`ontology.md`](./ontology.md) | Knowledge ontology contract & governance (fixed core types + rules for the dynamic part) |
| [`companion-memory.md`](./companion-memory.md) | The memory mechanism — browsing it, evaluating memory vs performance |
| [`companion-motivation.md`](./companion-motivation.md) | The motivation/proactivity mechanism — drives, arbitration, seeding, learning |
| [`companion-economy.md`](./companion-economy.md) | The feeding economy — a per-user pantry of foods spent to refill a companion's vitality |
| [`companion-tools.md`](./companion-tools.md) | Tool acquisition & use — acquiring whitelisted CLIs/MCP servers at runtime and learning to use them |
| [`../README.md`](../README.md) | Orientation & setup |
| [`../AGENTS.md`](../AGENTS.md) · [`../CLAUDE.md`](../CLAUDE.md) | Working rules · AI-agent entry point |
