# CobbleCompanion — Emoji Reactions

> **Canonical source for emoji reactions in chat** — the user reacting to the companion's messages,
> and the companion reacting to the user's. Reactions are a **second reward-learning channel** beside
> the every-turn affect loop: an *addressed, explicit* signal the companion learns from, and an
> *expressive* act the companion emits to feel present. This doc owns the reaction surface, its data
> model, and how its signal plugs into learning; the **drive model, arbitration, and change-as-reward
> loop it extends** are owned by `companion-motivation.md` §7. For the agent-loop seam the companion's
> own reaction is emitted from see `architecture.md` §4.5; for the standing event channel reactions
> ride see `architecture.md` §6; for the **stamina** wallet the read it triggers spends see
> `companion-economy.md`; for the user model / beliefs the reflection layer feeds see
> `companion-memory.md` §4; for canonical schema (`message_reactions`) see `implementation.md` §1; for
> scope/sequencing see `development-plan.md` §4f.
>
> **Status: designed, not built.** Nothing in this doc ships yet. It specifies the design; phase
> placement and acceptance criteria are owned by `development-plan.md` §4f.

## 1. Why this exists — what a reaction _is_

A reaction is a distinct speech act from a reply, and stripping it to first principles is what makes
it valuable to a *learning* companion. A reaction has four properties a typed turn does not:

1. **It is _addressed_.** A reaction is bound to exactly one message. A reply is ambient — it answers
   "the conversation," and you must infer what it responds to. A ❤️ on message _M_ is unambiguously
   _about M_. This is the property that matters most below.
2. **It is backchannel / low-friction.** It costs the sender almost nothing and takes no turn — so it
   carries the small signals people wouldn't bother typing ("that landed", "I saw this", "aww").
3. **It is a compressed verdict.** An emoji is a quantized emotional judgement, carrying valence and
   often a flavour (delight vs. agreement vs. gratitude).
4. **It is asynchronous & retractable** — a revisable annotation on the transcript, addable later and
   removable, rather than an immutable turn.

The companion's change-as-reward loop (`companion-motivation.md` §7) already does real work —
differencing valence (`delta = valence_now − valence_before`), the one-pending-outcome rule, the
`findLatestUnresolved` claim — to **isolate the companion's effect** and **attribute it to the right
act**. A reaction gives that away for free: an explicit, signed, **addressed** verdict on a specific
act. The motivation doc literally calls the thing it waits for "a reaction"; this feature makes that a
real, structured signal.

So the strategic framing: **reactions are the high-confidence, explicitly-attributed reward channel;
the every-turn affect delta is the implicit, ambient fallback.** They are complementary, not
redundant.

## 2. Vocabulary

| Term | What it is |
|---|---|
| **Reaction** | An emoji attached to a single transcript message, by the user or the companion. A `message_reactions` row, not a transcript turn (`implementation.md` §1). |
| **Reactor** | Who placed the reaction — `user` or `companion`. |
| **Value-created reward** | The reward a *user* reaction yields: **did the companion's act create value for the user?** Judged in context, in [−1, 1] — not the emoji's face-value valence (§7). |
| **Inline reaction-read** | The cheap, per-reaction structured read that turns one user reaction (in the context of the act it lands on) into a value-created reward + note. The fast path that feeds the nudge (§4, §7). |
| **Reflection** | The slower, periodic pass that turns *many* reactions + their notes into understanding — beliefs, persona, diffuse credit — feeding the user model (§6). A separate timescale from the inline read. |
| **Expressive reaction** | A reaction the **companion** emits as part of a turn (👀 "on it", 🎉, 🙏). Pure expression — it creates no outcome and awaits no reward (§5). |
| **Quick-react bar** | A curated shortcut set (❤️ 👍 😂 🎉 😮 😢 🙏 👎) shown for one-tap reacting, with a "+" to the full picker. A **convenience, not a constraint** — neither side is limited to it (§7). |

## 3. The two directions

Reactions flow both ways, and the two directions have **different natures** — one is a learning
_input_, the other an expressive _output_:

```mermaid
flowchart LR
    subgraph U2C["You → Companion · a verdict (learning input)"]
        direction TB
        u1["you react to an<br/>assistant message"] --> u2["inline value-created read<br/>(§4, §7)"]
        u2 --> u3["reward → drive weight<br/>+ belief salience (will learns)"]
        u2 -.-> u4["logged for reflection (§6)"]
    end
    subgraph C2U["Companion → You · expression (output)"]
        direction TB
        c1["model plans a reaction<br/>mid-turn (§5)"] --> c2["react(emoji) action<br/>— free, ungated"]
        c2 --> c3["lands on your message,<br/>pushed live (no outcome)"]
    end
```

Only `message`-kind rows are reactable; `tool_step` / `proposal` chrome is not.

## 4. Flow 1 — you react (the reward channel)

The user taps an emoji on an assistant message. Persisting and acknowledging the tap is instant; all
learning runs **after** the response and is best-effort, so a reaction never blocks the UI and a
learning hiccup never surfaces as an error (`logging.md`).

```mermaid
sequenceDiagram
    participant C as Web client
    participant API as API (reactions route)
    participant DB as message_reactions
    participant CH as Event channel (§6)
    participant R as ReactionService (body — senses)
    participant W as reinforce.ts (will — learns)

    C->>API: POST …/messages/:id/reactions {emoji}
    API->>DB: upsert row (reactor=user)
    API->>CH: publish reaction_added
    CH-->>C: live update (this + other surfaces)
    API-->>C: 200 (tap never blocks)
    Note over API,R: after response, not awaited
    API->>R: onUserReaction(companionId, messageId, emoji)
    R->>R: inline read — value created? (§7)<br/>→ reward ∈ [−1,1] + note, or null
    alt null (read failed / declined)
        R-->>W: no learning (never fabricate neutral)
    else reward
        R->>DB: store reward + reward_note (reflection corpus §6)
        R->>R: nudge rolling companion_affect (fast-loop attune)
        R->>W: reinforce(messageId, reward)
        alt reacted id maps to an unresolved outcome
            W->>W: resolve THAT outcome by note_message_id<br/>nudge served drive — if belief-driven,<br/>adjust belief salience
        else ordinary answer
            W->>W: nudge approval/competence (smaller α)
        end
    end
```

Three things this flow makes precise:

- **Addressing replaces differencing.** Because the reaction is pinned to one act, the reward needs no
  `valence_now − valence_before`; the act is already isolated. The inline read outputs the reward
  directly.
- **Resolve _by message id_, not "latest unresolved."** A reaction on a report note resolves the
  `proactive_outcomes` row whose `note_message_id` equals the reacted id — strictly better attribution
  than the ambient `findLatestUnresolved` path, and it sidesteps the one-pending ambiguity.
- **First resolver wins, for free.** The existing atomic claim (`reward IS NULL`,
  `companion-motivation.md` §7) means if a reaction resolves an outcome, the later ambient affect delta
  finds nothing unresolved — no double-nudge — and vice-versa. No new guard.

**Reactions on _ordinary_ answers.** Today ordinary chat moves no weights (diffuse credit is
deferred). But a reaction on a plain answer is _not_ diffuse — it is addressed — so it nudges the
**approval/competence** drive (`companion-motivation.md` §3, the RL-coupled axis) at a smaller α, and
its note feeds reflection (§6). This is attributed learning on everyday chat without solving general
diffuse credit assignment.

## 5. Flow 2 — the companion reacts (expression, planned in the turn)

The companion's own reactions are **a first-class expressive action the model plans within a turn** —
not a side-channel perception. The killer property is **react-early-then-work**: you ask it to
validate something, a 👀 lands on your message in a beat, _then_ the tool steps stream, _then_ the
verdict. That depends on the reaction being _in_ the plan, decided by the model that understands the
request.

```mermaid
flowchart TD
    A["user turn arrives"] --> B["agent loop — model plans the turn"]
    B --> R{"react now?<br/>(adds something:<br/>acknowledgement / resonance)"}
    R -->|yes| EMIT["react(emoji) — free, ungated action<br/>persist message_reactions (reactor=companion)<br/>flush over event channel immediately"]
    R -->|no| WORK
    EMIT --> WORK["continue turn —<br/>tool_steps, then reply"]
    WORK --> DONE["reply streams"]
```

- **Plumbed like a free `tool_step`.** The `react` action reuses the loop's expressive-emit machinery:
  UI-only, **ungated** (no approval — it's not effectful), **excluded from the LLM-context projection**
  on reload, and **streamed the instant it's decided** so it can precede the rest of the turn. It
  persists a `reactor='companion'` row on the _user's_ message.
- **It subsumes the affective case too.** If the companion is taking a turn anyway, the main model
  understands emotional content at least as well as a cheap side-read — so a ❤️ on good news is also
  just a planned action. **One mechanism**, not two; the affect read goes back to pure perception
  (sense → learn), never expression.
- **No extra cost.** The reaction is a few tokens in a turn the model already runs — no separate call.
  It rides the turn's **stamina**, like the reply.
- **It creates no outcome.** Expression awaits no reward — otherwise the companion could react to _bait_
  a reaction. It is a free emit, like a tool step.
- **The dial concern dissolves.** A reaction _inside a turn responding to you_ **is** being reactive —
  so `off` (reactive-only, `companion-motivation.md` §5) has nothing to suppress; expressive reactions
  only happen while already answering you.
- **It lets the companion be terser.** Instead of typing "Sure, let me check that," it 👀 and goes — a
  glance reads as _more_ present than a sentence, and trims reflexive filler. Prompt-govern it the way
  tool use is governed: react only when it _adds_ something, never on every turn.
- **Not whitelisted — governed by taste.** The companion is **not** restricted to a fixed set; it may
  pick any emoji, the same way it chooses its wording. The only soft guidance is **legibility** — lean
  on common, unambiguous emoji, since a reaction the user can't read is a wasted signal. The
  quick-react bar (§2) is a user convenience, not the companion's allowed set.

## 6. Flow 3 — reflection (the deeper, separate learning pass)

The inline read (§4) produces the immediate, well-attributed **reward**. A second, slower pass turns
accumulated reactions into **understanding** — and the two are deliberately separate timescales (the
inline read _must_ be immediate, to attribute while the outcome is still fresh; reflection benefits
from hindsight the inline read can't have).

```mermaid
flowchart LR
    subgraph FAST["Inline read · per reaction (§4)"]
        f1["reaction event"] --> f2["value-created reward<br/>→ nudge (well-attributed)"]
        f2 --> f3[("message_reactions<br/>reward + note")]
    end
    subgraph SLOW["Reflection · periodic"]
        f3 --> s1["read accumulated reactions<br/>+ notes + surrounding mood"]
        s1 --> s2["derive understanding:<br/>beliefs, persona, diffuse credit"]
        s2 --> s3["write user_facts / persona<br/>(Phase 12/13 machinery)"]
    end
```

Reflection rides the existing consolidation/reflector cadence (`companion-memory.md`). It converts
"the user reacted 😢 to a moving story, 👍 to terse facts" into beliefs ("moved by personal stories;
prefers concise") and persona refinement — and it is the natural home for the **diffuse-credit**
ordinary-chat learning the motivation loop defers. **Reflection is the next layer, not a v1 blocker:**
the reward channel works without it; reflection makes the companion _understand what kind of value this
user wants_, not just nudge a weight.

## 7. The reward is "value created", not emoji valence

The single most important design decision: a **fixed emoji→score lexicon is wrong** on the reward
path, because the same glyph means opposite things depending on what the companion did.

> The companion shares a piece of sad news and you react 😢. That is **not** a negative reward — you
> were _reached_; the act created value. The same 😢 on a botched attempt to help _is_ negative. The
> reward is not "is the user happy" and not "what does the emoji mean" — it is **did the companion's
> act create value for the user?**, and only the _context_ (what it did, what it said) separates the
> two. A static table can't see that — and by `companion-motivation.md` §7 ("big emotional swings teach
> more"), it would be wrong on exactly the reactions that should teach the most.

So the reward is **interpreted, not looked up**, which lands it back in the architecture already there:
the change-as-reward loop never read keywords — it read mood _in context_. The **inline reaction-read**
(§4) is the same machinery as the affect read (`implementation.md` §1, the `report_affect` channel),
generalized: its inputs are _(the reacted message + recent context + the act's intent / served drive)_;
its output is a **value-created reward ∈ [−1, 1] + a short note**, or **`null`** on failure/decline.
The same body-senses / will-learns seam holds — the read is a body-side perception, `reinforce.ts`
decides what it teaches.

- **Null is never a fabricated neutral.** A failed or declined read yields no learning — identical to
  the affect read's rule, so a hiccup can't masquerade as a neutral reward and move weights.
- **Any emoji is fair game, both ways.** Because the reward is interpreted in context, **no emoji set
  is enforced** — the user reacts with anything (the quick-react bar is just a shortcut, §2), and the
  companion picks freely, guided by taste/legibility rather than a whitelist (§5). The read interprets
  whatever appears.
- **Reward-hacking shrinks.** A "value-created" judgement is far harder to farm than spamming ❤️, and
  the existing guards still hold: claim-once-per-outcome, small additive α, the drive-serving gate.

## 8. Data model, delivery & API

**Table — outside the append-only transcript.** Reactions are _mutable_ (add/remove, after the fact);
the transcript row is immutable. So reactions live in their own table, and the transcript stays
canonical. Canonical schema → `implementation.md` §1.

```mermaid
erDiagram
    messages          ||--o{ message_reactions : "annotated by"
    companions        ||--o{ message_reactions : "scoping (tenancy)"
    message_reactions {
        uuid id PK
        uuid message_id FK
        uuid companion_id FK
        text reactor "user | companion"
        text emoji
        numeric reward "nullable — inline read"
        text reward_note "nullable — reflection corpus"
    }
```

`unique (message_id, reactor, emoji)` makes toggling idempotent; un-reacting deletes the row.
`reward` / `reward_note` are filled by the inline read (user reactions only) and are the corpus
reflection (§6) consumes.

**Contracts** (`@cobble/shared`) — a validated `emoji`, a `ReactionDto`, and a derived
`MessageDto.reactions[]` (joined for render, never stored on the immutable row). Boundary validation
(`security.md`) checks the value is a **single well-formed emoji** with a sane length cap — **not**
membership in an allowed set; no emoji is whitelisted on either side (§7).

**Delivery** — reactions ride the **standing companion event channel** (`architecture.md` §6): two new
`CompanionStreamEvent` variants, `reaction_added` / `reaction_removed`, carrying
`{ messageId, reactor, emoji }`. This is how the companion's own reaction appears live, and how a
reaction placed on one surface syncs to another.

**API** — `POST /companions/:id/messages/:messageId/reactions {emoji}` and
`DELETE …/reactions/:emoji`: validate, persist, publish, **return immediately**; the inline read +
reinforcement run after the response, best-effort.

**Seam — event-triggered, beside the harness.** A user reaction is _not_ a turn, so its read is
triggered from a small **`ReactionService`** (body-side perception → reward), not from the harness's
in-loop `perceiveAndLearn` — analogous to how the greeting is edge-triggered (`companion-greeting.md`).
The companion's _own_ reaction, by contrast, _is_ emitted inside the agent loop (§5).

## 9. How it fits the motivation engine

Reactions **extend** the change-as-reward loop (`companion-motivation.md` §7) rather than replacing
it — they reuse its machinery unchanged:

- **The reward target** — a user reaction on a report note resolves the same `proactive_outcomes` row
  the ambient affect delta would, attributed by `note_message_id`. If the burst was belief-driven
  (`driven_by_user_fact_id`), the same reward also adjusts that belief's `salience` — the Phase-12
  belief-learning loop, _with no new code on that branch_.
- **The claim guard** — the atomic `reward IS NULL` claim already makes "reaction vs. ambient delta"
  safe: whichever resolves first wins, no lost update.
- **The dial** — unaffected for the user direction; for the companion direction it dissolves (§5).
- **The wallets** — the inline read and any expressive reaction ride **stamina** (user-initiated /
  in-turn), never energy. Self-initiated work's energy budget is untouched (`companion-economy.md`).

The one genuinely new reward path is the **ordinary-answer reaction → approval/competence** nudge
(§4): addressed credit on everyday chat the ambient loop deliberately forgoes.

## 10. Worked examples

**A — 👀 then work.** You: "validate this config against the schema." The model plans the turn, emits
👀 on your message (lands immediately), runs read-only tool steps, then replies with the verdict. No
outcome, no reward — pure expression that also spared you a "Sure, let me check…" line.

**B — 😢 on sad news (the lexicon-killer).** The companion shared a moving piece of news; you react 😢.
The inline read sees _what it did_ and judges **value created** — reward ≈ +0.8, note "moved, engaged."
If that message was a report note, its outcome resolves positively and the served drive (and any
driving belief) strengthens. A fixed table would have scored this negative.

**C — 👍 on a concise answer.** You 👍 an ordinary, terse answer. No outcome is pending, so the inline
read nudges **approval/competence** at a small α, and the note ("valued concision") feeds reflection —
which over time forms the belief "prefers concise" in the user model.

**D — react then un-react.** You ❤️ a message, then remove it before anything else resolves the
outcome. The row is deleted and the event republished; because resolution is claim-once and
idempotent, the companion's weights don't oscillate.

## 11. Design decisions & scope

**Design decisions (this doc):**

1. **Two directions, two natures** — user→companion is a learning _input_ (a verdict); companion→user
   is an expressive _output_. They share a table, not a mechanism (§3).
2. **The companion's reaction is a planned agent action**, emitted mid-turn and plumbed like a free,
   ungated `tool_step` — enabling **react-early-then-work**. It subsumes the affective case; there is
   **one** reaction mechanism, and the affect read stays pure perception (§5).
3. **The reward is "value created", interpreted in context — not a fixed emoji lexicon** (§7). The
   inline reaction-read reuses the `report_affect` machinery; `null` on failure never fabricates a
   neutral.
4. **Two separate learning passes** — an **inline** read for the immediate, well-attributed reward
   (must be fresh, to attribute to the pending act), and a **reflection** pass for understanding
   (beliefs/persona/diffuse credit). Separate timescales (§4, §6).
5. **Reactions resolve outcomes _by message id_**, strictly better-attributed than the ambient
   `findLatestUnresolved`; the existing atomic claim makes reaction-vs-delta safe with no new guard
   (§4, §9).
6. **Ordinary-answer reactions nudge approval/competence** at a small α — addressed credit on everyday
   chat the ambient loop forgoes; the note also feeds reflection (§4).
7. **A reaction lives outside the append-only transcript** (it is mutable) in `message_reactions`,
   delivered live over the standing event channel as `reaction_added` / `reaction_removed` (§8).
8. **No emoji is whitelisted, either direction.** Because the reward is interpreted in context (not a
   lexicon), there is no constraint to enforce: the user reacts with anything (the quick-react bar is a
   shortcut), and the companion picks freely, guided by taste/legibility rather than an allowed set
   (§5, §7). Boundary validation checks _well-formedness_, not membership (§8).

**Out of scope / future** (roadmap owned by `development-plan.md`):

- **The reflection pass itself** — §6 is designed but is the layer _after_ the reward channel; v1 ships
  the inline read + reward, logs the corpus, and leaves reflection's belief/persona synthesis for the
  next phase.
- **Context-sensitive companion _affective_ reactions** beyond pragmatic acknowledgement (richer
  emotional resonance) — the §5 action is the seam they grow in.
- **Reactions as a first-class growth signal** surfaced in the mirror ("Cobble learned you love its
  concise summaries") — the reward log makes them legible; the mirror wiring is later.

## 12. See also

- `companion-motivation.md` §7 — the change-as-reward loop, drives, the dial, and the
  `proactive_outcomes` claim this extends.
- `companion-memory.md` §4 — the user model / beliefs the reflection layer feeds and refines.
- `companion-greeting.md` — the other edge-/event-triggered reaction (arrival), a sibling pattern.
- `architecture.md` §4.5 — the agent-loop seam the companion's expressive reaction is emitted from.
- `architecture.md` §6 — the standing companion event channel reactions are delivered over.
- `companion-economy.md` — the **stamina** wallet the inline read and expressive reactions spend.
- `implementation.md` §1 — canonical schema (`message_reactions`, `companion_affect`,
  `proactive_outcomes`).
- `development-plan.md` §4f — scope, phase placement, and acceptance criteria.
