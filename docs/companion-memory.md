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

The companion's knowledge base is **three long-term memories** plus an approval
queue (see [`product-overview.md`](./product-overview.md) §2.1):

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

The companion holds all three long-term memories plus the inventory/approval substrate:

| Memory / feature    | What it is                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Episodic transcript | The companion's single continuous conversation (the episodic substrate, `messages` table)               |
| Semantic memory     | Sources read into verbatim sections + a typed fact overlay, retrievable with citations (`implementation.md` §1) |
| Episodic store      | Consolidated episodes + personality evolution                                                            |
| Procedural memory   | Workflows seeded from approved actions; a relevant learned routine also resurfaces in context as a retrieval-as-hint (`architecture.md` §4.3) |
| Lead inventory      | The reading list (discovered URLs) — the body-then-will substrate, worked on command and by the motivation engine on idle |
| Bond & growth       | Four-axis growth mirror derived from activity + the feeding economy (`companion-economy.md`)             |
| Approval queue      | Propose→approve, exactly-once                                                                            |

The browser and eval harness below are designed so each memory kind slots in cleanly. A user-facing
manage/delete capability is out of scope (§6).

## 4. Browsing memory (read-only)

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
  show the latest window. Full-history retrieval/paging is out of scope (§6).

**Web** (`packages/web/src/pages/MemoryBrowser.tsx` and `Sources.tsx`): reachable
via the **Memory** and **Sources** buttons in the chat header
(`packages/web/src/App.tsx`). The browser renders the identity card, the episodic
section (message count + "View transcript" toggle), the semantic section
(source/section/fact counts + a search box returning verbatim passages with
provenance), the procedural section (learned-workflow count + list), and the
reading-list (leads). Effectful actions surface as one-tap **approval cards** below
the chat transcript (`ProposalCard` + the `useProposals` hook). The Sources page handles
intake (file upload, note, link), shows reading progress, and lets the user delete a
source (incl. one parked at the daily token cap); a usage indicator in each page
header shows the day's token allowance. Grounded chat answers render their citations
inline in `Chat.tsx`.

## 5. Evaluating memory vs performance

The question "how does the companion's _memory_ affect its _performance_" is
answered by the `memory-recall` dataset in **`packages/eval`** — a **live** run
of a fixed eval set under several memory configurations, scored for recall +
grounding. It is now one dataset in a generalized **dataset → scorer → runner**
framework that also covers stateless per-call-site datasets (e.g. `affect-sense`)
and a red-team `injection` dataset. **How to run any of them — including the
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

## 6. Beyond the PoC

Out of scope for this release (roadmap → [`development-plan.md`](./development-plan.md) §3):

- **Managing & deleting memory.** A user-facing inspect/manage/delete capability. The intended
  design: per-item "forget" actions (forget a stretch of the transcript, later a fact or skill)
  backed by deletes that cascade through the existing `onDelete: 'cascade'` foreign keys
  (`db/src/schema.ts`). The browser in §4 is deliberately **read-only** — no destructive controls.
- **Full-history transcript paging.** The read path returns the most-recent N messages (§4); paging
  the full lifelong transcript is not built.
