# Companion Memory — How It Works, How to Browse It, How to Evaluate It

This guide explains the companion's memory mechanism end-to-end and points to the
two tools for working with it: the **read-only memory browser** and the
**memory-vs-performance evaluation harness**.

It is a guide, not a source of record. Canonical facts live elsewhere and are
linked here, never copied:

- **Vision & the three memory types** → [`product-overview.md`](./product-overview.md) §2.1, §7
- **Architectural seams** (MemoryStore boundary, the agent loop) → [`architecture.md`](./architecture.md) §2, §4.3
- **Data model & hook signatures** → [`implementation.md`](./implementation.md) §1, §2.1
- **Rollout & acceptance criteria** → [`development-plan.md`](./development-plan.md) §3

---

## 1. The mental model

The companion's knowledge base is **three long-term memories** (see
[`product-overview.md`](./product-overview.md) §2.1):

| Memory         | Holds                                            | Example                                    |
| -------------- | ------------------------------------------------ | ------------------------------------------ |
| **Semantic**   | Facts, concepts, relationships from sources      | What it learned from your Peru books       |
| **Episodic**   | Timestamped experiences and shared history       | "Last July in Lima you loved that ceviche" |
| **Procedural** | Learned skills/workflows run without re-deciding | How it books a hotel                       |

The companion _grows_ by accumulating all three — that growth is the bond
deepening. Anything with cost or side-effects is **proposed** and held in an
approval queue for confirmation, not executed silently.

## 2. How memory is wired

All memory is reached through one seam — the **`MemoryStore` boundary**
([`architecture.md`](./architecture.md) §2, invariant #2). New memory kinds are
added as new implementations behind this interface, never as caller changes.
Memory enters a turn through one place — the `RetrieveContext` hook:

```mermaid
flowchart LR
    SRC["Sources<br/>(file / note / link)"] -->|"two-pass ingestion<br/>(architecture.md §4.8)"| SEM
    subgraph seam["Behind the MemoryStore seam"]
        TX["Transcript store<br/>(episodic substrate)"]
        SEM["Semantic store<br/>(sections + fact overlay)"]
        EP["Episodic store<br/>(consolidated episodes)"]
        PROC["Procedural memory<br/>(learned workflows)"]
        USR["User Model<br/>(user_facts + user persona)"]
    end
    seam -->|"RetrieveContext hook"| CTX["Assembled turn context"]
    CTX --> H["Harness / agent loop"]
```

- Transcript store: `packages/core/src/memory/store.ts`; semantic store:
  `packages/core/src/memory/semantic-store.ts`
- The harness pulls prior context through the **`RetrieveContext` hook** — the
  single place memory enters a turn: `packages/core/src/harness/hooks.ts`,
  assembled in `packages/core/src/harness/context.ts`
  (signatures documented in [`implementation.md`](./implementation.md) §2.1).

This is the extension point: `RetrieveContext` is filled with **semantic recall**
(`packages/core/src/harness/semantic-retrieve.ts` — embed the question, hybrid-search
sections, ground the prompt in verbatim passages with citations), and with **episodic
recall** the same way, **without touching the loop**. How sources become semantic
memory (the two-pass ingestion flow): [`architecture.md`](./architecture.md) §4.8;
the fact overlay's contract: [`ontology.md`](./ontology.md).

## 3. What the memory system holds

The companion holds all three long-term memories plus the lead-inventory substrate:

| Memory / feature    | What it is                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Episodic transcript | The companion's single continuous conversation (the episodic substrate, `messages` table)               |
| Semantic memory     | Sources read into verbatim sections + a typed fact overlay, retrievable with citations (`implementation.md` §1) |
| Episodic store      | Consolidated episodes + personality evolution                                                            |
| Procedural memory   | Workflows seeded from approved actions; a relevant learned routine also resurfaces in context as a retrieval-as-hint (`architecture.md` §4.3) |
| User Model          | The companion's structured + synthesized understanding of its **user** — `user_facts` (identity + learned beliefs) + the Tier-3 user persona; see §4 |
| Lead inventory      | The reading list (discovered URLs) — the body-then-will substrate, worked on command and by the motivation engine on idle |

> **Not held *as* memory.** Two things the companion holds are surfaced near memory but are not
> long-term memory, and are owned elsewhere — they are deliberately out of this table:
> - the **growth mirror** (knowledge · bond · initiative · character) is a *derived readout* of the
>   accumulation above, owned by the **Growth Service** (`architecture.md` §4.3, §3; data model
>   `implementation.md` §1) and shown in the separate Growth view, not the memory browser;
> - the **approval queue** is the propose→approve trust gate, owned by `architecture.md` §4.4
>   (vision `product-overview.md` §5.3) — the browser merely *surfaces* it as approval cards (§5).

The browser and eval harness below are designed so each memory kind slots in cleanly. A user-facing
manage/delete capability is out of scope (§7).

## 4. The User Model — what the companion knows about the user

The companion builds an explicit, structured **model of its user** — the symmetric mirror of the
`evolvedPersona` it grows for *itself*. It is **not** a store bolted on the side: it reuses the typed
fact overlay, the hybrid-retrieval pattern, and the persona-synthesis pattern the rest of memory
already uses, with the **user as a privileged entity** in the one ontology (`ontology.md`). Three
tiers:

| Tier | What it holds | Where it lives | How it enters a turn |
| --- | --- | --- | --- |
| **1 — Core profile** | Identity facts: name, pronouns/gender, `bornOn`/age, `livesIn`, `worksAs` (all **singular** — a new value supersedes); plus `languages` and key `relationships` (**multi-valued** — distinct values accrete as separate rows, see `MULTI_VALUED_PREDICATES`) | `user_facts` — the **name is just one such fact**, not a `users` column (`implementation.md` §1) | Rendered into the **persona prompt every turn** — small, always carried (no retrieval) |
| **2 — Learned beliefs** | Preferences, interests, opinions, habits, goals (`prefers`/`dislikes`/`interestedIn`/`believes`) | `user_facts`, typed, with confidence · salience · provenance · supersession | A **retrieval arm**: hybrid-search the *current* beliefs, inject the top-K relevant ones (`architecture.md` §4.3) |
| **3 — User persona** | A synthesized narrative — "who you are to me" | `companions.user_persona` | Blended into the persona prompt beside `evolvedPersona` |

**Shared truth vs. personal understanding (why the scoping differs).** The *facts* (Tiers 1–2) are
**per-user** — objective truths about the person ("vegetarian", born 1990, lives in Berlin), so
`user_facts` is keyed by `user_id` and shared across any companion the user owns: tell one companion,
all know. The *synthesized understanding* (Tier-3 `user_persona`) is **per-companion** — each
companion forms its **own** sense of you, drawn from the shared fact pool **plus its own per-companion
episodic history** with you. Truth is common; understanding is personal — the exact mirror of the
companion's own `evolvedPersona` (per-companion). The **name is just one Tier-1 fact**, not a special
`users` column: it is **seeded from your Google account at sign-in** (a modest-confidence `auth_seed`
fact, so first contact already has a name) and **refined in conversation** — a name you state or edit
supersedes the seed; if Google gave none, the companion asks. That seed/state/edit distinction is the
fact's **`source`** (`transcript` \| `auth_seed` \| `user_edit`), the general provenance every
user-fact carries (`implementation.md` §1, `ontology.md` §4). (In the PoC a user has one companion, so
per-user and per-companion coincide; the schema is scoped correctly for when they don't.)

**The knowledge cycle (extract → persist → retrieve → inject).** One loop: every turn feeds the
transcript; perception and reflection turn that into typed facts; persisted facts flow back into the
next turn's prompt — so the companion knows a little more each time.

```mermaid
flowchart TB
    subgraph TURN["A turn (the agent loop)"]
      U["user message"] --> RUN["Harness → reply streams"]
    end
    RUN --> TX[("transcript<br/>(messages)")]

    %% 1. EXTRACT
    RUN -.->|"post-turn perception<br/>(sibling to affect sensing)"| INLINE["① Inline salient capture<br/>explicit, high-signal facts only"]
    TX -->|"off-request · cursor-gated · metered"| REFLECT["① Background reflection<br/>(User-Model Reflector):<br/>infer implicit beliefs · dedup ·<br/>supersede · decay · synthesize Tier-3"]

    %% 0. SEED (at sign-in)
    SEED["Google sign-in<br/>name claim"] -.->|"seed name<br/>(source=auth_seed)"| UF

    %% 2. PERSIST
    INLINE -->|"record facts: supersede singular,<br/>accrete multi-valued (name: source=transcript)"| UF[("② user_facts (per-user)<br/>Tier-1 profile + Tier-2 beliefs")]
    REFLECT --> UF
    REFLECT -->|"synthesize narrative"| UP[("② companions.user_persona<br/>Tier-3, per-companion")]

    %% 3. RETRIEVE + 4. INJECT (next turn)
    UF -->|"Tier-1 core profile only (incl. name)"| PERSONA["④ persona system prompt"]
    UP -->|"beside evolvedPersona"| PERSONA
    UF -->|"③ embed turn → hybrid-search<br/>current (non-superseded) facts"| ARM["③ user-model arm<br/>top-K beliefs (fenced)"]
    PERSONA --> PROMPT[["assembled prompt → LLM"]]
    ARM --> PROMPT
    PROMPT --> RUN
```

Stages: **① extract** (inline `motivation/affect.ts` sibling + the reflector that extends
consolidation, `architecture.md` §4.5/§4.3) → **② persist** (per-user `user_facts` + per-companion
`user_persona`, `implementation.md` §1) → **③ retrieve** (Tier-2 arm in `composeRetrieveContext`) →
**④ inject** (Tier-1 + Tier-3 into the persona, Tier-2 as a fenced block — `architecture.md` §4.3).
The prose below elaborates each.

**How facts are learned — hybrid extraction (never blocks the reply):**

- **Inline salient capture.** After the reply streams, the same post-turn perception that senses the
  user's mood (`motivation/affect.ts`) also runs a conservative user-fact extractor — **explicit,
  high-signal** statements only ("call me Sam", "I'm vegetarian"). It writes them immediately; a
  stated name is just the singular `name` attribute (`source=transcript`), superseding the
  `auth_seed` name from sign-in — no special path, no `users` column (`architecture.md` §4.5).
- **Background reflection.** The heavy lifting is off-request, in a **User-Model Reflector** that
  extends episodic consolidation (cursor-gated, metered): it derives **implicit** beliefs from
  patterns across many turns ("keeps asking about Rust → interested in Rust") and re-synthesizes the
  Tier-3 user persona — exactly as consolidation already drives `evolvedPersona` (`architecture.md`
  §4.3).

**Write discipline (owned by the reflector, so hygiene lives in one place):** a fact is never
overwritten in place — a revision **supersedes** (insert the new value as current, mark the old
`superseded_at`/`superseded_by`), so history is kept. Singular attributes (`name`, `livesIn`, …)
supersede the prior value for the predicate; **multi-valued** ones (`languages`, `relationships` —
`MULTI_VALUED_PREDICATES`) **accrete**, superseding only an identical `(predicate, object)`
restatement so distinct values coexist. A new belief **dedups** against existing ones (embedding
match) instead of duplicating; a contradiction **supersedes** the old with a timestamp (not silently
both-true); confidence and a decaying salience steer retrieval toward what's current (`ontology.md`
§4).

**Trust & control:** the companion is **fully trusted to write its own memory** — there is **no
approval queue** for user-facts (that gate is for external side-effects, `architecture.md` §4.4). The
safeguard is **legibility, not gating**: everything it believes about you is visible, **editable, and
forgettable** in the memory browser (§5) — the one place the otherwise read-only browser gains a write
affordance. Sensitive inferences (gender, age, health) are held to a higher confidence bar.

**Iterating extraction quality:** because extraction is the part most likely to drift, it has its own
**eval dataset** — `user-extract` (`howto-run-evals.md`): explicit identity attributes scored
deterministically, fuzzier preferences by LLM judge. A prompt change that loses identity facts or
invents preferences fails the gate (`ontology.md` §5).

> **Status.** **Phase 11 (core profile) is implemented**: the `user_facts` store, inline capture of
> explicit identity facts each turn, Tier-1 injection into the persona, the name seeded from sign-in
> (no more `display_name` column), and the editable/forgettable browser panel — gated by the
> `user-extract` eval. **Tiers 2–3 are designed, not yet built**: learned-belief retrieval (Phase 12)
> and the synthesized user persona + decay (Phase 13) — `development-plan.md` §4c.

## 5. Browsing memory (read-only)

A read-only view of everything a companion holds, grouped by memory kind.

**API** (owner-scoped; `/memory` + `/memory/search` in
`packages/api/src/routes/memory.routes.ts`, `/sources…` + `/ingestion` in
`source.routes.ts`):

- `GET /companions/:companionId/memory` — a sectioned snapshot
  (`MemorySnapshotDto` in `packages/shared/src/contracts.ts`): `identity`,
  `episodic` (the single transcript's `messageCount`), `semantic`
  (source/section/fact counts + ingestion jobs), and `procedural` (count of learned
  workflows). It also exposes `GET …/procedures` (learned workflows), `GET …/leads`
  (the reading list), `POST …/explore` (work the reading list → proposals), and the
  approval queue (`GET …/proposals`, `POST …/proposals/:id/confirm|reject`).
- `POST /companions/:companionId/memory/search` — search semantic memory
  directly; results carry the verbatim passage + a `Citation` (source, chapter,
  paragraph/page range).
- `GET /companions/:companionId/sources` and `GET …/sources/:sourceId` — the
  sources the companion has read and the per-source section drill-in (verbatim
  text + the companion's Pass-2 context line); `GET …/ingestion` — reading
  progress ("read N of M").
- Transcript drill-in reuses the chat read path
  `GET /companions/:companionId/messages` (the companion's one continuous
  conversation; there is no conversation/session entity — see
  [`implementation.md`](./implementation.md) §1). This read path returns the
  **most-recent N** messages (a recency window, like the harness `recentLimit`),
  not the full lifelong transcript — so both chat resume and the browser drill-in
  show the latest window. Full-history retrieval/paging is out of scope (§7).

**Web** (`packages/web/src/pages/MemoryBrowser.tsx` and `Sources.tsx`): reachable
via the **Memory** and **Sources** buttons in the chat header
(`packages/web/src/App.tsx`). The browser renders the identity card, the episodic
section (message count + "View transcript" toggle), the semantic section
(source/section/fact counts + a search box returning verbatim passages with
provenance), the procedural section (learned-workflow count + list), and the
reading-list (leads). Effectful actions surface as one-tap **approval cards** below
the chat transcript (`ProposalCard` + the `useProposals` hook). The Sources page handles
intake (file upload, note, link), shows reading progress, and lets the user delete a
source (incl. one parked for want of stamina); a vitality indicator in each page
header shows the companion's remaining stamina. Grounded chat answers render their citations
inline in `Chat.tsx`.

> The **User-Model panel** (§4) extends this browser with the companion's profile + learned beliefs
> about the user, and is the **one place the browser becomes writable** — read, edit, and forget —
> per the User-Model workstream (`development-plan.md` §4c, Phase 11 read + Phase 13 full management).

## 6. Evaluating memory vs performance

The question "how does the companion's _memory_ affect its _performance_" is
answered by the `memory-recall` dataset in **`packages/eval`** — a **live** run
of a fixed eval set under several memory configurations, scored for recall +
grounding. It is now one dataset in a generalized **dataset → scorer → runner**
framework that also covers stateless per-call-site datasets (e.g. `affect-sense`,
and `user-extract` — the User-Model extraction gate, §4) and a red-team `injection`
dataset. **How to run any of them — including the
deterministic CI tier vs the live nightly tier — lives in `howto-run-evals.md`.**

**Run it:**

```bash
OPENROUTER_API_KEY=… pnpm eval
# optional: choose recency windows; skip the semantic configs; pick models
OPENROUTER_API_KEY=… EVAL_WINDOWS=2,12,200 EVAL_SEMANTIC=false \
  LLM_MODEL=anthropic/claude-3.5-sonnet INGESTION_MODEL=google/gemini-2.5-flash pnpm eval
```

It is live (hits OpenRouter, costs tokens, non-deterministic), so it is **not**
on the per-PR gate. It does run nightly (and on demand) via
`.github/workflows/eval-nightly.yml` — the live tier, which runs memory-recall
(plus the stateless datasets) via `--dataset=all`. See `howto-run-evals.md`.

**What it does** (`src/run.ts`, fixtures in `src/fixtures/recall.json`): each case
seeds a transcript — and, for the source-grounded cases, **ingests `sources` through the
real `IngestionPipeline`** (live segmentation/enrichment/embeddings) — then asks a
question whose answer either _is_ reachable (**recall** cases) or _is not_
(**absence** cases). For every `MemoryConfig` it seeds a fresh companion (the
isolation boundary now that a companion holds one lifelong transcript), runs the
real `Harness` over the real `OpenRouterGateway`, and scores the answer in two
layers (`src/score.ts`): a deterministic expected-fact check, then an
LLM-as-judge for grounding (0–1) and hallucination. `src/report.ts` prints the
headline **comparison table** — one row per config — plus per-case detail:

```
memory config      window  recall pass  grounding  halluc. (absent Qs)
window-2            2       0%           0.20       50%
window-200          200     66%          0.80       0%
semantic-header     12      100%         0.95       0%
semantic-noheader   12      83%          0.90       0%
```

(Illustrative numbers.) Two signals: widening reachable memory raises recall and
grounding while lowering hallucination; and the **source-grounded cases** separate
the configs — facts that live only in an ingested book are unreachable for any
recency window and recalled only by the semantic configs. The
`semantic-header` / `semantic-noheader` pair is the **contextual-header A/B**
(`implementation.md` §3 `USE_CONTEXT_HEADER`): measure, don't assume, whether
prefixing the Pass-2 context line onto embedding inputs improves retrieval.

## 7. Beyond the PoC

Out of scope for this release (roadmap → [`development-plan.md`](./development-plan.md) §3):

- **Managing & deleting memory.** A user-facing inspect/manage/delete capability. The intended
  design: per-item "forget" actions (forget a stretch of the transcript, later a fact or skill)
  backed by deletes that cascade through the existing `onDelete: 'cascade'` foreign keys
  (`db/src/schema.ts`). The browser in §5 is deliberately **read-only** for now — **except the User
  Model** (§4), whose facts become editable/forgettable in Phase 13 (`development-plan.md` §4c), the
  first write affordance and the template for broader forget controls later.
- **Full-history transcript paging.** The read path returns the most-recent N messages (§5); paging
  the full lifelong transcript is not built.
