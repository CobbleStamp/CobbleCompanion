# Implementation plan: Discord surface (bring-your-own-bot)

> **Status: proposed.** Spec drafted from a discovery interview; not yet
> implemented. This is the build plan for adding **Discord** as a new surface —
> a "living room" the companion can be summoned into (`docs/product-overview.md`
> §2). It changes **no `@cobble/core` code**: the Discord adapter is a decoupled
> module that talks to the companion only through the public WebSocket contract
> (`docs/companion-endpoints.md`), connecting as the real user (§11). The one
> backend addition is an isolated api route that mints the user's access token.

> **Scope.** One Discord bot **per user** (bring-your-own token). A user attaches
> a bot token to their CobbleCompanion account; the backend hosts that bot's
> gateway connection and bridges its DMs to that user's companion. The companion
> is **summoned** into the DM (explicit embodiment claim) and held until the user
> opens the companion elsewhere. Chat + read-only slash commands + approval
> buttons + gated proactive DMs. DM-only for the PoC.

## 1. The model in one paragraph

Each user pastes a **Discord bot token** into their account settings. The backend
runs a Discord gateway connection for that bot, bound to one of the user's
companions. The bot serves **only the owner's Discord account** (locked by Discord
user ID). The companion is not "in" Discord until the user runs **`/summon`**,
which makes the adapter open a WebSocket to `/ws` **as the real user** (§11) and
**claim embodiment** for that companion. While the claim is held (renewed by heartbeat,
"connected forever"), the user can chat in the DM and the companion can DM
proactively. The moment the user opens the companion anywhere else (e.g. the web
client), that surface force-claims and the adapter receives
**`embodiment.superseded`** (close `4002`); the bot posts a notice and goes dormant
until the next `/summon`. This maps one-to-one onto the existing ULID-lease
embodiment mechanics (`docs/plans/embodiment-handoff-fencing.md`,
`packages/core/src/embodiment/store.ts`).

## 2. Decisions (from discovery interview)

| Question | Decision |
|---|---|
| Audience | **One bot per user**, bring-your-own token. The token *is* the binding; no shared bot, no OAuth account-linking. |
| Who the bot answers | **Owner only** — responses locked to the owner's Discord user ID (allowlist is a later extension). |
| Embodiment coexistence | **Explicit summon, hold-until-superseded.** `/summon` claims; opening the companion elsewhere terminates the bot's claim; chatting without a claim returns "summon first." |
| On supersede | **DM a notice** ("I've stepped over to the web — `/summon` to bring me back here"). |
| Proactivity | **Yes, gated by the existing proactivity dial** (off/gentle/active). Proactive DMs only while summoned/embodied. |
| Approvals | **In-Discord embed + Confirm/Reject buttons** (going to web would supersede the bot, so approvals must be self-contained). |
| Reply style | **Typing cue + single final message** (Discord is rate-limited and not built for token streaming). |
| Slash commands at launch | `/memory`, `/recall`, `/activity`, `/episodes`, `/growth`, `/budget`, `/feed`, `/reading` — all of them. |
| Runtime | **In-backend host, encrypted token at rest**, but as a **decoupled module** that imports nothing from `@cobble/core` and speaks only the public WS contract. |

## 3. Architecture & module boundary

The adapter is a new package (proposed `packages/discord/`) with a hard rule:
**it depends on `@cobble/shared` (contracts) and the public `/ws` endpoint only —
never on `@cobble/core`.** It is "just another surface," exactly like
`packages/web`. This preserves the core↔surface boundary
(`docs/architecture.md` §2).

Two responsibilities inside the module:

1. **Gateway manager** — owns the set of live Discord bot connections (one per
   configured user). Reads each user's token from the adapter's own encrypted
   config store. Routes inbound Discord events (DMs, slash commands, button
   clicks) to the right per-user bridge.
2. **Bridge (per summoned user)** — a WebSocket client to `/ws?
   access_token=<user_access_token>&companion=<id>`, connecting **as the real
   companion-owning user** (auth below). Translates Discord ↔ WS:

| Discord action | WS method / event |
|---|---|
| DM message (while summoned) | `messages.send` (streaming) |
| `/summon` | open WS with `?companion=<id>` → await `embodiment.ready`; optionally `greeting.stream` |
| `/status` | `embodiment.whoami` (is this connection the holder?) |
| `/memory` | `memory.snapshot` |
| `/recall <query>` | `memory.search` |
| `/activity` | `activity.list` |
| `/episodes [query]` | `episodes.list` / `episodes.search` |
| `/growth` | `growth.get` |
| `/budget` | `budget.get` |
| `/feed` | `food.get` (list) → `feed` (apply) |
| `/reading` | `leads.list` |
| Proposal arrives (stream `proposal` / push) | render embed + buttons |
| Confirm button | `proposals.confirm` (streaming) |
| Reject button | `proposals.reject` |
| Proactive companion `message` event | DM the user (gated by dial) |
| `embodiment.superseded` (4002) | DM supersede notice; mark dormant |

**Auth — connect as the real user (§11).** Service-token auth would namespace the
bridge as a *separate* `(service, client_id, external_id)` user that doesn't own
the companion (`ensureUserByClaim`, `packages/core/src/identity/store.ts`) — the
handshake would 404. Instead the bridge connects with a short-lived **app access
token for the real user** (`?access_token=…`), verified by the existing
app-access-token verifier (`CompositeVerifier` browser path,
`packages/api/src/auth/jwt-verifier.ts`) — **no `@cobble/core` change**. The token
is minted by a new **internal API endpoint** (`mintAccessToken`,
`packages/api/src/auth/session-tokens.ts`) that the worker calls with a Discord
**service credential** (`service_registry`); the endpoint mints only for a `userId`
with a `discord_config` row, and `ACCESS_TOKEN_SECRET` never leaves the API.

## 4. Embodiment lifecycle (the heart of it)

- **Dormant** — bot is online on Discord (gateway connected) but holds **no**
  WS connection / no embodiment. DMs that aren't `/summon` get: *"I'm not here
  right now — `/summon` to bring me into this chat."*
- **`/summon`** — adapter opens the WS (as the real user, §11) with `?companion=<id>`,
  which force-claims embodiment (newer ULID wins). On `embodiment.ready` it
  replies (and may stream a greeting via `greeting.stream`). Claim is renewed by
  the WS heartbeat indefinitely — the "connected forever" behaviour.
- **Active** — DMs route to `messages.send`; proactive `companion` events DM the
  user; proposals surface as embeds.
- **Superseded** — user opens the companion elsewhere → that surface claims →
  adapter gets `embodiment.superseded` then close `4002`. Adapter DMs the notice
  and returns to **Dormant**.
- **`/status`** — reports Active vs Dormant via `embodiment.whoami`.

This requires **zero new embodiment logic** — it reuses the claim/supersede/
heartbeat machinery already proven for the web client.

## 5. Chat reply rendering

On a DM, the bridge calls `messages.send` and consumes the `ChatStreamEvent`
stream server-side:
- `composing` → trigger Discord **typing indicator** in the DM channel.
- `token` / `citations` / `tool_step` → buffer (not rendered live).
- `done` → post **one** message with the full reply; fold citations and notable
  tool steps into an embed footer/fields.
- `error` → post a friendly error; if it's `over_cap` (stamina exhausted), nudge
  *"I'm tired — `/feed` me to continue."*
- `reflection` → optional secondary line.

## 6. Proactive DMs

While Active, the bridge subscribes to `companion` `message` events. Companion-
initiated (autonomous) messages are DM'd to the owner, **gated by the proactivity
dial** (`proactivity.set`; off = none). The arrival greeting fires on `/summon`.
Quiet-hours is a possible later refinement.

## 7. Security & token storage

- **Token at rest:** encrypted (never plaintext on disk / never `SharedPreferences`
  equivalent), per global security rules. The adapter owns a small config store:
  `{ userId, encryptedBotToken, boundCompanionId, ownerDiscordUserId, proactivity }`.
- **Owner lock:** every inbound Discord event is checked against
  `ownerDiscordUserId`; anything else is ignored. The owner ID is captured via a
  one-time **`/link <code>`** handshake (code shown in web settings) so we never
  trust "first DM wins."
- **Backend auth (§11):** the bridge connects to `/ws` as the **real user** with a
  short-lived app access token minted by an internal API endpoint; the worker
  authenticates to that endpoint with a Discord service credential
  (`service_registry`) and never holds `ACCESS_TOKEN_SECRET`.
- **No secrets in logs:** bot tokens, the service secret, and minted access tokens
  are never logged; errors logged with context per `logging.md` (operation, userId,
  companionId — no token).

## 8. Configuration surface

A small settings panel in the web client (or a REST/WS config method owned by the
adapter) lets the user: paste the bot token, pick the bound companion
(`companions.list`), see the `/link` code, and set the Discord proactivity
preference. Writing the token (re)starts that user's gateway connection.

## 9. Build plan (file-level, vertically sliced)

Each task is one **complete vertical path** (Discord I/O → bridge → WS → render),
not a horizontal layer, and is independently green (typecheck + its own tests).
Dependencies are explicit. Testing follows the repo rule **fakes over mocks**:
fake the Discord gateway (`discord.js` `Client`) behind a small interface and use a
**real `/ws`** (local API + Postgres) for bridge integration — don't mock the wire
contract.

**Dependency graph**

```
T1 ──▶ T3 ──▶ T5 ──▶ T6 ──▶ T7 ──▶ T8 ──▶ T9 ──▶ T10
T2 ─▶ T2b ─┘   T4 ─┘                       │      └─▶ T11
              (T2b needs T3)               └─▶ T12
                                       T13 (parallel, needs T5)
```

### Phase 0 — Foundations

**T1 — Scaffold `packages/discord/` + WS client** *(blocks all)* — **✓ built**
- Done: `packages/discord/{package.json,tsconfig.json,vitest.config.ts}` (deps
  `@cobble/shared`, `ws`; dev `@types/ws`, `typescript`, `vitest`), and an
  **auth-agnostic** `packages/discord/src/ws-client.ts` (`WsTransport` taking
  `{url, headers, embodying}`; demux `{id,result}` / `{id,error}` / `{id,stream}` /
  `{event,data}`; `call`/`callStream`/`onEvent`; `embodiment.ready` gating;
  `SupersededError` / `ConnectionClosedError`), `src/index.ts`. `@cobble/db` and
  `discord.js` are added by their tasks; the worker entrypoint lands in T6 (nothing
  to run before then). `packages/*` already covers the package.
- AC met: `pnpm --filter @cobble/discord typecheck` green; **10 fake-socket unit
  tests** green (connect, `ping`/`auth.me` round-trips, error reject, streaming,
  embodiment-ready gating, superseded, mid-flight close); prettier-clean.
- Remaining (task #4, deferred): a live `*.integration.test.ts` against a real
  `/ws`. It can **self-mint** a user access token (`mintAccessToken` + the test
  `ACCESS_TOKEN_SECRET`) — it does **not** need T2b. Needs the api app + Postgres
  harness, so it's sequenced after more bridge exists.

**T2 — Register the Discord service client** *(supports T2b)*
- Action: `pnpm --filter @cobble/db service add discord-adapter "discord"` →
  prints the secret once. Boot-seed via `seedCredentials` for dev. This credential
  authenticates the worker **to the internal mint endpoint (T2b)** — not to `/ws`
  directly (the bridge connects to `/ws` as the real user, §11).
- AC: the seeded client authenticates against T2b; secret sourced from env, never
  hardcoded.
- Verify: `pnpm --filter @cobble/db service list` shows the row.

**T2b — Internal token-mint endpoint** *(needs: T2, T3; api-side)* — §11 auth decision — **✓ built**
- Done: `packages/api/src/routes/discord.routes.ts` (`POST /internal/discord/token`),
  registered in `app.ts` (a no-op unless `DISCORD_SERVICE_CLIENT_ID` is set), with
  `discordServiceClientId` config + a `discordConfig: DiscordConfigStore` dep wired
  into `app.ts`/`index.ts`/`test/helpers.ts`. The target user is carried in
  `X-User-Id`; the route pins to the Discord service client, requires a
  `discord_config` row, looks up the email, and mints via `mintAccessToken`. 6 route
  tests (happy path verified with the real `AppSessionVerifier`; no-config→403, wrong
  client→403, bad secret→401, browser token→403, disabled→404). `/internal` added to
  `API_PREFIXES`.
- Original sketch follows:
- Files: a new route in `packages/api` (e.g. `POST /internal/discord/token`) that:
  authenticates the caller via the Discord **service credential** (the existing
  `ServiceTokenVerifier` / `service_registry`); accepts a `userId`; **authorizes**
  it only if a `discord_config` row exists for that user; returns a short-lived
  access token via `mintAccessToken(userId, config.accessTokenSecret, ttl)`
  (`packages/api/src/auth/session-tokens.ts`). No `@cobble/core` change; reuses the
  existing app-access-token verifier on the `/ws` side.
- AC: a request with a valid service credential + a userId that has `discord_config`
  returns a token that verifies and resolves to that real user; a userId **without**
  `discord_config` is rejected; a bad/absent service credential is rejected; the
  token's TTL is short and `ACCESS_TOKEN_SECRET` never leaves the api process.
- Verify: api unit/integration test for the route (mint → connect `/ws` →
  `embodiment.whoami` resolves the real user's companion).

> **Checkpoint A:** the worker can obtain a real-user access token from T2b and hold
> an authenticated, companion-claiming `/ws` session as that user. Discord I/O
> untouched so far.

### Phase 1 — Config & identity

**T3 — `discord_config` table + migration** *(needs: db)*
- Files: `db/src/schema.ts` (add `discordConfig` pgTable: `id`, `userId`→users,
  `encryptedBotToken text`, `boundCompanionId`→companions, `ownerDiscordUserId text
  nullable`, `proactivity text default 'gentle'`, `linkCode text nullable`,
  timestamps; unique index on `userId`).
- Action: `pnpm --filter @cobble/db run generate` → new SQL in `db/migrations/`.
- AC: migration applies cleanly (`pnpm db:migrate`) on a fresh DB; re-running is a
  no-op; `down`/fresh-init parity holds.
- Verify: `pnpm db:migrate` against a scratch Postgres; table present.
- **✓ built**: `0001_simple_frank_castle.sql` generated; verified applying under the
  same PGlite path production uses + 3 schema tests (insert/read, one-per-user PK,
  cascade-on-user-delete). The Discord-specific `proactivity` field was dropped — DMs
  are gated by the companion's existing `proactivity_dial` (§6/§8), so a separate
  field would contradict that; added `link_code` + `link_code_issued_at` for the TTL.

**T4 — Token encryption util (AES-256-GCM)** *(parallel with T3)* — **✓ built**
- Done: `packages/discord/src/crypto.ts` — `encryptSecret(plaintext, key)` /
  `decryptSecret(payload, key)` using `node:crypto` AES-256-GCM (random IV, auth tag,
  versioned `v1.iv.tag.cipher` envelope), `keyFromBase64`, and `secretsEqual`
  (constant-time, for `/link` codes). `decrypt` returns a discriminated `Result`
  (`ok | bad_key | malformed`) — never null, never throws on tamper. 14 unit tests.
- Note: the key is passed in (the worker derives it from `DISCORD_TOKEN_KEY`); the
  module is pure/key-source-agnostic.

**T5 — Config store** *(needs: T3, T4)* — **✓ store built** (location changed)
- Done: the store lives in **`@cobble/db`** (`db/src/discord-config-store.ts`,
  `DrizzleDiscordConfigStore`), **not** `packages/discord` — both the api (write +
  the mint endpoint's authorize-read) and the worker (poll-read) use it without
  importing each other or `@cobble/core` (the §1 config-ownership decision). Methods:
  `findByUserId`, `list`, `upsert` (re-save resets owner + link code), `bindOwner`
  (consumes the code), `delete`. 6 PGlite tests.
- Divergence: the store persists the **already-encrypted** token blob (a pure
  data-access layer); encryption/decryption is the boundary's job (T4 `crypto.ts`),
  not the store's — cleaner separation than the original "encrypt on write" sketch.
- Remaining: wiring the encrypt-on-write at the settings path (T13) and
  decrypt-on-read in the worker (T6).

### Phase 2 — Discord I/O

**T6 — Gateway manager** *(needs: T5)* — **✓ built**
- Done: `packages/discord/src/gateway/{types,manager,discord-js-gateway}.ts` +
  `test/fake-gateway.ts`. The manager reconciles live bots against `discord_config`
  (`sync()` + a poll loop), boots one bot per user behind the `DiscordGateway` seam,
  routes inbound DMs tagged with the owning user, restarts on token change, stops on
  removal/decrypt-failure, registers global commands per bot, and survives a list
  failure. 9 tests against the fake gateway. The real `discord.js` wrapper
  (`createDiscordJsGatewayFactory`) is the untested integration boundary — DM intents
  + `Channel` partial, `ClientReady`-gated login, global commands with DM contexts.
- Note: the inbound-DM sink (`onDirectMessage`) is a passthrough today; owner-lock /
  summon / chat handling land in T7+. Slash-command/interaction + reply/typing
  surfaces are added to the gateway seam by those tasks.
- Original sketch follows:
- Files: `packages/discord/src/gateway/manager.ts` (poll `discord_config` on an
  interval; boot one `discord.js` client per config row; lifecycle
  start/stop/restart-on-token-change; auto-register global commands with DM context
  on `ready`, §11), `gateway/client.ts` (thin interface over `discord.js` `Client`),
  `test/fakes/fake-gateway.ts`.
- AC: with the fake gateway, the manager spins up N clients and routes an inbound DM
  event to the correct per-user handler; a polled config change restarts that user's
  client; commands register once per bot (diffed, not re-pushed).
- Verify: `pnpm --filter @cobble/discord test gateway`.

**T7 — Owner lock + `/link <code>`** *(needs: T6)* — **✓ built**
- Done: extended the `DiscordGateway` seam with slash-command/interaction +
  `reply`/`sendDirectMessage` (manager now tags DMs with a `reply` and routes
  `SlashCommandContext`). `packages/discord/src/router.ts` (`BotRouter`): the bot
  answers only its owner (pre-link → prompts `/link`; non-owner DM → silently
  ignored; non-owner command → refused), and `/link <code>` binds the invoker as
  owner iff the code matches the stored single-use code within the 15-min TTL
  (`LINK_CODE_TTL_MS`, constant-time `secretsEqual`, `bindOwner` consumes it). Owner
  DMs/commands delegate to injected `onOwnerMessage`/`onOwnerCommand` (summon/chat →
  T8+). 10 router tests + 2 new manager tests.
- Original sketch follows:
- Files: `packages/discord/src/owner-lock.ts`, `commands/link.ts`.
- AC: DM from a non-owner id is ignored; `/link <validCode>` binds
  `ownerDiscordUserId` and clears the code; subsequent owner DMs pass the lock;
  reused/expired code rejected.
- Verify: `pnpm --filter @cobble/discord test owner-lock`.

> **Checkpoint B:** the bot is online, locked to its owner, and reads its config —
> but is still **Dormant** (no embodiment). It only knows how to link.

### Phase 3 — Embodiment lifecycle (the heart)

**T8 — `/summon`, `/status`, supersede, dormant gating** *(needs: T7, T1)* — **✓ built**
- Done: `packages/discord/src/bridge.ts` (`CompanionBridge`) runs the lifecycle behind
  the owner-locked router: `/summon` claims the companion via a `CompanionConnection`
  seam, `/status` reports presence, a post-ready `embodiment.superseded` tears the
  connection down and DMs the "stepped over to the web" notice, and an owner DM while
  dormant is refused with "summon first". The real `createCompanionConnectionFactory`
  (`connection.ts`) wraps the T1 `WsTransport` (token → `/ws` URL → claim → supersede).
  `GatewayManager.sendDirectMessage` carries async notices. Chat (T9) and read-only
  commands (T10) are injected hooks. 8 bridge + 2 connection-glue tests.
- **Checkpoint C reached and green** (logic-level): the summon/supersede model works
  end-to-end against fakes. The remaining real-Discord/real-`/ws` demo is the live
  integration test (task #4) + the worker assembly (below).
- Original sketch follows:
- Files: `packages/discord/src/bridge/embodiment.ts` (open WS `?companion=`, await
  `embodiment.ready`; handle `embodiment.superseded` + close `4002` → Dormant +
  notice DM), `commands/summon.ts`, `commands/status.ts`, dormant guard in the DM
  router ("summon first").
- AC (integration, real `/ws`): `/summon` claims and `/status` reports Active; a
  second connection claiming the same companion drives the bridge to receive
  `embodiment.superseded`, post the notice, and go Dormant without auto-reconnect; a
  DM before summon is refused with the summon prompt.
- Verify: `pnpm --filter @cobble/discord test embodiment`.

> **Checkpoint C:** the user's described summon/supersede model works end-to-end
> against the real embodiment lease. This is the riskiest slice — stop and demo it.

### Phase 4 — Chat

**T9 — DM → `messages.send`** *(needs: T8)* — **✓ built**
- Done: `packages/discord/src/chat.ts` (`handleChat`, the bridge's `onChat` hook):
  runs `messages.send` over the embodiment connection and renders the
  `ChatStreamEvent` stream into one Discord reply — `composing` → typing cue, `done`
  → single final message, a mid-turn `error` event → its (user-facing) text, an
  `over_cap` rejection → the `/feed` nudge. Extended the `CompanionConnection` seam
  with `chat()`, the gateway seam with `sendTyping`, and the transport to preserve the
  server error `code` (`WsCallError`) so `over_cap` is detectable. 7 tests.
- Original sketch follows:
- Files: `packages/discord/src/bridge/chat.ts` (consume `ChatStreamEvent`:
  `composing`→typing, buffer tokens, `done`→single message + citations embed,
  `error`/`over_cap`→`/feed` nudge).
- AC (integration): a DM yields exactly one final Discord message; typing indicator
  fired on `composing`; an `over_cap` error renders the feed nudge.
- Verify: `pnpm --filter @cobble/discord test chat`.

### Phase 5 — Read-only commands

**T10 — The eight slash commands** *(needs: T9)* — **✓ built**
- Done: `packages/discord/src/read-commands.ts` (`handleReadOnlyCommand`, the bridge's
  `onReadOnlyCommand` hook) dispatches `/memory`, `/recall`, `/activity`, `/episodes`,
  `/growth`, `/budget`, `/feed`, `/reading` to the matching `/ws` method and renders
  each with the pure `command-render.ts` formatters. Because the companion-scoped read
  methods require the live claim (`requireEmbodiment`/`companionOf`), the views run over
  the **summoned** connection — so the bridge gates a view run while dormant with the
  same "summon first" prompt as chat (a side connection would itself supersede). The
  gateway seam sends string content only, so views render as **Discord Markdown**, not
  embeds. `/recall` requires a query (and its `over_cap` embedding-spend rejection
  becomes a feed nudge); `/episodes` takes an optional query (`episodes.search` vs
  `.list`); `/feed` shows the pantry with no arg and applies a `ration`/`spark`/`treat`
  with one (an empty-pantry `conflict` is explained). The eight specs were added to
  `COMMAND_SPECS` (registered globally on `ready`, T6). 31 new tests (17 render
  snapshots + 14 dispatch/error). Extended the `CompanionConnection` seam with a generic
  `call<T>()`.
- Original sketch follows:
- Files: `packages/discord/src/commands/{memory,recall,activity,episodes,growth,budget,feed,reading}.ts`,
  `commands/render.ts` (embed formatting), command registration on ready.
- AC: each command invokes the correct WS method (`memory.snapshot`,
  `memory.search`, `activity.list`, `episodes.list`/`search`, `growth.get`,
  `budget.get`, `food.get`→`feed`, `leads.list`) and renders an embed; formatting
  covered by snapshot tests against sample DTOs.
- Verify: `pnpm --filter @cobble/discord test`.

### Phase 6 — Approvals

**T11 — Proposal embeds + buttons** *(needs: T10)*
- Files: `packages/discord/src/bridge/proposals.ts` (render `proposals.list` /
  streamed `proposal` events as embeds with Confirm/Reject buttons; button
  interactions → `proposals.confirm` (stream reply like T9) / `proposals.reject`).
- AC: a proposal renders an embed with two buttons; Confirm calls
  `proposals.confirm` and renders the resulting turn; Reject calls
  `proposals.reject` and updates the embed.
- Verify: `pnpm --filter @cobble/discord test proposals`.

### Phase 7 — Proactivity

**T12 — Proactive DMs + greeting** *(needs: T8)*
- Files: `packages/discord/src/bridge/proactive.ts` (subscribe to `companion`
  `message` events; DM gated by the dial; fire `greeting.stream` on summon).
- AC: an autonomous companion message is DM'd when the dial ≠ `off` and suppressed
  when `off`; the greeting fires on `/summon`.
- Verify: `pnpm --filter @cobble/discord test proactive`.

### Phase 8 — Config surface

**T13 — Web settings panel** *(needs: T5; parallelizable after Phase 1)*
- Files: `packages/web/src/pages/` settings panel + an **API**-side config method/REST
  (the API writes `discord_config` via `@cobble/db`, §11) — token (encrypted),
  bound companion via `companions.list`, dial; mints + returns the single-use
  `/link` code (8-char, 15-min TTL) with a regenerate action. The sibling worker
  picks up the change on its next `discord_config` poll (T6).
- AC: a user pastes a token, selects a companion, sees the `/link` code (and can
  regenerate), sets the dial; saving persists (token encrypted) and the worker
  (re)starts that bot's gateway connection within one poll interval.
- Verify: `pnpm --filter @cobble/web test` + manual flow against local stack.

### Phase 9 — Operability & merge

**T2 — Register the Discord service client** *(ops; needs: T2b)*
- A `service_client` credential for the worker (the `DISCORD_SERVICE_CLIENT_ID` /
  `DISCORD_SERVICE_SECRET` the mint endpoint pins to, §11) and a key for
  `DISCORD_TOKEN_KEY`. Not code — a deployment/secrets step.

**T14 — Live `/ws` integration test** *(needs: T8/T9)*
- The one path the fakes can't prove: a real `WsTransport` against a running `/ws`
  claims embodiment, runs a chat turn, and observes a real `embodiment.superseded`
  takeover. (Tracked separately as the transport's live integration test.)

**T15 — Always-on worker deployment** *(needs: worker assembly)*
- A min-instances=1 container (or an EC2 process) for `packages/discord` — documented
  in `docs/infra-setup.md` (and the AWS/GCP apply runbooks), per the §11 infra note.

**T16 — Canonical-doc updates on merge to `main`** *(needs: everything above)*
- The design doc (`companion-discord.md`) + this plan are the living docs while the
  surface is on the branch; the repo-wide canonical sources are updated **when the PR
  merges** (CLAUDE.md "When to Update Docs"): the new `packages/discord` component +
  the `/internal/discord/token` route + the worker process in `docs/architecture.md`
  §3 (Component Map) and §4.1 (folder tree); Discord as a surface in
  `docs/product-overview.md`; the `discord_config` data model + worker config in
  `docs/implementation.md`; the worker run/env in `README.md`; and flipping this doc's
  and `companion-discord.md`'s **"proposed"** banners to shipped.

### Worker assembly — **✓ built** (the runnable composition root)

`packages/discord/src/worker.ts` wires manager → router → bridge → chat.
`assembleWorker(parts)` is the injectable wiring (so the full path is
integration-tested with a fake gateway: a linked owner's `/summon` → DM → chat reply,
and a non-owner DM is refused); `loadWorkerConfig(env)` reads the worker env
(`DATABASE_URL`, `DISCORD_WS_BASE_URL`, `DISCORD_MINT_URL`,
`DISCORD_SERVICE_CLIENT_ID`, `DISCORD_SERVICE_SECRET`, `DISCORD_TOKEN_KEY`,
`DISCORD_POLL_INTERVAL_MS`); `startWorker(config)` builds the real deps (the
`discord.js` gateway factory, the `WsTransport` connection factory, and the HTTP
`createMintTokenSource` client for T2b) and runs as the always-on sibling process
(`pnpm --filter @cobble/discord {dev,serve,start}`). `onReadOnlyCommand` now wires the
T10 read-only views. Approvals (T11), proactive DMs + greeting (T12), and the web
settings panel (T13) remain.

### Cross-cutting verification (run at every checkpoint)

- `pnpm -r run typecheck` — whole workspace green.
- `pnpm --filter @cobble/discord test` — adapter suite green.
- Manual: bot online → `/link` → `/summon` → chat → command → proposal → open web
  (supersede notice) → `/summon` again.

## 10. Out of scope (Beyond the PoC)

- Server/guild channels (DM-only for now); multi-person "who is speaking."
- Allowlist beyond the single owner.
- Live token-by-token streaming via message edits.
- Discord-native reactions ↔ `reactions.add`/`reactions.remove` (emoji reward +
  expression) — natural fit, deferred to a follow-on.
- File-attachment ingestion via DM (`sources.file`) — deferred.
- Multiple bound companions / `/summon <companion>` selection — bind one for now.

## 11. Resolved implementation decisions

Settled during design review (2026-06-26):

- **Backend auth — connect as the real user via an internal mint endpoint.**
  Service-token auth would namespace the bridge as a *separate* `(service,
  client_id, external_id)` user that doesn't own the companion (`ensureUserByClaim`,
  `packages/core/src/identity/store.ts`) — the handshake would 404. Instead the
  bridge connects to `/ws` as the **real user** with a short-lived **app access
  token** (`?access_token=…`), verified by the existing app-access-token verifier
  (`CompositeVerifier` browser path) — **no `@cobble/core` change**. A new internal
  api route (T2b) mints that token via `mintAccessToken`, authenticating the worker
  by its Discord **service credential** and authorizing only `userId`s that have a
  `discord_config` row. `ACCESS_TOKEN_SECRET` stays in the api; the worker never
  holds it. (Rejected: sharing the signing secret with the worker — too broad a
  privilege; a Discord-bot-token verifier in core — pulls Discord into the hot auth
  path and couples core to Discord.)
- **Config ownership** — the adapter **owns `discord_config`, schema in
  `@cobble/db`**. The adapter *reads* it; the API *writes* it on behalf of the web
  settings panel (the API already depends on `@cobble/db`). Neither imports the
  other; neither imports `@cobble/core`. The sibling worker (below) **polls
  `discord_config`** to pick up token/config changes — no cross-process event bus.
- **Process placement** — the gateway manager runs as a **sibling worker process**:
  `packages/discord` ships its own always-on entrypoint, run as a **single
  instance**. This respects Discord's one-gateway-connection-per-bot rule and
  survives API multi-node / Cloud Run scale-to-zero. Infra impact: a new always-on
  service in `docs/infra-setup.md` (a min-instances=1 container, or a process on the
  EC2 VM). It connects to core like any other `/ws` client.
- **Slash-command registration** — **global** commands, **auto-registered on the
  bot's `ready` event** (diffed against existing to avoid redundant API calls), with
  **DM context enabled**. Platform prerequisite to document in setup: the user's bot
  must be DM-reachable — it shares a server with the user, or its app is
  user-installable.
- **`/link` code** — the **API mints** an **8-char, single-use** code (no-look-alike
  alphabet) into `discord_config.linkCode` + issued-at when the user saves their bot
  token; **TTL ~15 min**; **cleared on successful `/link`**; a "regenerate" button in
  settings re-mints. The adapter verifies the code on `/link`, sets
  `ownerDiscordUserId`, and clears it; mismatched/expired/used codes fail without
  changing the owner.
