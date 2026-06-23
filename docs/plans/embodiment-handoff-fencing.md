# Implementation plan: embodiment handoff fencing (ULID lease)

> **Status: delivered.** Steps 1–6 are implemented — `holdsLease` threads from
> `streaming.ts` into `Harness.runTurn`/`continueAfterApproval`; `runLoop` re-checks the
> lease at the top of every iteration and before each persisting exit (`finish` /
> `finishBlocked`), standing down without writing the reply (option (a), the pre-write
> re-check) and skipping the post-turn affect nudge; the streaming method pushes
> `embodiment.superseded` and closes immediately. Tests: `harness.embodiment.test.ts`
> (core, deterministic via the injected callback) + the mid-turn case in
> `ws/embodiment.test.ts` (api). **Q1 remains deferred:** the genuine two-connection
> concurrent-write interleaving needs the real-Postgres/testcontainers suite (§3, §6).

> **Scope.** Make the WS embodiment handoff correct for **multi-node** without
> blocking the new connection or adding a push channel. Design is canonical in
> `deliver-scalability.md` §5.2 (updated); this is the build plan. The job-queue
> lease (`companion_claims`) is a **separate** mechanism with the same fencing
> principle — noted at the end, not fixed here.

## 1. The gap this closes

The companion's live embodiment is a single WS connection holding a ULID lease
(`active_embodiment.connection_id`, fenced by a monotonic `claim_seq`). Today the lease is enforced **per request**
(`companionOf → requireEmbodiment → embodiment.holds`, `ws/fencing.ts`), but **not
inside a running turn**:

- A turn is a multi-step agent loop (`harness.ts:675`), not one request. Once it is
  past the entry `holds()` check it keeps running and writing even after a newer
  connection has force-claimed the companion.
- Turns are serialized **per connection** (`WsConnection.runSerial`), not per
  companion across connections — so the old connection's in-flight turn and the new
  connection's turn can run **concurrently for the same companion**.
- The old connection only closes on its **next heartbeat** (`register.ts:112`, up to
  `wsHeartbeatMs` ≈ 10s), so it lingers after being superseded.

Result: two agent loops can briefly write the same companion's derived state (e.g. a
double `driveWeights` nudge, duplicate transcript rows) — violating the
single-embodiment invariant the model exists to provide.

## 2. The design (per §5.2)

- **ULID `connection_id` is the lease**, lexically comparable; "newer wins" (a
  DB-stamped monotonic `claim_seq` is the fencing key against ULID recurrence).
- **New connection goes live immediately** — claim is one DB upsert; no blocking, no
  ack, no NOTIFY.
- **Old self-ends via a per-iteration lease check**: at the top of every agent-loop
  iteration the turn re-reads the lease and stops if a newer `connection_id` holds it.
- **Connection-fenced writes** are the correctness backstop for the one in-flight step
  that may finish after the handoff lands.
- **TTL** collects a holder that is dead and never runs another iteration.
- **Bounded overlap:** at most one in-flight iteration; harmless under the write
  fence; the two connections stream to different clients.

## 3. Build steps (each independently green)

### Step 1 — Lease-check seam in the embodiment store
`embodiment.holds(companionId, connectionId, claimSeq)` already answers "am I still the holder?" (a
single PK read on `active_embodiment`). Reuse it as-is; no schema change (the
`connection_id` ULID + `claim_seq` columns already exist). Confirm it is cheap enough to
call once per loop iteration (indexed PK lookup — yes).

### Step 2 — Per-iteration self-check in the agent loop  *(core)*
- Add an optional `holdsLease?: () => Promise<boolean>` to `RunTurnParams` /
  `ContinueAfterApprovalParams` (`harness.ts`).
- In `runLoop`, at the **top of each iteration** (by `harness.ts:675`, alongside the
  existing budget `exhausted` check), call it; if it returns false, **end the turn
  cleanly without writing the assistant message** — emit a terminal
  `{ type: 'superseded' }`-style event (or just `return`) so the stream closes. Reuse
  the existing `signal`/abort plumbing for in-flight LLM stream teardown.
- Re-check immediately **before `finish()`'s assistant append** (`harness.ts:892`) so
  a turn that lost the lease during its last LLM call does not write its reply.

### Step 3 — Connection-fenced writes (correctness backstop)  *(core)*
Enumerate the in-turn writes and gate them on the held lease:
- assistant message + tool-step summaries + proposal preambles
  (`memory.appendMessage` at `harness.ts:892/869/921/931`);
- the affect-loop `driveWeights` nudge (`reinforceFromDelta`, the non-idempotent one).

Decision to make (layering): either (a) **pre-write `holdsLease()` re-check** (simple;
a tiny TOCTOU window — acceptable single-node, the bounded overlap), or (b) a
**conditional write** that commits only while the lease row still names this connection
(robust at N nodes; couples the write to the lease — do via a guarded
`INSERT … WHERE EXISTS (SELECT 1 FROM active_embodiment WHERE companion_id = ? AND
connection_id = ? AND claim_seq = ?)`). **Recommendation:** ship (a) now (single-node MVP), adopt (b) as part
of the multi-node (D7) hardening; the bounded-overlap note in §5.2.5 documents the
residual until then.

### Step 4 — Prompt old-connection shutdown  *(api/ws)*
- In the streaming method (`ws/methods/streaming.ts`), pass
  `holdsLease: () => deps.embodiment.holds(companionId, binding.connectionId, binding.claimSeq)` into
  `harness.runTurn` / `continueAfterApproval`.
- When the turn ends because the lease moved, the connection pushes
  `embodiment.superseded` and **closes immediately** — no waiting for the heartbeat.
- Idle old connection (not mid-turn): the existing per-request `holds()` already
  rejects its requests; optionally have a `not_embodied` rejection also close the
  socket so it doesn't linger to the heartbeat.

### Step 5 — New connection goes live immediately  *(api/ws, mostly confirm)*
- `register.ts` already claims + binds on connect; keep it. Optionally emit an
  `embodiment.ready` confirmation after `bindEmbodiment` so the client has a positive
  "you hold it" signal instead of relying on socket-open (`ws.ts` currently sends on
  `onopen`). Low-risk polish; the per-request `holds()` already makes early frames
  safe (they reject until bound).

### Step 6 — Tests
- **core/harness:** a multi-iteration turn whose `holdsLease` flips to false mid-turn
  stops at the next iteration, emits no further tokens, and writes no assistant
  message. (Deterministic — the callback is injected.)
- **core:** connection-fenced write skipped/rejected when the lease has moved (PGlite: flip
  the `active_embodiment.connection_id` row, assert the append/nudge does not land).
- **api/ws:** supersede a connection mid-turn → old receives `embodiment.superseded`
  + close; new is live and its turn streams.
- **Q1 (deferred, real Postgres):** the genuine two-connection concurrent-write
  interleaving — PGlite is single-connection and cannot stage it; folds into the
  testcontainers suite alongside the job-lease and event-log gap tests.

## 4. Non-goals / residuals
- **No NOTIFY, no blocking handoff** — rejected in §5.2.3 (all cost, no extra safety
  given the write fence).
- **Bounded one-iteration overlap remains** by design; the write fence makes it
  harmless.
- **Job-queue lease (`companion_claims`) is out of scope** but shares the principle:
  its drain loop also discards `renewClaim`'s result and never checks `generation`
  (the open "C2" review finding). When we harden it, factor a shared
  "fence-on-token" helper. Track separately.

## 5. Verification gate
All packages typecheck; core + api + db + web suites green; the new harness/ws
fencing tests pass; no migration required.
