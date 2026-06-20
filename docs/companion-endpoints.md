# CobbleCompanion — WebSocket Endpoint Contract (Client Integration Reference)

> **Canonical source for the surface↔core wire contract** — everything a service-client
> developer needs to talk to the companion backend: how to open the connection, the
> message envelopes, every callable method (params, result, errors), the streaming
> protocol, and the server-pushed live-event stream.
>
> Since Phase D the companion endpoints are **not HTTP** — a single permanent WebSocket
> at `/ws` carries all companion-scoped traffic (`plans/deliver-scalability.md` §5.2,
> `architecture.md` §6). The former REST/SSE routes were removed once the web client
> moved fully onto the socket.
>
> **Each fact lives in one place.** This doc owns the *wire contract*. It does **not**
> redefine the embodiment/fencing *mechanism* (that is `architecture.md` §6 and
> `plans/deliver-scalability.md` §5.2), the durable event-log *delivery* internals
> (`implementation.md` §2.4), the DTO field *semantics* (the JSDoc on each type in
> `packages/shared/src/contracts.ts`), or the tunable values (`packages/api/src/config.ts`).
> Where this doc lists a payload it is the *shape*; follow the link for the *meaning*.
>
> **Authority:** the envelope and DTO types are defined in
> `packages/shared/src/contracts.ts`; the method table is assembled in
> `packages/api/src/ws/methods.ts`; the dispatcher, error mapping, and connection
> wrapper are in `packages/api/src/ws/{dispatch,connection,fencing,handshake,register}.ts`.
> If this doc and the code disagree, the code wins — update this doc.

---

## 1. What still speaks HTTP

Only five HTTP routes remain; everything else is a WS method (§4):

| Route | Purpose |
|-------|---------|
| `GET /auth/config` | Public, pre-auth bootstrap (which auth provider / client id). |
| `PUT /uploads/local/:uploadId` | Filesystem upload sink — **local backend only**; the S3 backend issues a presigned PUT instead (`staging-object-storage.md`). |
| `GET /health` | Liveness/readiness check. |
| `POST /admin/queue` | Admin-only job-queue observability (Phase C2). |
| `GET /*` (SPA) | Static web-client serve. |

File **bytes** still travel over HTTP (the presigned/local PUT); the *enqueue* that
follows is the `sources.file` WS method (§4.6).

---

## 2. Connecting

### 2.1 The URL and handshake

```
wss://<host>/ws?access_token=<jwt>[&companion=<companionId>]
```

- **Auth happens once, at the upgrade** (`handshake.ts`). The resolved `userId` is fixed
  for the connection's lifetime; there is **no per-message auth**.
- The bearer may be sent **either** as an `Authorization: Bearer <jwt>` header **or** as
  the `access_token` query param. A browser `WebSocket` cannot set headers, so it uses the
  query param; service clients may use either.
- A bad/expired token **aborts the upgrade** — the socket never opens. (Token expiry is
  logged at `info`; the client must reconnect with a fresh bearer.)

### 2.2 Embodiment (the `companion` param)

A connection that names `&companion=<id>` **embodies** that companion (`register.ts`):

- The companion id is **ownership-checked at the handshake**. An unowned/unknown id aborts
  the upgrade with HTTP `404` before the socket opens.
- One companion lives in **one room at a time**. Opening a new embodying connection
  **force-claims** the companion ("newer wins"); the previously-embodying connection is
  superseded (§2.4).
- A connection with **no** `companion` param is **transport-only**: it can call per-user
  methods (`companions.*`, `auth.me`, `userFacts.*`, `food.get`, `ping`) but every
  companion-scoped method returns `not_embodied` (§5).
- Companion-scoped methods are **fenced**: each verifies the connection still holds the
  live claim before acting, so a superseded zombie connection cannot inject an action
  after a handoff (`fencing.ts`).

### 2.3 Live delivery starts at connect

On a successful embodiment claim the server begins pushing the companion's durable event
log down the socket (§6). The initial cursor is the **settled horizon at connect time**,
not "everything" — load history once via `messages.list` (a snapshot) and **merge live
events by message id**. See `implementation.md` §2.4 for the visibility-horizon rationale.

### 2.4 Supersession (handoff)

When a newer connection claims the companion, the older connection receives:

1. an unsolicited event `{"event":"embodiment.superseded","data":{"companionId":"…"}}`, then
2. a socket close with code **`4002`**.

The superseded client **must not auto-reconnect** (the two ends would fight over the room
forever). Surface a "use here" affordance that reconnects on explicit user intent.

### 2.5 Close codes

| Code | Meaning |
|------|---------|
| `4001` | Unauthenticated (defensive; the handshake normally aborts the upgrade first). |
| `4002` | Superseded — your companion moved to another room (§2.4). |
| `1009` | Inbound frame exceeded `WS_MAX_PAYLOAD_BYTES` (rejected by the transport before parse). |
| `1011` | Server could not initialize the room (embodiment claim or live-cursor init failed) — reconnect. |

---

## 3. Message envelopes

All frames are JSON. Defined in `packages/shared/src/contracts.ts` (lines 242–271).

### 3.1 Client → server

```jsonc
// WsRequestMessage
{ "id": "r17", "method": "messages.list", "params": { /* method-specific, optional */ } }
```

- `id` — a client-chosen correlation token, unique among in-flight requests on this socket.
- Many requests may be **in flight at once**; the socket is multiplexed by `id`.

### 3.2 Server → client

```jsonc
// WsResultMessage — terminal success, correlated by id
{ "id": "r17", "result": { /* method-specific */ } }

// WsErrorMessage — terminal failure, correlated by id
{ "id": "r17", "error": { "message": "…", "code": "not_found" } }

// WsStreamMessage — one chunk of a streaming method, correlated by id
{ "id": "r42", "stream": { /* ChatStreamEvent, see §7 */ } }

// WsEventMessage — unsolicited server push, NO id (the live channel, see §6)
{ "event": "companion", "data": { /* CompanionStreamEvent */ } }
```

**Correlation rules:**
- A `result` **or** an `error` with a given `id` **terminates** that request.
- A streaming method emits zero or more `stream` frames (same `id`) **before** its
  terminal `result`. The terminal `result` for the streaming methods is `{ "done": true }`.
- `event` frames carry **no `id`** and are never a reply to a request — they are the
  live push stream (§6).

---

## 4. Method catalog

Conventions for the tables below:

- **Scope** — `transport` (no companion needed), `user` (per-user; works on any socket),
  or `companion` (requires an embodying, still-held claim — else `not_embodied`).
- **Params** — the Zod schema validated server-side (`packages/shared/src/contracts.ts`);
  a validation failure returns `bad_params`. `—` means no params.
- **Result** — the shape inside `WsResultMessage.result`.
- Methods marked **stream** push `ChatStreamEvent` chunks (§7) before the terminal result.

### 4.0 Transport seeds

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `ping` | transport | any (echoed) | `{ pong: true, echo: <params>\|null }` | — |
| `auth.me` | transport | — | `{ user: { id: string, email: string\|null } }` | — |
| `embodiment.whoami` | companion | — | `{ companionId: string, claimSeq: number }` | `not_embodied` |

### 4.1 Companions

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `companions.list` | user | — | `{ companions: CompanionDto[] }` | — |
| `companions.create` | user | `createCompanionSchema` `{ name, form, temperament }` | `{ companion: CompanionDto }` | `bad_params` |

### 4.2 Messages & transcript

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `messages.list` | companion | — | `{ messages: MessageDto[] }` (latest 200, reactions hydrated) | `not_embodied` |
| `messages.send` | companion · **stream** | `sendMessageSchema` `{ content }` | `{ done: true }` | `bad_params`, `not_embodied`, `not_found`, `over_cap` |

`messages.list` doubles as the transcript snapshot for live-merge (§2.3) and nudges the
motivation engine (opening the room is a "return"). `messages.send` streams the turn (§7);
if the companion is force-claimed mid-turn the stream ends, the server pushes
`embodiment.superseded` + closes `4002`, and the terminal result is still `{ done: true }`.

### 4.3 Reactions

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `reactions.add` | companion | `{ messageId: uuid, emoji: <single RGI emoji> }` | `{ ok: true }` | `bad_params`, `not_found`, `not_embodied` |
| `reactions.remove` | companion | `{ messageId: uuid, emoji: string }` | `{ ok: true }` | `bad_params`, `not_embodied` |

`emoji` must be exactly **one** well-formed emoji (ZWJ families/skin-tones/flags each count
as one); free text is rejected `bad_params`. A reaction on a non-reactable row is
`bad_params`; an unknown message is `not_found`. A successful add/remove also fans out as a
live `companion` event (§6) to all rooms.

### 4.4 Memory browser

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `memory.snapshot` | companion | — | `{ memory: MemorySnapshotDto }` | `not_embodied`, `not_found` |
| `memory.search` | companion | `semanticSearchSchema` `{ query, topK=8 }` | `{ results: SemanticSearchResultDto[] }` | `bad_params`, `not_embodied`, `over_cap` |

### 4.5 Episodes

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `episodes.list` | companion | — | `{ episodes: EpisodeDto[] }` (latest 50) | `not_embodied` |
| `episodes.search` | companion | `episodeSearchSchema` `{ query, topK=5 }` | `{ results: EpisodeSearchResultDto[] }` | `bad_params`, `not_embodied`, `over_cap` |

### 4.6 Sources & ingestion

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `sources.requestFileUpload` | user | `requestFileUploadSchema` `{ filename, byteSize }` | `UploadSlotDto` | `bad_params` |
| `sources.file` | companion | `createFileSourceSchema` `{ uploadId, filename, title? }` | `{ source: SourceDto, job: IngestionJobDto, messages: MessageDto[] }` | `bad_params`, `not_found`, `not_embodied`, `queue_full` |
| `sources.note` | companion | `createNoteSourceSchema` `{ title, text }` | `{ source: SourceDto, job: IngestionJobDto }` | `bad_params`, `not_embodied`, `queue_full` |
| `sources.link` | companion | `createLinkSourceSchema` `{ url, title? }` | `{ source: SourceDto, job: IngestionJobDto }` | `bad_params`, `not_embodied`, `queue_full` |
| `sources.list` | companion | — | `{ sources: SourceDto[] }` | `not_embodied` |
| `sources.get` | companion | `{ sourceId: uuid }` | `{ source: SourceDto, sections: SectionDto[] }` | `bad_params`, `not_found`, `not_embodied` |
| `sources.delete` | companion | `{ sourceId: uuid }` | `{ ok: true }` | `bad_params`, `not_found`, `not_embodied` |
| `ingestion.list` | companion | — | `{ jobs: IngestionJobDto[] }` | `not_embodied` |

**File upload is two steps** (`staging-object-storage.md`): (1) call
`sources.requestFileUpload` to get an `UploadSlotDto`; (2) `PUT` the bytes to its `url`
with its `headers`; (3) call `sources.file` with the returned `uploadId` to validate the
staged object (head + magic-byte peek) and enqueue. The `uploadId` *is* the
authorization+kind — a forged/foreign key resolves to `not_found`. `sources.file` also
posts the attachment chip + acknowledgement as transcript turns (returned in `messages`).
`note`/`link` stage their small payload server-side and enqueue directly.

### 4.7 User model (per-user)

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `userFacts.list` | user | — | `UserFactsDto` `{ facts, beliefs }` | — |
| `userFacts.update` | user | `userFactEditSchema` + `{ factId: uuid, object }` | `UserFactDto` (updated) | `bad_params`, `not_found` |
| `userFacts.delete` | user | `{ factId: uuid }` | `{ ok: true }` | `bad_params`, `not_found` |

### 4.8 Proposals (approval queue)

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `proposals.list` | companion | — | `{ proposals: ProposalDto[] }` (pending) | `not_embodied` |
| `proposals.confirm` | companion · **stream** | `{ proposalId: uuid }` | `{ done: true }` | `bad_params`, `conflict`, `not_found`, `not_embodied`, `over_cap` |
| `proposals.reject` | companion | `{ proposalId: uuid }` | `{ ok: true }` | `bad_params`, `conflict`, `not_embodied` |

`proposals.confirm` atomically flips pending→approved (a second confirm is `conflict`),
runs the effectful tool, and — for a `chat`-origin proposal — **streams** the continued
turn (§7); for explore/autonomous origins it emits a single `done` row and returns. Both
confirm and reject advance the originating lead's lifecycle (best-effort).

### 4.9 Reading list, explore & procedures

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `leads.list` | companion | — | `{ leads: LeadDto[] }` (status `new`/`read`) | `not_embodied` |
| `explore` | companion | — | `{ proposals: ProposalDto[] }` | `not_embodied` |
| `procedures.list` | companion | — | `{ procedures: ProcedureDto[] }` (latest 50) | `not_embodied` |

### 4.10 Autonomous activity log

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `activity.list` | companion | `{ limit?=30 (≤100), before?: number }` | `ProactiveActivityDto` `{ outcomes, stats, nextCursor }` | `bad_params`, `not_embodied` |

Keyset-paginated newest-first: pass the previous page's `nextCursor` as `before`; `null`
`nextCursor` means the log is exhausted.

### 4.11 Vitality, growth & feeding

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `budget.get` | companion | — | `StaminaEnergyDto` `{ stamina, energy }` | `not_embodied` |
| `usage.get` | companion | — | `{ usage: UsageDto }` | `not_embodied` |
| `growth.get` | companion | — | `GrowthDto` | `not_embodied` |
| `proactivity.set` | companion | `setProactivityDialSchema` `{ dial: off\|gentle\|active }` | `{ dial }` | `bad_params`, `not_embodied` |
| `food.get` | user | — | `{ food: FoodInventoryDto }` | — |
| `feed` | companion | `feedSchema` `{ food: ration\|spark\|treat }` | `FeedResultDto` `{ budget, food }` | `bad_params`, `conflict`, `not_embodied` |

`feed` consumes one food from the user's pantry and refills the embodied companion's
wallet(s); an empty pantry / unfeedable state is `conflict`. Food token grants are product
constants (`FOODS` in `contracts.ts`).

### 4.12 Greeting

| Method | Scope | Params | Result | Errors |
|--------|-------|--------|--------|--------|
| `greeting.stream` | companion · **stream** | — | `{ done: true }` | `not_embodied` |

The arrival-reaction decision stream (`companion-greeting.md`). It may stream a `composing`
cue then a `done` greeting, or close silently (`{ done: true }` with no chunks) when the
gate decides to stay quiet.

---

## 5. Error codes

A `WsErrorMessage.error.code` is one of the stable codes below. **Only intentionally
client-safe failures carry a `code` and a meaningful `message`** — any other server fault
(a DB error, a gateway fault) is reported generically as `{ message: "internal error" }`
with no `code`, so internal detail never leaks (`dispatch.ts`).

| `code` | HTTP analogue | Meaning | Source |
|--------|---------------|---------|--------|
| `bad_params` | 400 | Params failed schema validation. | `helpers.ts` |
| `bad_request` | 400 | Malformed/invalid request envelope (not even `{ id, method }`). | `dispatch.ts` |
| `unknown_method` | 404 | No such method name. | `dispatch.ts` |
| `not_found` | 404 | Referenced resource (message, source, fact, companion) not found. | `helpers.ts` |
| `conflict` | 409 | State precondition failed (e.g. proposal no longer pending, cannot feed). | `helpers.ts` |
| `not_embodied` | 403 | Companion-scoped method on a connection that doesn't hold the claim (never claimed, or superseded). | `fencing.ts` |
| `over_cap` | 429 | The companion's vitality wallet is empty — the action would spend tokens it lacks. | `helpers.ts` |
| `queue_full` | 429 | The shared ingest queue is at capacity — transient, retryable. | `helpers.ts` |
| `rate_limited` | 429 | Too many concurrent in-flight requests on this socket (> `WS_MAX_IN_FLIGHT`); shed before dispatch — retry shortly. | `register.ts` |

A `rate_limited` and an envelope-parse `bad_request` for a frame with no parseable `id` are
returned correlated to the **empty id** `""`.

---

## 6. The live event stream (server push)

Once embodied, the server pushes the companion's durable event log down the socket as
unsolicited `WsEventMessage` frames (no `id`). Delivery is cross-node and at-least-once
from the settled cursor; the client **dedupes/merges by message id**
(`architecture.md` §6, `implementation.md` §2.4).

| `event` | `data` | Meaning |
|---------|--------|---------|
| `companion` | `CompanionStreamEvent` | One change in the embodied companion's transcript (see below). |
| `embodiment.superseded` | `{ companionId: string }` | This connection was force-claimed by a newer one; a `4002` close follows (§2.4). |

`CompanionStreamEvent` (a discriminated union on `type`, `contracts.ts`):

| `type` | Payload | Apply by |
|--------|---------|----------|
| `message` | `{ message: MessageDto }` | Appending the row to the transcript (deduped by `message.id`). |
| `reaction_added` | `{ messageId, reactor, emoji }` | Adding to the message's reaction set. |
| `reaction_removed` | `{ messageId, reactor, emoji }` | Removing from the message's reaction set. |

Every persisted transcript row reaches the live room this way regardless of which request
produced it (a turn reply, an ingestion note, a greeting, a proactive nudge) — so a second
device watching the same companion stays in sync, and a reaction placed by the user or the
companion itself shows up live.

---

## 7. Streaming method protocol (`ChatStreamEvent`)

The **stream**-marked methods (`messages.send`, `proposals.confirm`, `greeting.stream`)
emit zero or more `WsStreamMessage` frames — each `stream` field is a `ChatStreamEvent`
(discriminated on `type`, `contracts.ts`) — before the terminal `{ "result": { "done": true } }`.

| `type` | Payload | Meaning |
|--------|---------|---------|
| `composing` | — | The companion is composing a server-initiated message (typing cue; greeting). |
| `token` | `{ value: string }` | One token delta of the assistant turn. |
| `citations` | `{ citations: Citation[] }` | Sources grounding this turn, emitted once before `done`. |
| `tool_step` | `{ step: MessageDto }` | A read-only tool the companion just ran (persisted `tool_step` row). |
| `proposal` | `{ proposal: ProposalDto }` | The turn exited to hold an effectful action for approval. |
| `done` | `{ message: MessageDto }` | Terminal success carrying the persisted assistant message. |
| `reflection` | `{ message: MessageDto }` | A growth reflection posted right after the reply (crossed a growth band). |
| `error` | `{ message: string }` | Terminal failure — failures are data; render in place. |

Notes:
- The `tool_step`/`done`/`reflection` chunks carry the **persisted** row, so the live line
  and the row you'd get on reload via `messages.list` are byte-identical.
- These per-turn `ChatStreamEvent`s (request-scoped, by `id`) are distinct from the durable
  `companion` push events (§6, no `id`): the same row may arrive both as a stream `done`
  and, to *other* connected rooms, as a `companion` `message` event. Dedupe by id.
- All three streaming methods run through the connection's **serial chain** — a companion
  never runs two agent loops at once (D2′). A turn force-claimed mid-stream stops, the
  server pushes `embodiment.superseded` and closes `4002`, and the call still resolves
  `{ done: true }`.

---

## 8. Backpressure & limits

Tunable via env (`packages/api/src/config.ts`); defaults shown.

| Setting | Default | Effect |
|---------|---------|--------|
| `WS_MAX_PAYLOAD_BYTES` | 256 KiB | Max inbound frame; an oversized frame is rejected with close `1009` before parse. |
| `WS_MAX_IN_FLIGHT` | 32 | Max concurrent in-flight requests per connection; past it a frame is shed with `rate_limited` (§5). |
| `WS_HEARTBEAT_MS` | 10 000 | Heartbeat cadence — renews the embodiment claim **and** drives the live-event read (§6). |
| `WS_CLAIM_TTL_MS` | 30 000 | Embodiment claim TTL — the crash backstop if a holder dies without releasing. |

---

## 9. A minimal client session

```jsonc
// 1. Open: wss://host/ws?access_token=<jwt>&companion=<companionId>
//    (handshake authenticates + ownership-checks + claims the room)

// 2. Snapshot the transcript for live-merge
→ { "id": "1", "method": "messages.list" }
← { "id": "1", "result": { "messages": [ /* MessageDto[] */ ] } }

// 3. Send a turn (streaming)
→ { "id": "2", "method": "messages.send", "params": { "content": "hi" } }
← { "id": "2", "stream": { "type": "token", "value": "He" } }
← { "id": "2", "stream": { "type": "token", "value": "llo" } }
← { "id": "2", "stream": { "type": "done", "message": { /* MessageDto */ } } }
← { "id": "2", "result": { "done": true } }

// 4. Meanwhile, unsolicited live pushes (no id) may arrive at any time
← { "event": "companion", "data": { "type": "message", "message": { /* … */ } } }

// 5. If another device claims this companion
← { "event": "embodiment.superseded", "data": { "companionId": "…" } }
// …followed by socket close 4002. Do NOT auto-reconnect.
```

A reference client implementation (multiplexing, streaming generators, reconnect/backoff,
supersession handling) lives in `packages/web/src/api/ws.ts`.
