# Companion Memory — How It Works, How to Browse It, How to Evaluate It

This guide explains the companion's memory mechanism end-to-end and points to the
two tools for working with it: the **read-only memory browser** and the
**memory-vs-performance evaluation harness**.

It is a guide, not a source of record. Canonical facts live elsewhere and are
linked here, never copied:

- **Vision & the three memory types** → [`product-overview.md`](./product-overview.md) §2.1, §7
- **Architectural seams** (MemoryStore boundary, the agent loop) → [`architecture.md`](./architecture.md) §2, §4.3
- **Data model & hook signatures** → [`implementation.md`](./implementation.md) §1, §2.1
- **Phased rollout & acceptance criteria** → [`development-plan.md`](./development-plan.md) §3

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

- Interface & Phase 0 implementation: `packages/core/src/memory/store.ts`
- The harness pulls prior context through the **`RetrieveContext` hook** — the
  single place memory enters a turn: `packages/core/src/harness/hooks.ts`,
  assembled in `packages/core/src/harness/context.ts`
  (signatures documented in [`implementation.md`](./implementation.md) §2.1).

This is the extension point: P1 fills `RetrieveContext` with semantic recall, P2
with episodic recall, **without touching the loop**.

## 3. What exists today vs the roadmap

> **Reality check.** Most of the knowledge base is designed but not yet built.
> Today the only memory that physically exists is the companion's single continuous
> **conversation transcript** (the episodic substrate, `messages` table —
> [`implementation.md`](./implementation.md) §1). A companion has exactly one
> lifelong conversation with its user, not a list of chat sessions.

| Memory / feature    | Status today       | Arrives in                                     |
| ------------------- | ------------------ | ---------------------------------------------- |
| Episodic transcript | ✅ Built (Phase 0) | —                                              |
| Semantic memory     | ❌ Not built       | Phase 1 ([dev-plan](./development-plan.md) §3) |
| Episodic store      | ⚠️ Transcript only | Phase 2                                        |
| Procedural memory   | ❌ Not built       | Phase 3                                        |
| Approval queue      | ❌ Not built       | Phase 3                                        |
| Manage/delete UI    | ❌ Not built       | Phase 8                                        |

The browser and eval harness below are built **now** and designed so each memory
kind slots in as it lands.

## 4. Browsing memory (read-only)

A read-only view of everything a companion holds, grouped by memory kind.

**API** (`packages/api/src/routes/memory.routes.ts`, owner-scoped):

- `GET /companions/:companionId/memory` — a sectioned snapshot
  (`MemorySnapshotDto` in `packages/shared/src/contracts.ts`): `identity`,
  `episodic` (the single transcript's `messageCount`), and `semantic`/`procedural`
  as `not_implemented` placeholders carrying their planned phase.
- Transcript drill-in reuses the chat read path
  `GET /companions/:companionId/messages` (the companion's one continuous
  conversation; there is no conversation/session entity — see
  [`implementation.md`](./implementation.md) §1). This read path returns the
  **most-recent N** messages (a recency window, like the harness `recentLimit`),
  not the full lifelong transcript — so both chat resume and the browser drill-in
  show the latest window. Full-history retrieval/paging is deferred (Phase 2+).

**Web** (`packages/web/src/pages/MemoryBrowser.tsx`): reachable via the **Memory**
button in the chat header (a `chat`/`memory` view toggle in
`packages/web/src/App.tsx`). It renders the identity card, the episodic section
(the message count with a "View transcript" toggle that expands the one continuous
conversation), and "coming soon" panels for semantic and procedural so the full
shape is visible before those stores exist.

## 5. Evaluating memory vs performance

The question "how does the companion's _memory_ affect its _performance_" is
answered by the harness in **`packages/eval`** — a **live** CLI that runs a fixed
eval set under several memory configurations and scores the answers.

**Run it:**

```bash
OPENROUTER_API_KEY=… pnpm eval
# optional: choose recency windows to compare
OPENROUTER_API_KEY=… EVAL_WINDOWS=2,12,200 LLM_MODEL=anthropic/claude-3.5-sonnet pnpm eval
```

It is live (hits OpenRouter, costs tokens, non-deterministic) and so is **not**
wired into CI.

**What it does** (`src/run.ts`, fixtures in `src/fixtures/recall.json`): each case
seeds a transcript, then asks a question whose answer either _is_ present
(**recall** cases) or _is not_ (**absence** cases). For every `MemoryConfig` it
seeds a fresh companion (the isolation boundary now that a companion holds one
lifelong transcript), runs the real `Harness` over the real
`OpenRouterGateway` with that config's `recentLimit`, and scores the answer in two
layers (`src/score.ts`): a deterministic expected-fact check, then an
LLM-as-judge for grounding (0–1) and hallucination. `src/report.ts` prints the
headline **comparison table** — one row per config — plus per-case detail:

```
memory config  window  recall pass  grounding  halluc. (absent Qs)
window-2        2       0%           0.20       50%
window-12       12      100%         0.95       0%
window-200      200     100%         0.96       0%
```

(Illustrative numbers.) The signal: widen the reachable memory and recall +
grounding rise while hallucination falls.

**Honest limitation.** Until semantic memory exists (Phase 1), the only config
axis is `recentLimit`, so the harness measures **recall over the transcript
window**, not source-grounded knowledge. This is exactly the Phase 1 eval shape
([dev-plan](./development-plan.md) §3: "source→question→expected-answer pairs");
adding `sources` to each case and a semantic-retrieval `MemoryConfig` reuses the
same runner, scorer, and report unchanged.

## 6. Managing & deleting memory (designed, deferred)

A user-facing inspect/manage/delete capability is Phase 8
([dev-plan](./development-plan.md) §3). The intended design, when built:
per-item "forget" actions (forget a stretch of the transcript, later a fact or skill) backed by
deletes that cascade through the existing `onDelete: 'cascade'` foreign keys
(`db/src/schema.ts`). The browser in §4 is deliberately **read-only** until then —
no destructive controls.
