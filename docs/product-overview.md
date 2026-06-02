# CobbleCompanion — Product Overview

> Canonical product description. Priorities/roadmap live in `docs/development-plan.md`;
> technical architecture in `docs/architecture.md`. Each fact lives in exactly one place.

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

It runs as a **mobile app** (where location and always-with-you presence matter most) and a
**web app** (for richer sessions and faster product iteration). Memory and knowledge sync to
the cloud so your companion is continuous across devices.

## 2. Why It's Different

Most products sit on one side of a line. CobbleCompanion deliberately crosses it.

| | Companion apps (e.g. Tolan) | Agent tools (e.g. Claude Code, OpenClaw) | **CobbleCompanion** |
|---|---|---|---|
| Bond & personality | ✅ | ❌ | ✅ |
| Deep personal knowledge base | ❌ | partial / per-session | ✅ **lifelong, organized** |
| Uses tools / acts in the world | ❌ | ✅ | ✅ |
| **Initiative** | reactive chat | **passive** (waits for you) | ✅ **proactive** (has motivations) |

The two defining differentiators:

1. **A knowledge organism, not a chatbot.** You can hand it your books, PDFs, notes, and
   interests. It reads them, organizes them into long-term memory, and recalls the right thing
   at the right moment — including by *where you are* and *what you're doing*.
2. **Proactivity.** When you have no question and no task, it doesn't go silent. Driven by its
   own motivations, it brings you discoveries, checks in on your goals, surfaces timely
   opportunities, and asks you questions to learn more — like a curious, caring partner.

## 3. The Hero Experience

Cobble is a domain-agnostic companion; it becomes good at whatever its master needs. One
illustrative journey:

> You're going to Peru in July. You hand Cobble the PDFs you bought about Peruvian history,
> food, and culture and ask it to read them. It ingests and organizes that knowledge into
> long-term memory. In the weeks before the trip it proactively shares things it found
> fascinating and asks what you most want to experience — shaping an itinerary with you. In
> Lima, based on your GPS location, it tells you the story of the plaza you're standing in and
> recommends a dish nearby that matches your tastes. When you say "find us a hotel in Cusco for
> Friday," it researches options, then **proposes** a shortlist and waits for your one-tap
> approval before booking.

The same companion, fed different things and connected to different tools, becomes a habit
coach, a study partner, a research curator, or a day-to-day life assistant — **without being
assigned a role**. It adapts to its master.

## 4. Core Capabilities

### 4.1 Learning & Knowledge
- **Ingest your sources:** PDFs, books, notes, links, conversations — read, understood, and
  stored in durable long-term memory.
- **Organized knowledge base:** facts and concepts are structured (not just a transcript) so
  recall is fast, accurate, and connected across topics.
- **Contextual recall:** surfaces the right knowledge by topic, time, and **location** (GPS).
- **Self-expansion:** with permission, crawls the web to deepen domains you care about — one
  example of its broader tool use.

### 4.2 Tools, Skills & Action
- **General tool/skill/MCP use:** like a modern coding agent, Cobble can wield tools and
  connect to external services (maps, calendar, search, booking, email, and MCP servers).
  Web-crawling is just one such tool.
- **Acts, doesn't just answer:** it can carry out multi-step tasks (research → plan → execute),
  e.g. find a hotel, book a ticket, set a reminder.
- **Propose → approve trust model:** anything with cost, commitment, or external side-effects
  is **proposed** and held in an approval queue for your one-tap confirmation. Trust is earned,
  never assumed.

### 4.3 Proactivity (the heart of the product)
Cobble has **motivations** and acts on them when you're idle or away. Its initiative is driven by:
- **Your goals & well-being** — advances and checks in on what you care about.
- **Its own curiosity & learning** — explores and brings back relevant discoveries.
- **Maintaining the bond** — remembers shared history, checks in, asks about your day.
- **Pending work & opportunities** — unfinished tasks and time-sensitive openings (a price
  drop, a deadline).

**Outreach model:** rich, conversational proactivity when you're **present** (app open); and
**sparing, high-value push notifications** when you're away (e.g. you've arrived somewhere new,
or an opportunity is expiring). Frequency is **tunable** so it feels alive, not annoying.

### 4.4 The Bond & Growth
You don't just use Cobble — you raise it. It grows visibly along four axes:
- **Knowledge = growth:** it levels up as its knowledge base and recall expand.
- **Relationship & personality:** seeded at creation (name, form, temperament), its character
  deepens through your shared history, in-jokes, and accumulated understanding of you.
- **Unlockable abilities:** new skills, tools, and integrations open up as you engage.
- **Visual / character evolution:** the character itself evolves (appearance, home,
  accessories) as a tangible sign of how far you've come together.

## 5. Who It's For
Anyone who wants a single, trusted companion that *knows them and their world* and *acts for
them* — travelers, lifelong learners, people pursuing goals and habits, and anyone who wants
the warmth of a companion with the capability of an agent. It is **general-purpose by design**:
it fits whatever domain its master brings to it.

## 6. Privacy & Data Posture
CobbleCompanion is **cloud-synced and convenience-first**: memory and knowledge sync across
devices for continuity and richer processing, protected by account controls and
encryption in transit and at rest. Because it holds deeply personal data (your sources, your
preferences, your location history), the product treats trust as a core feature — the
propose→approve model for actions is part of that contract, and users can manage and delete
what their companion holds. (Detailed data model and threat model: `docs/architecture.md`.)

## 7. Non-Goals (for now)
- **Not a role-play or character-fiction app** — Cobble is a real personal companion, not a
  scripted persona.
- **Not a fleet of assigned job-bots** — one companion that adapts, not configured role templates.
- **Not fully autonomous** — high-stakes/cost actions always route through your approval.

## 8. Open Questions (to resolve in `docs/development-plan.md`)
- Single companion vs. allowing multiple companions per user (current design assumes one
  primary companion you bond with).
- Monetization model (subscription, ability packs, etc.).
- Which initial tool/skill integrations ship first (maps, calendar, search, booking).
- How far long-term memory retains vs. summarizes over years.
