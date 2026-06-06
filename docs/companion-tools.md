# CobbleCompanion — Tool Acquisition & Use

> **Canonical source for the tool-acquisition *mechanism*** — how the companion gains **new
> primitive abilities at runtime, without developer code changes or a redeploy**, and how that
> know-how is preserved in its knowledge base so the right tool resurfaces when needed.
>
> For the *product capability* (the acquire-vs-combine framing, why it matters) see
> `product-overview.md` §5.1/§5.3; for *scope, sequencing & acceptance* see `development-plan.md`
> (the **tool-acquisition workstream**); for how the generic primitives plug into the agent loop
> and the **trust model's** place beside propose→approve see `architecture.md` §4 / §8; for the
> **data model**, the MCP adapter, the CLI policy engine, and config keys see `implementation.md`.
> Each fact lives in exactly one place: this doc owns the **acquire → persist → retrieve → call**
> mechanism and the **whitelist trust model**; it does not redefine the schema, the loop, or the
> product vision.
>
> **Status — design, not yet built.** This is the design spec for a **post-PoC workstream**
> (`development-plan.md` §"Tool-Acquisition Workstream", Phases 9–10). The PoC (Phases 0–5) ships
> three hand-written tools (`web_fetch`, `memory_search`, `ingest_source`); this doc describes the
> mechanism that lets the toolset grow at runtime. Present tense describes the *designed* mechanism.

## 1. What it is

Today a new *primitive* ability means a developer hand-writes a `Tool` in TypeScript and wires it
into the registry at boot (`architecture.md` §3, the three tools). Procedural memory
(`companion-memory.md`, `architecture.md` §4.3) already lets the companion **combine** the
primitives it has — sequencing existing tools into a learned routine — but it cannot **acquire**
new ones.

Tool acquisition adds the missing **"acquire"** half. The companion gains new primitives the way a
person learns a new program: it is **told about an external tool** (a host CLI, or an MCP server),
it **learns to use it**, and it **remembers how** — so the next time the need arises, the right
tool resurfaces and is reused. No code change, no redeploy. Together, *acquire* (this doc) and
*combine* (procedural memory) are the complete self-extension story the product promises as the
companion's "growing repertoire of abilities" (`product-overview.md` §2.1, §5.5).

**Scope.** The **companion server host** only. Mobile/desktop OS-as-tools is a separate, later
product surface (§9, `development-plan.md` Phases 6–7).

## 2. The model — hands vs. know-how

The mechanism separates the *ability to execute* from the *knowledge of what to execute*:

- **Hands** — a small, fixed set of **generic primitives**, built once in code: one that drives any
  whitelisted CLI, and one that speaks to any whitelisted MCP server. These are the only new tools
  the developer ever writes for this feature.
- **Know-how** — everything specific to a particular tool is **learned data**, not code: *what*
  tools exist, *where* they are (endpoint / binary), *how* to invoke them, and *when* to reach for
  them. It lives in the companion's existing memory (§5) plus a small registry of live wiring (§4).

This decomposition has an architectural payoff that solves a scaling problem: a companion can know
about *many* tools, but a turn can only advertise a handful to the model. So each turn advertises
the **~handful of generic primitives + a retrieved shortlist** of relevant learned tools. The
companion's *effective* repertoire is unbounded while the per-turn context stays small — and it
reuses the same retrieval seam the companion already uses for memory (§5, invariant #3 holds: no
loop change).

## 3. Generic primitives (the hands)

Two new tools, built once, are the entire executable surface this feature adds:

| Primitive | Drives | Track |
|---|---|---|
| **`run_command`** | any **whitelisted** host CLI, with validated arguments | CLI (Phase 10) |
| **MCP connector** | any **whitelisted** HTTP/SSE **MCP server**; the server's own tools become callable | MCP (Phase 9) |

For the CLI, the *primitive* is always `run_command` and the specific command is *know-how* (data).
For MCP, each connected server is **self-describing** — `tools/list` returns typed tool schemas — so
its tools register as real, directly-callable tools; the know-how worth remembering is *when/why* to
reach for the server, not the call mechanics. This asymmetry is why the two tracks are designed and
shipped separately (§8).

## 4. The dynamic tool/connection registry (the wiring)

The PoC registry is a static array composed once at boot (`architecture.md` §3). Tool acquisition
refactors it into a **composition of capability sources** — native tools, connected MCP servers,
and learned CLI usages — behind the **unchanged** `list()` / `get()` interface the harness already
calls. Adding a source is additive; the loop is untouched.

The wiring is **persisted per-companion** (the `learned_tools` / connection store — data model in
`implementation.md`) and **rebuilt at startup**, so an acquired tool survives a restart. A
connected MCP server records its endpoint, an auth-secret *reference* (never the secret itself,
§7), its last `tools/list` snapshot, and status; a learned CLI records which whitelisted usage it
has gotten working.

## 5. Persisting & retrieving know-how

Acquisition writes into the companion's existing long-term memory — no new memory kind:

- **Semantic memory** — the tool's docs (a README, a `--help` dump, the user's description) are
  ingested through the existing pipeline (`architecture.md` §4.8), so "how this tool works" is
  recalled like any other knowledge.
- **Procedural memory** — a working invocation the companion got right is recorded as a learned
  routine (`procedural_memories`, `companion-memory.md`), so "how I successfully used it" resurfaces
  as a hint.

A **retrieval tool-arm** — a new arm on the `RetrieveContext` hook, composed alongside the existing
semantic/episodic/procedural arms (`architecture.md` §4.3, `composeRetrieveContext`) — surfaces the
**relevant** learned tools for the current turn: ask about images and the image-CLI know-how
surfaces; ask about stocks and the stock-data MCP surfaces. This is what makes the acquired
repertoire *functional* rather than merely stored, exactly as the procedural arm does for routines.

## 6. Trust model — the developer's whitelist

The entire trust decision is the **developer's whitelist**, made once, ahead of time. The developer
curates which CLIs (and which argument patterns) and which MCP servers (and which operations) the
companion may use. At runtime the outcome is **binary**:

| Usage | Outcome |
|---|---|
| Whitelisted **and** arguments validate | **Runs free** — any origin (autonomous or user-driven) |
| Off-whitelist, or arguments fail validation | **Denied** |

There is **no per-call approval, no read-only/effectful split, and no origin distinction** for
these generic tools — the whitelist *is* the approval. This is a **separate trust system** from the
product's propose→approve gate (`architecture.md` §4.4), which continues to govern consequential
outward actions (`book` · `send` · `pay`). The two coexist: the whitelist admits *which generic
capabilities exist at all*; propose→approve governs *named effectful tools*.

Two consequences are load-bearing:

- **Whitelist entries must be narrow** — a specific binary, constrained arguments, sandboxed output;
  specific MCP endpoints/operations. Because there is no runtime approval backstop, curation carries
  the full trust weight. A narrow whitelist also **bounds the experimentation space**: the companion
  may try different *validated* invocations to learn a tool, but no manipulation — including prompt
  injection through ingested content — can escape the whitelist into arbitrary execution.
- **Both tracks are developer-whitelisted, identically.** A user cannot point the companion at a
  brand-new CLI or MCP server on their own on the server host; admitting a tool is an operator
  action (data/policy, no code change, no redeploy). Learning to *use* a whitelisted tool is then
  fully autonomous, no developer in the loop. User-addable servers are deferred (§9).

## 7. Security

The whitelist is the admissibility floor; these boundaries harden what runs within it
(implementation → `implementation.md` §5, trust model → `architecture.md` §8):

- **CLI execution is sandboxed.** `run_command` runs in a per-tenant working directory with no
  access to other tenants' data or to secrets, under CPU/time/output ceilings (mirroring the
  `web_fetch` byte-cap posture). A whitelist reduces, but does not remove, the need for process
  isolation on a multi-tenant host.
- **MCP is HTTP/SSE-only** on the server host, behind the same **SSRF** guard as link ingestion
  (`architecture.md` §8): scheme + blocked-host checks with connection-layer DNS re-validation. No
  **stdio** transport — the host never spawns a user-specified process (that rides with the future
  desktop surface, §9).
- **Tool outputs are untrusted external data.** A CLI's stdout and an MCP server's results re-enter
  context as untrusted content and inherit the existing injection-hardening posture
  (`implementation.md` §2.1) — same class as `web_fetch` output and provider responses.
- **Credentials are references, never values.** MCP server auth uses the secret-management posture
  (`architecture.md` §8, `implementation.md` §5); a secret is never stored in the registry, in
  source, or sent to the model.

## 8. The two tracks & sequencing

The mechanism ships as two phases over one shared spine (the generic primitives, the dynamic
registry, and the retrieval tool-arm). Scope and acceptance are owned by `development-plan.md`:

- **MCP track (first).** Lower risk and largely a *registration + persistence* problem:
  self-describing schemas mean little trial-and-error. It exercises the full
  acquire → persist → retrieve → call spine end-to-end.
- **CLI track (second).** Higher power, more new machinery: the whitelist/argument-validation policy
  engine, the host sandbox, and the experimentation loop that captures a working invocation into
  semantic/procedural memory.

## 9. Beyond the PoC

Deferred from this workstream, recorded here so the boundary is explicit:

- **Mobile/desktop OS-as-tools** — exposing a device's OS access as tools is a separate product
  surface (`product-overview.md` §5.2, `development-plan.md` Phases 6–7), not part of the
  server-host mechanism.
- **stdio MCP transport** — spawning local MCP server processes belongs to the desktop surface,
  where the blast radius is the user's own machine.
- **User-addable tools** — letting a user (not the developer) point the companion at a new CLI or
  MCP server, with its own admission/trust flow.
- **Trust graduation** — a usage repeatedly exercised could *earn* wider latitude over time, rather
  than the whitelist being the only gate.
- **External-API cost metering** — the energy/stamina budget meters LLM/embedding tokens
  (`architecture.md` §4.8); the monetary cost of an external tool/MCP call is a new cost axis not
  yet metered.
