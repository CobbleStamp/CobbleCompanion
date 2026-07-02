# Missions — Implementation Plan (Milestone 1)

> **Companion doc, working artifact.** This is the *how/what-order* build plan for the mission
> feature. The *design* is owned by [`companion-missions.md`](./companion-missions.md) — read it first; this plan does
> not redefine any decision, it sequences the work and pins the concrete changes.
>
> Scope = **Milestone 1** (the real mission: monitor LITE → wake the companion → reason & report →
> keep monitoring until stopped). **Milestone 0** (alert-only DM) needs *no new code* and is used
> below only as a setup smoke-test.
>
> Two repos: **`Tools`** (`~/repositories/Tools`, Go, standalone single-purpose CLIs) and
> **`CobbleCompanion`** (TypeScript). **Decision (2026-07): the Tools side needs no new binary and no
> change — the mission wake reuses the shipped `discord-notify` CLI as-is.** All new work is in the
> companion.

---

## 0. What is already shipped (do not rebuild)

| Piece | Repo | State |
|---|---|---|
| `scheduler` (loopback REST, poll-until-condition, SQLite, durable delivery) | `Tools/scheduler` | ✅ |
| `scheduler-cli` (binary `schedule`: run/list/get/cancel/pause/resume) | `Tools/scheduler-cli` | ✅ |
| `ibkr-cli query` (`{status,message}` predicate) | `Tools/ibkr-cli` | ✅ |
| `discord-notify` (one text message → DM/channel, bot auth, 429 retry, redaction) | `Tools/discord-notify` | ✅ — **is the mission wake, as-is** |
| Discord surface (one bot/user, DM owner-lock, embodiment, proactive DM) | `packages/discord` | ✅ (PR #26) |

Verified mechanics this plan relies on:
- **`{{message}}` substitution is safe** — `scheduler/internal/runner/runner.go:165` replaces the
  token *per argv element* with no shell and no re-parse. `--text "<@bot> {{message}}"` delivers the
  predicate's raw message spliced after the mention, as one plain-text argv string.
- **Action binaries are allowlisted by absolute path** — `scheduler/internal/exec/executor.go`
  matches `argv[0]` against `SCHEDULER_ALLOWLIST` (`config.go`). `discord-notify` is already the
  allowlisted alert action, so the mission action adds nothing new to the allowlist.
- **`discord-notify` already posts a bot mention into a channel** (`internal/discord/client.go`
  `SendChannel`; confirmed live: `--text 'deploy finished <@1473…>' --channel …` renders the mention).

---

## 1. Tools repo — no change

The mission's action CLI **is `discord-notify`, unchanged.** No new binary, no new flags.

### 1.1 The scheduler action (what the companion registers)
```
schedule run --every 1s \
  --predicate "ibkr-cli query LITE le 810" \
  --action    "discord-notify --channel <missionChannelId> --text <@companionBotId> {{message}}"
```
`--text`'s value is one argv element: `<@companionBotId> {{message}}`. The scheduler substitutes
`{{message}}` (the predicate's message) into it, yielding the plain-text channel post.

### 1.2 Wire format (the contract with the companion — pin it here)
Message `content` posted to the mission channel is **exactly**:
```
<@COMPANIONBOTID> LITE is 808.10 — −3.1% on the session
```
- Leading token = a single user-mention of the companion bot, then a space, then the **event text**
  (the predicate's `message` verbatim). The companion strips leading mention token(s); the remainder
  **is** the event (§4.3).
- **Plain text, not JSON.** v1 carries the event only. No `mission_id` in the payload — routing is by
  the single active mission (§4.4). No JSON means no `{{message}}` escaping hazard.
- The mention is load-bearing twice: (a) Discord delivers full `.content` for a message that mentions
  the bot **without** the privileged `MessageContent` intent; (b) it is a human-visible "for you"
  marker in the channel.

### 1.3 Why plain text is enough for v1 (and scales)
- **One active mission at a time** is a finalized decision (`companion-missions.md` §3), so the companion routes
  the event to its single `active` mission — no explicit id needed.
- **Future multi-mission** routes by **channel**: one mission channel per mission, `mission_channel_id`
  on the mission record maps the inbound channel → mission. Plain text still works; structured payload
  is never required. (Deferred with "multiple concurrent missions", §10.)
- The scheduler `{{status}}` / `{{job_id}}` tokens (which a richer payload would want) remain deferred.

---

## 2. Companion — `packages/db`

- `discord_config` += **`trigger_bot_id`** (allowlisted scheduler-bot user id) + **`mission_channel_id`**.
- **`missions`** table: `id`, `companion_id`, `goal`, `plan`, `validation_criteria`, `status`
  (`draft`→`active`→(`paused`)→`complete`/`stopped`/`failed`), `job_ids`, `report_channel`,
  `outward_grant` (nullable, deferred), timestamps.
- **`mission_journal`** table: append-only, `id`, `mission_id`, `turn_at`, `findings`, `prediction`,
  `decision`.
- One forward migration in the version handler.

## 3. Companion — `packages/shared`

- Mission types: `Mission`, `MissionStatus`, `MissionJournalEntry`.
- **`TriggerEvent = { event: string }`** — the parsed event text from §1.2 (mention already stripped).
  No `mission_id` field in v1.
- WS method contracts: `mission.create` · `mission.list` · `mission.pause` · `mission.stop` ·
  `mission.advance({ event })`.

## 4. Companion — `packages/discord` (the wake intake)

Three changes named in `companion-missions.md` §3.2, plus reconnect-replay. **None touch the DM owner-lock.**

### 4.1 Intent
Add `GuildMessages` to the intent list (`discord-js-gateway.ts:60`). Without it Discord delivers **no**
channel-message events. Do **not** enable `MessageContent` — the mention (§1.2) already unlocks
content for our one message shape; keep the privileged intent off.

### 4.2 Guild-message branch
`discord-js-gateway.ts:65` drops `message.author.bot || message.guildId` today. **Verified seam
split** (the gateway is the untested integration boundary — keep it thin; trust/parse logic lives in
the router, which is unit-tested against `test/fake-gateway.ts` and imports only `@cobble/db`):
- **Gateway (thin):** for a guild message, emit a new `onGuildMessage({ authorId, channelId, content })`
  — the mirror of the existing `onDirectMessage`. No trust logic here. Thread the new handler through
  `gateway/types.ts` + `gateway/manager.ts` exactly like `onDirectMessage`.
- **Router (trust):** a new `handleGuildTrigger(ctx)` on `BotRouter` (sibling to `handleDirectMessage`)
  accepts **iff** `author.id === discord_config.trigger_bot_id` **and**
  `channelId === discord_config.mission_channel_id`, then calls an injected `onTrigger` handler with
  the parsed event. Everything else is dropped. The DM owner-lock (`router.ts:52`) is untouched.

### 4.3 Parse
Strip leading mention token(s) (`<@…>` / `<@!…>`) and whitespace; the remaining text **is** the event.
Validate at the boundary (non-empty after stripping); log-and-drop an empty/malformed message (never
throw into the gateway).

### 4.4 Route — trigger-only authority
New router path distinct from `onOwnerMessage` / `onOwnerCommand`. The trigger sender may **only** fire
a mission trigger — never chat, `/summon`, or `/stop`. **Trust = allowlisted `author.id` + channel**,
never the message content. Route the event to the companion's single `active` mission.

### 4.5 Summon-if-dormant
Refactor `bridge.summon()` so it is callable programmatically (today only reachable via the `/summon`
command). On a trigger with no active embodiment, summon (supersedes web — disruptive by design,
accepted). Existing supersede/fencing handles the race.

### 4.6 fetch-recent-on-reconnect (durability mitigation)
On gateway (re)connect/startup, fetch recent mission-channel messages and replay unprocessed triggers.
Dedupe against a persisted processed-message cursor (store last-processed Discord message id per
mission channel). Backstop for the non-durable Discord→companion hop (`companion-missions.md` §3.2, §5.4).
**New capability:** the gateway has no message-read method today (only `sendDirectMessage` /
`sendTyping` / `sendProposal` / `registerCommands`). Add a `fetchRecentMessages(channelId, sinceId)`
to the gateway interface (discord.js `channel.messages.fetch`) — the one genuinely new gateway method.

## 5. Companion — `packages/core` (`MissionService`) + `packages/api`

### 5.1 MissionService (core)
- **Repos**: `missions` + append-only `mission_journal`.
- **Planner / start-gate** — `mission.create(goal)` runs a normal turn that decomposes goal → `plan`
  + `validation_criteria` + scheduler job(s) + report target. **Verified reuse of the existing gate:**
  model mission activation as an **effectful tool** (e.g. `start_mission`, `effectful: true`, with a
  `proposalSummary` that renders the plan). The shipped `createApprovalGate` (`tools/gate.ts`) then
  holds it as a pending proposal and EXITs the loop; the existing Discord proposal card
  (`sendProposal` + confirm/reject buttons) approves it — **no bespoke approval surface**. On confirm,
  the tool body registers job(s) via the `scheduler-cli` tool (action = the `discord-notify …` line
  from §1.1), stores `job_ids`, sets `status=active`, and **suspends drives**.
- **`mission.advance({ event })`** — the single entry for both a trigger and you messaging:
  1. load context — **verified:** add a `mission-retrieve` arm to `composeRetrieveContext`
     (`harness/compose-retrieve.ts`, which already composes episodic/semantic/procedural/user-model
     arms into the single invariant-#3 hook); it injects goal + plan + recent journal + event;
  2. reason — `ibkr-cli`, web fetch, analyze vs. criteria, recompute prediction;
  3. report — turn output spoken in the embodied room (ungated, `companion-missions.md` §4); include vitality line;
  4. update — append journal; criteria met → `complete` (cancel jobs, resume drives) else **re-arm** the
     fire-once scheduler job.
- **Drive-suspension gate** — **verified:** one early-return in `MotivationEngine.tick()`
  (`motivation/engine.ts`), which already `return IDLE`s in several places. Inject a `MissionStore` into
  `MotivationEngineDeps`; if the companion has an `active` mission → `return IDLE`. Resume on exit from
  `active`. Ordinary chat is unaffected (it doesn't run through this engine).
- **Lifecycle** — `create` / `list` / `pause` (pause jobs) / `stop` (cancel jobs, `status=stopped`,
  resume drives). `complete` = internal success path with the same cleanup.

### 5.2 api
Register `mission.*` + `mission.advance` WS methods; wire the discord bridge's `onTrigger` →
`mission.advance`.

---

## 6. Build order & verification gates

**Setup (Milestone 0, config-only — do first to validate the Discord topology):**
Provision a Discord guild + `#mission` channel; invite the scheduler bot **and** the companion bot;
capture ids into `discord_config` (`trigger_bot_id`, `mission_channel_id`). Register a
`scheduler` → `ibkr-cli query` → `discord-notify --user <you>` job and confirm the DM alert. No new
code; proves the bot/token/allowlist wiring end-to-end. **The very same `discord-notify` binary then
becomes the mission wake by swapping `--user <you>` for `--channel <missionCh> --text "<@bot> {{message}}"`.**

| # | Step | Independently verifiable when… |
|---|---|---|
| 1 | **Register the mission action** (§1) — no code | `discord-notify --channel … --text "<@bot> {{message}}"` posts the exact §1.2 content to the channel |
| 2 | **`db` + `shared`** (§2, §3) | migration applies; contracts compile |
| 3 | **`packages/discord` intake** (§4) | that channel post → `onTrigger` fires → summon happens; owner-lock DM path unchanged |
| 4 | **`MissionService`** (§5.1) | `create` proposes a plan; on approve registers jobs + suspends drives; `advance` loads→reasons→reports→re-arms; `stop` cleans up |
| 5 | **`api` wiring** (§5.2) | trigger → `mission.advance` over WS; `mission.*` methods reachable |
| 6 | **Integration dry-run** | synthetic predicate fires immediately → companion summoned → reasons → reports in room → re-arms; then `stop` |

### 6.1 Status (2026-07)

**Shipped** (steps 1–5): `missions` + `mission_journal` schema and contracts (Phase 1); the Discord
mission-wake intake — `GuildMessages` intent, trust gate, mention-parse, summon-if-dormant, and
the companion bot's own id captured at ClientReady into `discord_config.bot_user_id` (Phase 2 +
3b.3a); `MissionService` + the drive-suspension gate + the mission-mode gate bypass + the
mission-retrieve arm (Phase 3); the `start_mission` effectful tool, the `scheduler-cli`-backed
`MissionScheduler`, the `mission.*` WS methods (`create`/`advance`/`list`/`stop`), the
`discord.config.setMissionWake` write path, and the full composition-root wiring (Phase 4).

**Deferred (not built):** step 6 end-to-end dry-run against a live scheduler + Discord guild;
fetch-recent-on-reconnect replay (§4.6, a durability backstop); auto-completion detection and
per-turn re-arm (the mission is armed as a recurring job and ends via the user's `mission.stop`).
The `MissionService.pause`/`resume`/`complete`/`fail` lifecycle methods exist but have no caller
yet — scaffolding for the deferred completion path.

## 7. Testing strategy

- **Tools** — none new. Regression-confirm `discord-notify --channel … --text "<@bot> …"` still posts
  and renders the mention.
- **Companion** — fakes over mocks: a **fake Discord gateway** emitting a trigger message, **in-memory
  DB**, a **fake `scheduler-cli`** tool. Unit-test: the §4.3 mention-strip/parse (including a message
  whose event text itself contains a `<@…>`-looking substring or leading spaces), the trigger-only
  authority gate (§4.4), the drive-suspension gate, and the `advance` state machine (complete vs.
  re-arm).
- **E2E** — Milestone-0 alert DM; Milestone-1 mission dry-run with an immediately-firing synthetic
  predicate.

## 8. Operational / config summary

- Env: **`SCHEDULER_DISCORD_BOT_TOKEN`** used by `discord-notify` (the scheduler bot). Unchanged.
- **`SCHEDULER_ALLOWLIST`** already contains `ibkr-cli` + `discord-notify`. **No additions.**
- `discord_config`: `trigger_bot_id` = scheduler bot user id; `mission_channel_id` = `#mission` id.
- Discord: guild + `#mission` channel; both bots invited; companion bot gains `GuildMessages` intent.
- **CLI-tool equipping (verified mechanism):** `scheduler-cli` is equipped by dropping a
  `TOOL.json`/`TOOL.md` folder under `CLI_TOOLS_PATH` (parsed by `api/src/cli/fs-tool-store.ts`; active
  only when `CLI_TOOLS_PATH` is set — `api/src/index.ts`). **Deployment prerequisite (not code):** the
  `scheduler` service must run on the companion's host (loopback) so `scheduler-cli` can reach it.
- `discord_config` lives in `@cobble/db` (`DiscordConfigStore`, already holds `ownerDiscordUserId` /
  `linkCode`) — the two new ids are columns there, populated via the settings/onboarding flow.

## 9. Open decisions

None outstanding for Milestone 1. The Tools structure question is resolved (reuse `discord-notify`
as-is). Topology/provisioning (§8) is treated as an assumption, not an open question.

## 10. Explicitly out of Milestone 1

Continuous news-ingest + CPI/PCE/Fed/earnings + swing-prediction depth; a dedicated mission budget;
the standing outward-grant (until an effectful-tool mission); scheduler `{{status}}`/`{{job_id}}`
tokens; richer cron schedules; **multiple concurrent missions** (which is what would reintroduce
explicit `mission_id` routing — solved then by one channel per mission, §1.3).
