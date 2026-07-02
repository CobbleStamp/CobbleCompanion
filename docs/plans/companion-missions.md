# CobbleCompanion — Missions (goal-driven, long-running tasks)

> **Status: Tools half shipped; companion half not started.** This doc captures the *finalized*
> design for giving the companion a **mission**: a long-running, complex, goal-directed task it
> plans, executes in loops with validation criteria, and reports on — for days or weeks until told to
> stop. Worked example throughout: *"monitor LITE; alert me on Discord if it drops below $810;
> meanwhile track news (options expiry, CPI/PCE, Fed, earnings, deals) and report findings and
> predictions."*
>
> **Build status (2026-07):**
> - ✅ **Shipped (`Tools`):** `scheduler` (single-instance, loopback REST, poll-until-condition),
>   `scheduler-cli` (binary `schedule`), `ibkr-cli query` (the `{status,message}` predicate),
>   `discord-notify` (action CLI). See `Tools/scheduler/docs/`.
> - ✅ **Tools side complete — no new binary.** The mission wake **reuses `discord-notify` as-is**
>   (decision 2026-07). See §3.1.
> - ⬜ **Not started (companion):** the Discord **trigger intake**, `MissionService`, the
>   `mission.*` / `mission.advance` WS methods, the `missions` schema.
>
> **Finalized decisions:**
> 1. **Wake transport = a Discord *channel* message + summon.** The scheduler's `discord-notify`
>    action posts a plain-text trigger (a bot @-mention + the event text) into a shared **mission
>    channel**; the companion's always-on bot receives it (§3.2). *Not* an inbound HTTP endpoint (an
>    earlier draft's plan), and *not* a DM (bots can't DM bots).
> 2. **The trigger runs as an ordinary user-loop turn — no separate "mission Initiator."** User input
>    and a scheduled trigger are the *same kind* of input to the one agent loop; only the source
>    differs (decision 5 unifies them).
> 3. **Mission mode is exclusive.** While a mission is `active`, the drive engine / all proactive
>    behaviour is **suspended**; the companion serves only the mission (plus your direct chat). One
>    active mission at a time.
> 4. **State = a first-class `MissionService`** (mission record + append-only journal + lifecycle),
>    not transcript-only.
> 5. **Reports ride the embodied surface (ungated); no standing grant in v1.** A read-only mission
>    reports by *speaking in its room*, which is not a propose→approve tool call (§4).
> 6. **Stamina-billed, surface-coupled, disruptive — by design.** The turn runs via the Discord
>    bridge as the real user (→ **stamina**), the mission lives on the Discord surface, and a trigger
>    **supersedes** whatever surface you're on (accepted, §3.3).
>
> **Milestone available today (alert-only):** `scheduler` → `discord-notify --user <you>` DMs you
> directly, **no companion involved** — a shippable smart-alarm and a useful stepping-stone, but *not*
> the mission (no reasoning/prediction). The full mission needs the companion half below.
>
> **Each fact lives in one place.** This doc owns the **mission concept, the wake transport, and the
> seams each piece touches.** It references (does not redefine) the agent loop (`architecture.md` §4),
> the Discord surface (`companion-discord.md`), the motivation engine (`companion-motivation.md`), the
> vitality wallets (`architecture.md` §4.8), and the shipped scheduler (`Tools/scheduler/docs/`).

---

## 1. Why missions are a new thing

The companion today is a **creature driven by drives** — curiosity, bond, helpfulness — arbitrated
homeostatically (`companion-motivation.md`). A drive is "what it *wants*"; the tick is single-shot,
idle is valid, and self-initiated work only ever **reads into its own memory**.
`companion-motivation.md` §10 explicitly defers "a stronger sense of **purpose/agenda** — goals the
companion pursues." A **mission** is that deferred thing: an **externally assigned, persistent,
terminating objective with success criteria** — "what it was *told* to finish."

| | Drive | Mission |
|---|---|---|
| Origin | Intrinsic (seeded + learned) | Assigned by the user |
| Lifetime | Always present | Created → runs → stopped/complete |
| Goal | None — homeostatic need | Explicit objective + validation criteria |
| Idle | A valid outcome | A failure to make progress |
| Actions | Read into own memory only | Reads + reports (outward) within its room |
| Cadence | Lazy tick / arbitration | Event-driven (a fired predicate) or you messaging |

Missions are **a second kind of motivation**, but realized as an **exclusive mode**, not a competing
initiator (decision 3): while a mission is `active` the **drive engine is suspended**, so a paid
mission is never preempted by curiosity and never pollutes the learned drive weights. And a mission is
**input-driven, not proactively-initiated** (decision 2): each mission turn is an ordinary agent-loop
ENTRY (`architecture.md` §4.1) — the *same kind* a user message produces — triggered by an input,
whether that input is **you typing** or a **scheduled trigger** (§3.2). There is therefore **no
separate "mission Initiator"** to build; `MissionService` owns the mission *state and reasoning*, and
the agent loop it already runs does the rest.

## 2. Design principle — push the cheap, deterministic work *out*

The expensive resource is the LLM. Polling a price every second for weeks is **cheap and
deterministic**; reasoning about what a Fed announcement means for LITE is **expensive and fuzzy**.
Split on that line:

- **Outside the companion (`Tools`):** the clock and the predicate. The **`scheduler`** service runs
  deterministic CLI checks at high frequency and emits a signal **only when something happens** (the
  predicate reports `status:true`). No LLM, no companion tokens, no companion code.
- **Inside the companion:** the goal, the plan, the judgment, the report. The LLM runs a turn **only
  on an input** — you typing, or a scheduled trigger — so weeks of monitoring cost tokens only when
  there is something worth thinking about.

Same economics as the ingestion pipeline (read everything, emit almost nothing, `architecture.md`
§4.8), applied to time.

## 3. The actors and the wake path

```
  TOOLS  (knows nothing about the companion — Tools/scheduler/docs/)
  ────────────────────────────────────────────────────────────────────────────────
  scheduler-cli ──run──▶ scheduler ──poll every interval──▶ ibkr-cli query LITE le 810
  (companion equips it)  (loopback REST,                     → { status, message }
                          poll-until-condition)
                                   │  on a notify decision, run the job's ACTION cli
                                   ├──────────────────────────────┐
                                   ▼ (mission wake)                ▼ (alert-only milestone)
              discord-notify --channel <missionCh>        discord-notify --user <you>
                 --text "<@companionBot> {{message}}"             │ bot DM
                         (same binary, plain-text post)           ▼
  ═════════════════════════════════│═══════════════════    your DM (no companion)
  DISCORD  #mission-channel  ◀──────┘  <@companionBot> LITE is 808.10 — −3.1% on the session
                                   │  (both the scheduler bot and the user's companion bot are here)
  ═════════════════════════════════▼════════════════════════════════════════════════
  COMPANION  (packages/discord + core)
   always-on bot gateway receives the channel msg
     → allowlisted-sender check (trust) + mission_id (routing)
     → summon if not embodied  (supersedes web — accepted)
     → mission.advance({ event })  ── ordinary user-loop turn, stamina-billed
        → MissionService: load goal/plan/journal + event → reason (tools) → report in room
        → append to journal · re-arm or complete
                                   │
                                   ▼
                         report spoken in the embodied room (your DM by default) — ungated
```

### 3.1 Tools side — the scheduler (shipped) + `discord-notify` as the action (shipped)

Poll-until-condition, not a standing watch: a job **terminates on first `status:true`**, so there is
no edge-trigger/cooldown problem. Canonical docs: `Tools/scheduler/docs/`. **The Tools side is
complete: the mission wake needs no new binary — it reuses the shipped `discord-notify`.**

- **`scheduler`** (shipped) — single-instance loopback REST service; API + poll loop + embedded
  SQLite in one process. A **job** = predicate CLI + interval + action CLI + recurrence bounds. Each
  tick reads `{status,message}`, runs the action when `message` is non-empty, terminates on
  `status:true`. Durable (persist-before-deliver, action-gated deletion, at-least-once, retry →
  `failed`). Trust = loopback + binary allowlist; no-shell; `{{message}}` substituted as one argv
  element.
- **`scheduler-cli`** (shipped, binary `schedule`) — the companion equips it as a CLI tool: `run` /
  `list` / `get` / `cancel` / `pause` / `resume`.
- **`ibkr-cli query`** (shipped) — the predicate; `query LITE le 810` prints `{status,message}`; the
  CLI authors the human-meaningful `message`.
- **`discord-notify`** (shipped) — the mission's **action CLI, unchanged**. The companion registers it
  as the job's action with the companion bot @-mentioned and `{{message}}` spliced in as **plain
  text** (no structured JSON, so no `{{message}}` escaping hazard; v1 carries the event only and
  routes by the single active mission — see §3.2). Registered by the companion as:
  ```
  schedule run --every 1s \
    --predicate "ibkr-cli query LITE le 810" \
    --action    "discord-notify --channel <missionCh> --text <@companionBotId> {{message}}"
  ```
  *(Decision 2026-07: plain text + the mention is sufficient for v1's single active mission, so
  `discord-notify` covers the wake with zero new Tools code — no dedicated wake binary and no
  structured JSON payload. Multi-mission later routes by one channel per mission, not by a structured
  `mission_id`.)*

### 3.2 The wake transport — Discord channel + summon

The scheduler's `discord-notify` action posts to a **shared mission channel** that both the
**scheduler bot** and the **user's companion bot** are members of. The companion's bot gateway is
**always on** (one bot per user, PR #26), so it receives the channel message regardless of embodiment.
Three companion-side changes make the shipped Discord surface accept it — none a platform blocker, all
in `packages/discord`:

1. **Add the `GuildMessages` intent** (`discord-js-gateway.ts`) — without it Discord delivers **no**
   channel-message events to the bot (a mention does not override this).
2. **A new guild-message path** — today the handler drops `message.author.bot || message.guildId` and
   only emits `onDirectMessage`. Add a guild branch that accepts a message **only** from an
   **allowlisted trigger sender in the mission channel**, and emits a new *trigger* event. Everything
   else stays dropped; the **DM owner-lock is untouched**.
3. **Route as trigger-only authority** — a new router path, distinct from `onOwnerMessage` /
   `onOwnerCommand`. The scheduler bot can *only* fire a mission trigger; it can **not** act as the
   owner (chat, `/summon`, `/stop`).

**Two authorities, kept separate:**

| Authority | Who | May do |
|---|---|---|
| **owner** (existing, unchanged) | the human's Discord account, via DM | chat, owner commands, summon/stop |
| **trigger sender** (new) | allowlisted scheduler-bot id, in the mission channel | *only* fire a mission trigger |

**Trust vs. routing vs. content:**
- **Trust** = `author.id` is the allowlisted trigger bot **and** it's the mission channel — stored in
  the per-user `discord_config` row. *Not* the message content (anyone in the channel could type it).
- **Routing** = the companion routes the event to its **single `active` mission** (one at a time,
  §1). No `mission_id` is carried in v1. Future multi-mission routes by **channel** — one mission
  channel per mission (`mission_channel_id` on the mission record), so plain text still suffices.
- **Content-readability** = the message @-mentions the **companion bot**, which delivers full
  `.content` without the privileged `MessageContent` intent. (Alternatively, enable `MessageContent`.)

**Trigger payload** — `<@companionBot>` + the event text as **plain text** (the companion strips the
leading mention; the remainder is the event):
```
<@companionBot> LITE is 808.10 — −3.1% on the session
```
v1 carries the `event` only (the predicate's `message` verbatim). Plain text, not JSON — so there is
no `{{message}}` escaping hazard. Deferred (need the scheduler to expose `{{status}}` / `{{job_id}}`
tokens, and would reintroduce a structured payload): `status`, `job_id`, `fired_at`.

**Durability gap (accepted, with a v1 mitigation).** Scheduler→Discord is durable, but
Discord→companion is **not**: if the companion worker is down when the message posts, Discord does not
redeliver it and the trigger is lost. (The rejected inbound-endpoint path *was* durable via the job
lease.) **v1 mitigation:** on reconnect/startup the bot **fetches recent unprocessed mission-channel
messages and replays them**, so a worker restart doesn't silently drop a trigger; the mission's
periodic re-check job is a second backstop.

### 3.3 Summon-if-dormant

On a trigger, if the companion is **not currently embodied**, the bridge **summons programmatically**
(`bridge.summon()` force-claims embodiment, newer ULID wins). This **supersedes** any other surface
(e.g. web) — **disruptive by design, accepted** (decision 6). The companion then **stays embodied**
for the mission's duration, so subsequent triggers and reports are immediate with no re-summon churn.
The supersede/fencing machinery already handles a mid-turn takeover (`embodiment-handoff-fencing.md`),
so there's no new race. *(Minor wiring: `summon` is reached only via the `/summon` command today; the
trigger path needs the same logic callable programmatically — a small refactor.)*

### 3.4 The companion side — `MissionService`

**Data model (Postgres, per-companion):**
- **`missions`** — `id`, `companion_id`, `goal`, `plan`, `validation_criteria`, `status`
  (`draft`→`active`→(`paused`)→`complete`/`stopped`/`failed`), `job_ids` (scheduler jobs, for
  re-arm/cancel), `report_channel`, `outward_grant` (deferred, §4), timestamps.
- **`mission_journal`** — append-only, one row per turn (findings, prediction, decision). This gives
  **cross-day continuity**: each trigger, the companion recalls "what I concluded last time" without
  scanning the whole transcript.

**Creation — plan, approve, activate.** `mission.create(goal)` runs a normal turn that **decomposes**
the goal into `plan` + `validation_criteria` + the scheduler job(s) + the report target, then shows
that plan to the user as a **proposal** (reuse propose→approve — a start-gate for a long-running,
token-spending task). On approval the service: registers the job(s) via `scheduler-cli` (action =
`discord-notify --channel <missionCh> --text "<@companionBot> {{message}}"`), records `job_ids`, sets
`status=active`, and **suspends the drive engine**.

**The mission turn (on-input).** Fired by a trigger *or* you messaging — handled identically. The
bridge calls a companion-scoped **`mission.advance({ event })`** WS method (routed to the single
`active` mission); the harness:
1. **loads mission context** — a new memory-retrieval arm (invariant #3) injects `goal` + `plan` +
   recent `mission_journal` + the incoming `event`;
2. **reasons** — pulls news (`ibkr-cli`, web fetch), analyzes against the criteria, recomputes the
   prediction;
3. **reports** — the turn's output is spoken in the embodied room (§4);
4. **updates** — appends to `mission_journal`; if `validation_criteria` met → `complete` (cancel jobs,
   re-enable drives); else **re-arm** the fire-once scheduler job if monitoring continues.

**Lifecycle (WS methods + Discord slash commands):** `mission.create` · `mission.list` ·
`mission.pause` (pause scheduler jobs) · `mission.stop` (cancel jobs, `status=stopped`, re-enable
drives). `complete` is the internal success path with the same cleanup.

**Drive-engine suspension.** One gate in the motivation tick: *if this companion has an `active`
mission → idle.* Drives resume when the mission leaves `active`. Ordinary chat still works throughout.

## 4. Reporting & outward actions (no v1 grant)

**Reporting is the companion *speaking in its embodied room* — not a gated tool call.** The
propose→approve gate (`architecture.md` §4.4) fires on effectful *tool calls* (`send`/`pay`/`book`).
A mission turn's report is just its output, which the bridge posts to its room, exactly like a normal
reply or the wired proactive DM. No `beforeToolCall`, no gate, no grant. And a v1 mission is
**read-only** end to end (`ibkr-cli` read-only + web fetch + speak), so there is **no effectful
outward tool for a grant to authorize.**

**Report target:** the **user DM** (the embodied room, per PR #26) by default — zero new code,
ungated. If you want the single-channel view (trigger *and* report in the mission channel), extend the
bridge to also post to that channel as embodied output (still "speaking," still ungated) — *not* by
calling `discord-notify` as a tool, which would drag in the gate. Vitality rides along: the report
includes "stamina left: …, top up soon."

**The standing grant, defined but deferred.** When a future mission uses a genuinely
outward/effectful tool (place an order, send email, post where it isn't embodied): mission creation
mints a scoped grant `{ tool, target, rate-limit }`; the `beforeToolCall` gate allows
*origin=mission ∧ within-grant* without per-call approval, else holds/denies; revoked on stop. No v1
mission triggers it.

## 5. Execution properties (the honest list)

1. **Exclusive mode** — drive engine suspended while `active` (decision 3); ordinary chat unaffected.
2. **Stamina-billed** — the turn runs via the bridge as the real user, an ordinary user-loop turn, so
   it spends **stamina** (`architecture.md` §4.8). Matches the "it's user-initiated, put it in the
   user loop" framing. "Pre-top-up enough" applies for a weeks-long run.
3. **Surface-coupled & disruptive by design** — the mission lives on the Discord surface; a trigger
   supersedes whatever surface you're on (decision 6, accepted). Opening web mid-mission is superseded
   again on the next trigger.
4. **Not durable across a companion-worker outage** — mitigated by fetch-recent-on-reconnect (§3.2).
5. **State is first-class** — `missions` + `mission_journal` (§3.4), so `list`/`stop`/status and
   cross-day continuity are real, not reconstructed.

## 6. What changes, by repo

| Repo / package | Change | Status |
|---|---|---|
| `Tools/scheduler` + `scheduler-cli` | poll-until-condition service + thin client | ✅ shipped |
| `Tools/ibkr-cli` | `query` predicate (`{status,message}`) | ✅ shipped |
| `Tools/discord-notify` | action CLI (DM/channel) — **is the mission wake too**: `--channel <missionCh> --text "<@bot> {{message}}"` | ✅ shipped, no change |
| `packages/discord` | `GuildMessages` intent; guild trigger path (allowlisted sender, trigger-only authority); programmatic `summon`; fetch-recent-on-reconnect | ⬜ |
| `packages/db` | `discord_config` += `trigger_bot_id` + `mission_channel_id`; `missions` + `mission_journal` tables | ⬜ |
| `packages/core` | `MissionService` (record, planner, `mission.advance` handler, mission-context memory arm, lifecycle); **drive-engine suspension gate** | ⬜ |
| `packages/api` | `mission.*` + `mission.advance` WS methods | ⬜ |
| `packages/shared` | mission + trigger contracts | ⬜ |

## 7. v1 scope

**Milestone 0 — alert-only (shippable now):** `scheduler` + `ibkr-cli query` + `discord-notify --user`
→ you're DMed when LITE crosses the threshold. No companion code. Proves the Tools spine end-to-end.

**Milestone 1 — the mission (the real goal):** *monitor LITE, wake the companion on the threshold,
have it reason and report, keep monitoring until stopped.* **No Tools work — all companion:**
1. **`packages/discord`:** `GuildMessages` intent + guild trigger path (allowlisted sender,
   trigger-only authority) + programmatic summon + fetch-recent-on-reconnect.
2. **`packages/db` + `packages/shared`:** `missions`/`mission_journal` schema, `discord_config`
   additions, contracts.
3. **`packages/core`/`packages/api` — `MissionService`:** planner + start-approval; `mission.advance`
   (load → reason → report → re-arm); `create`/`list`/`stop`; drive suspension; vitality in reports.

See `plans/missions-implementation-plan.md` for the step-by-step build plan and verification gates.

**Deferred:** the continuous news-ingest + CPI/PCE/Fed/earnings + swing-prediction depth (the fuzzy,
larger half); a dedicated mission budget; the standing outward-grant (until an effectful-tool
mission); the scheduler `{{status}}`/`{{job_id}}` tokens; richer cron schedules; **multiple concurrent
missions** (which would reintroduce explicit `mission_id` routing — solved then by one channel per
mission).

> **Self-paced cadence needs no new mechanism.** A mission that should wake on its *own clock* (e.g.
> "review the news every 6 h") just registers a **recurring scheduler job** whose predicate always
> emits a message — firing the same trigger on that cadence. The scheduler *is* the companion's
> external clock (consistent with decision 2, no internal initiator).

## 8. References

- Discord surface (DM/owner-lock/bot-filter/intents/proactive/embodiment) — `companion-discord.md`,
  `packages/discord/src/{gateway/discord-js-gateway,router,bridge,proactive}.ts`
- Agent loop, propose→approve, vitality wallets — `architecture.md` §4.1, §4.4, §4.8
- Embodiment fencing / supersede — `companion-discord.md` §4, `plans/embodiment-handoff-fencing.md`
- Drive-based motivation (what missions suspend) — `companion-motivation.md`
- Tool acquisition (how `scheduler-cli` / `ibkr-cli` / `discord-notify` plug in) — `companion-tools.md`
- Shipped scheduler (poll-until-condition, `{status,message}`, trust) — `Tools/scheduler/docs/`;
  predicate — `Tools/ibkr-cli/docs/api-reference.md` (`query` mode)
