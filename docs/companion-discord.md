# CobbleCompanion — The Discord Surface (bring-your-own-bot)

> **Canonical source for the Discord surface's _design and decisions_** — what the Discord
> surface is, how a user attaches their own bot, how it embodies the companion via **summon**,
> and the design choices that shape it. Discord is a **surface** (a "living room" the companion
> embodies in, one at a time — `product-overview.md` §2), reached through a **decoupled adapter**
> that speaks only the public WebSocket contract.
>
> **Status: shipped.** The surface is built on `packages/discord/` (the worker) + the
> api's `discord.config.*` WS methods and `/internal/discord/token` route; the web
> settings panel attaches a bot. The sequenced, file-level build history lives in
> `plans/discord-surface.md`. Present tense below describes the live design.
>
> **Each fact lives in one place.** This doc owns the _Discord surface design_. It does **not**
> redefine the **wire contract** (methods, envelopes, streaming, events — `companion-endpoints.md`),
> the **embodiment/fencing mechanism** (the ULID lease, "newer wins", supersede —
> `architecture.md` §6, `plans/deliver-scalability.md` §5.2, `plans/embodiment-handoff-fencing.md`),
> **service-token auth** (`implementation.md` §5, `architecture.md` §8), the **proactivity dial**
> (`companion-motivation.md`), the **approval queue** (`product-overview.md` §7), or the **feeding
> economy** (`companion-economy.md`). Where this doc names a method or payload it is a _reference_;
> follow the link for the _mechanism_.
>
> **Where it will live.** A new decoupled package `packages/discord/` — a gateway manager plus a
> per-user WebSocket bridge that connects to `/ws` **as the real user** (a short-lived app access
> token, §9). It imports **nothing** from `@cobble/core` (the harness, memory, embodiment internals);
> it may use `@cobble/db` for its own config table and `@cobble/shared` for the contract types.
> Reference client to mirror: `packages/web/src/api/ws.ts`.

---

## 1. What it is

Discord is a **surface**, like web and (future) mobile/desktop — a room the one companion embodies
in, **one at a time** (`product-overview.md` §2.2). The Discord room is a **DM with a Discord bot
the user owns**.

The binding is **bring-your-own-bot, one bot per user**: in account settings a user pastes a
**Discord bot token**. The backend runs that bot's gateway connection, bound to one of the user's
companions, and serves **only that user** (locked to the owner's Discord user ID). The token _is_
the binding — there is no shared bot and no OAuth account-linking dance.

The companion is not "in" Discord until the user **summons** it (`product-overview.md` §2.2 defines
_summon_ = bringing the companion into the surface you're using). `/summon` makes the adapter claim
embodiment for that companion; the claim is held indefinitely (heartbeat-renewed) until the user
opens the companion somewhere else, which supersedes the Discord claim. This is the same
one-embodiment-at-a-time invariant every surface obeys — Discord adds **no** new embodiment logic.

## 2. The shape of it

```
Discord (your private bot)                CobbleCompanion backend
┌──────────────────────┐                  ┌──────────────────────────┐
│  DM with your bot     │                  │  packages/discord/  (NEW) │
│  • messages           │   gateway        │  ┌────────────────────┐  │
│  • /summon /status    │◀────────────────▶│  │ Gateway manager    │  │
│  • /memory /recall …   │   (bot token)    │  │ 1 conn per user     │  │
│  • Confirm/Reject ▣    │                  │  └─────────┬──────────┘  │
└──────────────────────┘                  │            │ per summoned user
                                            │  ┌─────────▼──────────┐  │
                                            │  │ Bridge = WS client  │  │
                                            │  │ as the real user    │  │
                                            │  └─────────┬──────────┘  │
                                            └────────────┼─────────────┘
                                                         │ public /ws contract only
                                                         │ (imports NO core code)
                                            ┌────────────▼─────────────┐
                                            │  Companion core (untouched)│
                                            │  embodiment · harness ·    │
                                            │  memory · proposals        │
                                            └───────────────────────────┘
```

Two responsibilities inside `packages/discord/`:

- **Gateway manager** — owns the set of live Discord bot connections (one per configured user),
  reads each user's token from the adapter's own encrypted config store, enforces the owner lock,
  and routes inbound Discord events (DMs, slash commands, button clicks) to the right per-user bridge.
  It runs as a **single always-on sibling worker process** (`packages/discord` ships its own
  entrypoint) — Discord allows only one gateway connection per bot, so the manager must be singleton
  and cannot live in a horizontally-scaled API. It **polls `discord_config`** to pick up token/config
  changes (no cross-process event bus).
- **Bridge (per summoned user)** — a WebSocket client to `/ws`
  (`?access_token=<user_access_token>&companion=<id>`, `companion-endpoints.md` §handshake) that
  connects **as the real, companion-owning user** (§9 explains why, and how the token is obtained).
  It translates Discord ↔ WS and is the _only_ path to the companion. The adapter never reaches into
  the harness, memory, or embodiment store directly — preserving the core↔surface boundary
  (`architecture.md` §2).

**Why decoupled.** Treating Discord as "just another `/ws` client" means the entire surface is added
without touching the agent loop, memory, or embodiment mechanism. "Imports NO core code" is precise:
no dependency on `@cobble/core`. (`@cobble/db` for the adapter's own table and `@cobble/shared` for
contract types are infrastructure, not core intelligence.)

## 3. Design decisions

| Decision                   | Choice                                                                                                                                                                           | Rationale                                                                                                                                                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Audience**               | One bot per user, bring-your-own token                                                                                                                                           | The token is the binding; no shared bot, no multi-tenant identity problem, no account-linking flow.                                                                                                                                                                                              |
| **Who the bot answers**    | Owner only (locked to the owner's Discord user ID)                                                                                                                               | The bot speaks as the companion with the user's memory; anyone sharing a server with the bot can DM it, so responses must be locked. Allowlist deferred (§10).                                                                                                                                   |
| **Embodiment coexistence** | Explicit **summon**, hold-until-superseded                                                                                                                                       | Matches the user's mental model and the existing claim/supersede mechanism exactly. Chatting without a claim is refused with "summon first," never silently misrouted.                                                                                                                           |
| **On supersede**           | DM a notice                                                                                                                                                                      | Opening the companion on web silently kills the Discord claim; a notice explains the proactive silence and makes re-summoning obvious.                                                                                                                                                           |
| **Proactivity**            | Yes, gated by the existing proactivity dial                                                                                                                                      | Proactive DMs are the single best reason to be on Discord; the dial (`off`/`gentle`/`active`, `companion-motivation.md`) governs them. Only fire while summoned/embodied.                                                                                                                        |
| **Approvals**              | In-Discord embed + Confirm/Reject buttons                                                                                                                                        | Going to the web app to approve would supersede the bot; approvals must be self-contained in Discord.                                                                                                                                                                                            |
| **Reply style**            | Typing cue + single final message                                                                                                                                                | Discord is rate-limited and not built for token-by-token streaming; the bridge consumes the stream server-side and posts once.                                                                                                                                                                   |
| **Runtime**                | Single always-on **sibling worker process**, encrypted token at rest, decoupled module                                                                                           | Discord allows one gateway connection per bot, so the manager is singleton; it lives in its own package consuming only the public contract, surviving API multi-node / scale-to-zero.                                                                                                            |
| **Config ownership**       | Adapter owns `discord_config` (schema in `@cobble/db`); adapter reads, API writes                                                                                                | Keeps the adapter free of `@cobble/core` while letting the web settings panel persist the token through the API; the worker polls for changes.                                                                                                                                                   |
| **Command registration**   | Global commands, auto-registered on `ready`, DM context enabled                                                                                                                  | Guild commands don't appear in DMs (our only surface); global auto-registration needs zero per-user setup. Bot must be DM-reachable (shares a server or user-installable).                                                                                                                       |
| **Backend auth**           | Bridge connects as the **real user** via a short-lived app access token, minted by an **internal API endpoint** (gated by a Discord service credential + a `discord_config` row) | Service-token auth would namespace the bridge as a _separate_ user that doesn't own the companion (handshake 404). Connecting as the real user reuses the existing app-access-token verifier with **no `@cobble/core` change**; the `ACCESS_TOKEN_SECRET` stays in the API, never in the worker. |

## 4. Embodiment lifecycle

The room has two states. Transitions reuse the existing ULID-lease machinery
(`packages/core/src/embodiment/store.ts`); the adapter adds no new claim logic.

- **Dormant** — the bot is online on Discord (gateway connected) but holds **no** WS connection and
  **no** embodiment. A DM that is not `/summon` is refused: _"I'm not here right now — `/summon` to
  bring me into this chat."_ The bot never calls `messages.send` while dormant (it would return
  `not_embodied`).
- **`/summon`** — the bridge opens the WS (as the real user, §9) with `?companion=<id>`, which
  force-claims embodiment (newer ULID wins). On the `embodiment.ready` event it confirms presence and may stream
  an arrival greeting (`greeting.stream`). The claim is renewed by the WS heartbeat indefinitely —
  the "connected forever" behaviour.
- **Active** — DMs route to `messages.send`; live `companion` events drive proactive DMs; pending
  proposals surface as embeds.
- **`/status`** — reports Active vs Dormant via `embodiment.whoami`.
- **Superseded** — the user opens the companion elsewhere (e.g. web); that surface force-claims; the
  bridge receives `embodiment.superseded` followed by socket close `4002`. The adapter DMs the notice
  and returns to **Dormant**. It does **not** auto-reconnect — re-entry is an explicit `/summon`.
- **Disconnected** — the WS drops for any reason that is **not** a supersession and **not** a
  deliberate teardown (server bounce, idle timeout, `1006`). The transport surfaces the close to the
  bridge (`onClose` → `onClosed`), which tears the embodiment down exactly like Superseded — clears
  `active`, aborts the proactive loop, and DMs _"I lost the connection — `/summon` to bring me back
  here."_ — and returns to **Dormant**. Like Superseded, it does **not** auto-reconnect; clearing
  `active` is what lets the next `/summon` reconnect instead of being refused _"already here."_

## 5. Chat reply rendering

On a DM (while Active), the bridge calls `messages.send` and consumes the `ChatStreamEvent` stream
server-side (`companion-endpoints.md` §streaming):

- `composing` → trigger the Discord **typing indicator** in the DM channel.
- `token` / `citations` / `tool_step` → buffered, not rendered live.
- `done` → post **one** message with the full reply, as plain Discord Markdown. Folding citations
  and notable tool steps into a rich embed is a Beyond-the-PoC nicety (§6, §10).
- `error` → post a friendly error. If the cause is stamina exhaustion (`over_cap`), nudge
  _"I'm tired — `/feed` me to continue."_
- `reflection` → optional secondary line (growth reflection).

## 6. Slash commands

Read-only views map directly onto existing WS methods (no new endpoints):

| Command             | WS method                                                            | Renders                                                               |
| ------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `/summon`           | open WS `?companion=<id>` → `embodiment.ready` (+ `greeting.stream`) | presence confirmation / greeting                                      |
| `/status`           | `embodiment.whoami`                                                  | Active vs Dormant                                                     |
| `/memory`           | `memory.snapshot`                                                    | identity + episodic/semantic/procedural counts                        |
| `/recall <query>`   | `memory.search`                                                      | semantic search results                                               |
| `/activity`         | `activity.list`                                                      | proactive activity log                                                |
| `/episodes [query]` | `episodes.list` / `episodes.search`                                  | consolidated episodes                                                 |
| `/growth`           | `growth.get`                                                         | the four-axis growth readout (knowledge, bond, initiative, character) |
| `/budget`           | `budget.get`                                                         | stamina/energy wallets                                                |
| `/feed`             | `food.get` → `feed`                                                  | pantry, then apply a food                                             |
| `/reading`          | `leads.list`                                                         | reading list (harvested leads)                                        |

The read-only views (`/memory`…`/reading`) call **companion-scoped** methods, which
require the connection to hold the live embodiment claim (`requireEmbodiment`,
`deliver-scalability.md` §5.2). They therefore run over the **summoned** connection —
a view run while **Dormant** is refused with the same _"summon first"_ prompt as chat
(§4), since opening a side connection just to answer a view would itself claim the
room and supersede the active surface. `/recall` and `/episodes <query>` spend on the
search embedding, so an empty stamina wallet surfaces as the `/feed` nudge; `/feed`
with no argument shows the pantry and with `ration`/`spark`/`treat` applies a food.

Views render as **Discord Markdown** (headings, bullets, code spans), not embeds: the
adapter's gateway seam sends string content, which keeps it decoupled from
`discord.js` types and the renderers pure. Richer embeds (for views, chat citations,
and proposal cards) are a Beyond-the-PoC nicety (§10).

## 7. Approvals

Effectful actions (book/send/pay-style) are held as **proposals** for one-tap approval
(`product-overview.md` §7). In Discord a proposal arrives as a DM **embed** (tool name + summary)
with **Confirm** and **Reject** buttons:

- **Confirm** → `proposals.confirm` (streaming; the post-approval turn is rendered like a chat reply, §5).
- **Reject** → `proposals.reject`.

Keeping approvals in Discord is required, not cosmetic: approving on the web app would force-claim the
companion and supersede the Discord bot (§4).

## 8. Proactive DMs

While Active, the bridge subscribes to the `companion` live-event stream. Companion-initiated
(autonomous) messages are DM'd to the owner, **gated by the proactivity dial** (`off` = none;
`companion-motivation.md`). The gate is enforced **server-side** — the motivation engine only
produces autonomous messages when the dial allows — so the bridge simply forwards what arrives;
there is no client-side dial check. It de-dupes against the turn replies it already rendered
inline, so a chat reply is never re-posted as a "proactive" DM. The arrival greeting fires on
`/summon`. Because proactive push only flows while summoned, the supersede notice (§4) is what
tells the user why the companion went quiet.

## 9. Auth, owner lock & token security

- **Backend auth — connect as the real user via a minted access token.** The bridge must talk to
  `/ws` _as the user who owns the companion_. Service-token auth is the wrong primitive here: a
  service connection is namespaced as a **separate** `(auth_source='service', service_client_id,
external_id)` user (`packages/core/src/identity/store.ts`, `ensureUserByClaim`), which does **not**
  own the user's Google-auth'd companion — so the handshake's ownership check would 404. Instead the
  bridge connects exactly like the web client: with a short-lived **app access token** for the real
  user (`?access_token=…`), verified by the existing app-access-token verifier
  (`CompositeVerifier` browser path, `packages/api/src/auth/jwt-verifier.ts`) — **no `@cobble/core`
  change**.
  - **Where the token comes from.** A new **internal API endpoint** mints it via
    `mintAccessToken(userId, ACCESS_TOKEN_SECRET, ttl)` (`packages/api/src/auth/session-tokens.ts`).
    The worker authenticates _to that endpoint_ with a Discord **service credential** (a
    `service_registry` row). The surface is **always-on**: rather than a manual
    `pnpm --filter @cobble/db service add`, that row is seeded at API boot from
    `SERVICE_REGISTRY_SEEDS` (idempotent on the `(client_id, secret)` unique index), so a fresh
    stack comes up with the worker already authenticated. The endpoint mints **only** for a
    `userId` that has a `discord_config` row, and the bridge refreshes the short-lived token as
    needed. The signing key (`ACCESS_TOKEN_SECRET`) stays in the API and is **never** held by the
    worker.
  - **Per-user proof (`X-Discord-Bot-Token`).** The service credential is **shared across all
    Discord users**, so `X-User-Id` on its own is an unauthenticated claim — without more, any holder
    of the service secret could mint a full session for any Discord-enabled user. The mint therefore
    requires the caller to also present that user's **plaintext bot token**; the endpoint decrypts the
    stored `encryptedBotToken` for `userId` and rejects (opaque `403`) on any mismatch, absent header,
    or undecryptable record (constant-time compare, `discord-token-mint.ts` gate 4). The bot token is
    the one secret that actually identifies the user, so a leaked service credential **alone** cannot
    mint for a user whose bot token it does not also hold. The worker already holds the decrypted
    token (it ran the gateway connection), so it sends it on the mint call; no user input chooses
    `userId` (it is bound to the bot connection that received the event, `gateway/manager.ts`).
  - **Surface scoping (`surface: 'discord'`).** The minted token carries a signed
    `surface: 'discord'` claim (`mintSurfaceAccessToken`, `session-tokens.ts`). The bridge
    connects to `/ws` **as the real user**, so over `/ws` the token is a normal user connection
    with the **same access as a web session** — every WS method, by design (the bridge needs
    chat, the read-only views, the approval buttons, `/feed`, and so on; settings and the
    approval queue are themselves WS methods). It is **not** confined on `/ws`. The `surface`
    claim's **only** effect is on **HTTP**: the auth guard (`auth-guard.ts`) rejects it with
    `403`, keeping a Discord token off the access-token-guarded HTTP routes (the local upload
    sink, the admin queue). The web session path uses the unscoped `mintAccessToken` (no
    `surface` claim), so it is unaffected.
- **Owner lock.** Every inbound Discord event is checked against the stored `ownerDiscordUserId`;
  anything else is ignored. The owner ID is captured once via a **`/link <code>`** handshake so the
  bot never trusts "first DM wins": the **API mints** an **8-char, single-use** code (no-look-alike
  alphabet) into `discord_config.linkCode` when the user saves their token, shown in web settings;
  it **expires in ~15 min** and is **cleared on a successful `/link`**, with a regenerate action in
  settings. Until linked, the bot answers no one.
- **Token at rest.** The bot token is a secret: stored **encrypted** (AES-256-GCM via `node:crypto`,
  key from environment/KMS), never plaintext, never logged. The config row —
  `{ userId, encryptedBotToken, boundCompanionId, ownerDiscordUserId, proactivity, linkCode }` — is
  written by the API on behalf of the web settings panel; the sibling worker picks up the change on
  its next `discord_config` poll and (re)starts that bot's gateway connection.
- **No secrets in logs.** Errors are logged with operation + `userId`/`companionId` context, never the
  token or service secret (per the repo logging rule).

## 10. Beyond the PoC

- **Server/guild channels** — DM-only for now; channels raise "who is speaking" in multi-person rooms.
- **Allowlist beyond the owner** — authorize additional Discord user IDs.
- **Live token streaming** via message edits (rejected for the PoC: edit rate limits, janky UX).
- **Discord-native reactions ↔ `reactions.add`/`reactions.remove`** — the companion's emoji reward +
  expression model (`companion-reactions.md`) maps naturally onto Discord reactions; deferred.
- **File-attachment ingestion** via DM (`sources.file`) — deferred.
- **Multiple bound companions / `/summon <companion>`** selection — one bound companion for now.
- **Quiet hours** for proactive DMs.
- **Rich embeds** for the read-only views, chat-reply citations, and proposal cards — the PoC
  renders plain Discord Markdown over the string-only gateway seam (§5, §6).
