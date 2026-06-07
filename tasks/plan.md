# Phase 10 — Runtime Tool Acquisition: CLI track — Implementation Plan

> Status: **draft for review**. Scope/sequencing owned by `docs/development-plan.md`
> (Phase 10); mechanism by `docs/companion-tools.md`. This plan is a transient
> working artifact — it is not part of the canonical doc set.

## 1. Goal & frame

Add **host CLIs as a second capability source** to the discover → load → call →
remember spine that Phase 9 already built for MCP. A CLI tool behaves *just like*
an MCP tool — it has a prompt + parameter schema, it flows through the same
`search_tools → load_tool → call` path, it lives in the equipped set under the
LRU, and it is remembered/proactively re-loaded by the existing procedural-memory
spine. **The only difference is the transport at the leaf:** an MCP tool's call
goes out over HTTP to a remote server; a CLI tool's call goes down into a local
**subprocess sandbox**.

**Done when** (DoD, from `development-plan.md` Phase 10): a developer drops a tool
folder under `CLI_TOOLS_PATH`; on a relevant turn the companion
`search_tools → load_tool → calls` it; the equipped CLI tool **survives a
restart**; an **unknown/invalid** tool is denied before any process spawns;
output is **sandboxed + untrusted**; **every call is logged**; and a recalled
procedural routine naming the CLI tool surfaces a **proactive-load** hint.

## 2. Resolved design decisions (settled with the user)

1. **Sandbox = portable subprocess + ceilings**, behind a `CommandSandbox` seam:
   `spawn` (never a shell), explicit **argv array**, scrubbed env (no secrets),
   per-tenant **ephemeral working dir**, time/CPU/output ceilings, output captured +
   truncated + fenced as untrusted. Cross-platform (macOS dev, current CI, Linux
   prod). OS-level isolation (namespaces/containers) is **deferred to Phase 8**.
2. **CLI = per-capability loadable tools, symmetric with MCP.** `run_command` is
   the **internal** sandboxed executor; the model-facing surface is named CLI
   tools (`cli__<name>`) that delegate to it. No raw free-form command tool.
3. **Tool definitions live as folders under `CLI_TOOLS_PATH`** (the "skills"
   convention). One folder = one tool:
   - `TOOL.md` — the developer-authored **usage prompt** (the rich description the
     model reads once the tool is equipped). The CLI analogue of an MCP server's
     self-description.
   - `TOOL.json` — the **machine contract**: `binary`, short `description` (for the
     catalog), `parameters` (JSON Schema — the model-facing args), `argv` (template
     mapping validated params → **separate argv elements**), optional `limits`.
   - A folder is valid only with **both** files present and parseable.
4. **No probe harness, no doc-ingestion in the PoC.** "Learning" reuses the
   existing procedural-memory + load-advisor spine, identical to MCP. `TOOL.md`
   *is* the authored usage knowledge. (Ingesting `TOOL.md`/`--help` into semantic
   memory → Beyond the PoC.)
5. **Refactor the three MCP-only seams into a source-polymorphic
   `CapabilitySource`** rather than duplicating the spine.

### Security constraints (load-bearing — must hold)

- **`CLI_TOOLS_PATH` is read-only, deployment-controlled** (baked image or RO
  mount). It must **not** overlap any path the app writes to (uploads, ingestion
  temp, the execution scratch dir). Whoever can write there can admit a binary →
  the trust model is the folder set.
- **Execution scratch dir is separate**: writable, per-tenant, ephemeral, cleaned
  up after each run; never `CLI_TOOLS_PATH`.
- **No shell, ever.** `{param}` placeholders become individual argv elements;
  values are schema-validated first. A value like `; rm -rf /` is an inert
  argument, never a command. The `binary` is fixed by the file; the model cannot
  choose it. Resolve `binary` to an absolute path / configured bin dir, not a
  mutable `PATH`.
- **Re-read the exec contract from the trusted folder at call time** (not from a
  persisted snapshot), so removing a folder revokes the tool immediately — the CLI
  analogue of de-whitelisting an MCP server.

### Known, accepted limitation (document it)

The portable subprocess sandbox **does not enforce network isolation** on macOS
(no namespaces). Mitigation: narrow whitelist + trusted `CLI_TOOLS_PATH` + fixed
binary. Real network/FS isolation is a Phase 8 hardening item behind the same
`CommandSandbox` seam. This must be stated in `companion-tools.md` §7 and
`implementation.md`, not left implicit.

## 3. What the spine already gives us (no change)

- `search_tools` — source-agnostic LLM lookup over catalog text.
- equipped set + per-step registry + LRU (`equipped-store.ts`) — keyed on
  `toolId`/`source`/`snapshot`; `ToolSource` is already `'mcp' | 'cli'` and the
  `tool_catalog`/`equipped_tools` tables already carry a `source` column.
- `load-advisor` + procedural retrieval — proactive loading, source-agnostic.
- propose→approve stays out of the way (`effectful: false`, like MCP tools).

**No DB migration is expected** — the existing tables already model both sources.
(Confirm during Slice 3; add one only if a gap surfaces.)

## 4. The `CapabilitySource` abstraction (the core refactor)

A small interface the three seams iterate over, keyed by `source`:

```ts
interface CapabilitySource {
  readonly source: ToolSource;                       // 'mcp' | 'cli'
  listCatalogEntries(): Promise<readonly ToolCatalogEntry[]>;  // MCP: tools/list per server; CLI: scan CLI_TOOLS_PATH
  isAdmissible(serverRef: string): boolean;          // MCP: whitelist.isAllowed; CLI: folder exists + valid
  resolveSnapshot(entry: ToolCatalogEntry): Promise<McpToolSnapshot | null>; // fresh schema at load; null = gone
  adapt(record: EquippedToolRecord): Tool;           // MCP: mcpToolToTool; CLI: cliToolToTool(sandbox)
}
```

- `McpToolSnapshot` (`{name, description, inputSchema}`) is already generic enough
  to hold a CLI tool's name / `TOOL.md` / `TOOL.json.parameters`. The CLI
  exec contract (`binary`/`argv`/`limits`) is **not** persisted in the snapshot —
  `adapt` re-reads it from the folder at call time (see security constraints).
- `serverRef` = "where this tool comes from": an MCP server ref, or a CLI tool
  **folder name**.
- The refactored `catalog-builder`, `load-tool`, and `equipped-resolver` accept
  `sources: CapabilitySource[]` and dispatch by `entry.source`. MCP behaviour must
  be **byte-for-byte unchanged** (proven by the Phase 9 suite + DoD).

**Recommended file layout** (organize by domain; optional churn but cleaner):
move the now-source-agnostic spine to `packages/core/src/acquisition/`
(`capability-source.ts`, `catalog-builder.ts`, `load-tool.ts`, `search-tools.ts`,
`equipped-resolver.ts`, `equipped-store.ts`, `tool-catalog-store.ts`,
`load-advisor.ts`); keep MCP-specific files in `mcp/` (`gateway.ts`, `adapter.ts`,
`whitelist.ts`, `fake.ts`, new `mcp-source.ts`); add `cli/` for the new CLI bits.
If the moves prove noisy, the abstraction can land in place under `mcp/` — the
functional requirement is the interface + dispatch, not the directory.

## 5. Dependency graph

```
Slice 1 (CapabilitySource refactor; MCP wrapped, unchanged)
   │
   ├─> Slice 2 (CommandSandbox + TOOL.json/TOOL.md loader + cliToolToTool)   [parallelizable with 1's tail]
   │        │
   └────────┴─> Slice 3 (CliCapabilitySource: scan + resolve + adapt, on the refactored seams)
                    │
                    └─> Slice 4 (API wiring + CLI_TOOLS_PATH config + Phase 10 DoD)
                            │
                            └─> Slice 5 (docs alignment)
```

## 6. Vertical slices

### Slice 1 — `CapabilitySource` seam; MCP wrapped, behaviour unchanged
**Build:** Define `CapabilitySource`. Refactor `catalog-builder` / `load-tool` /
`equipped-resolver` to take `sources: CapabilitySource[]` and dispatch on
`entry.source`. Wrap existing MCP logic as `McpCapabilitySource` (gateway +
whitelist + `mcpToolToTool` + `mcpToolName`). Update `buildMcpWiring` to construct
the MCP source and pass `[mcpSource]`.
**Acceptance:** the **entire Phase 9 suite + `phase9-dod.test.ts` pass unchanged**;
`tsc --noEmit` clean across all projects; no behaviour difference for MCP (an
off-whitelist load still denied before the gateway; restart still works).
**Verify:** `npx vitest run packages/core packages/api`; `make ci`.

> **CHECKPOINT 1** — refactor is green and MCP is provably unchanged before any
> CLI code lands. Stop and review.

### Slice 2 — `CommandSandbox` executor + CLI tool-def loader + adapter (core only, no wiring)
**Build:**
- `CommandSandbox` interface + `SubprocessSandbox` (`node:child_process.spawn`,
  no shell; scrubbed env; per-tenant ephemeral cwd created + removed; `timeoutMs`,
  `maxOutputBytes`, kill-on-exceed; returns `{stdout, exitCode, timedOut,
  truncated}`). + `FakeCommandSandbox` for tests (mirrors `FakeMcpGateway`).
- `loadCliToolDef(folder)` — read + validate `TOOL.json` (`binary`, `description`,
  `parameters` JSON Schema, `argv` template, optional `limits`) and `TOOL.md`;
  invalid/incomplete folders return null + log (never throw).
- `cliToolName(folder)` (`cli__<folder>`, provider-charset + 64-char/hash cap,
  reusing the `mcpToolName` rule) and `cliToolToTool({def, sandbox, maxChars})` —
  mirrors `mcpToolToTool`: validate args against `parameters`, render argv (each
  `{param}` → its own element; reject unfilled/extra placeholders), run via the
  sandbox, **fence stdout as untrusted** (reuse `stripSentinels`/`UNTRUSTED_*`),
  `effectful: false`, never throws (failures → error `ToolResult`).
**Acceptance (unit tests):** schema validation rejects bad args; argv rendering is
injection-safe (separate elements; shell metacharacters inert); output truncated +
fenced; timeout → `timedOut` error result; output cap honored; env contains no
secrets; missing/invalid TOOL files → null + logged.
**Verify:** `npx vitest run packages/core/src/cli`.

### Slice 3 — `CliCapabilitySource` on the refactored seams (core e2e against the fake sandbox)
**Build:** `CliCapabilitySource` implementing the four ops:
`listCatalogEntries` (scan `CLI_TOOLS_PATH`; one entry per valid folder; skip+log
invalid — "stale beats gone" parity with the MCP catalog builder),
`isAdmissible` (folder present + valid), `resolveSnapshot` (re-read folder →
`{name, description: TOOL.md, inputSchema: parameters}`), `adapt`
(`cliToolToTool`, re-reading the exec contract from the folder at call time).
**Acceptance (core/integration tests, temp fixture dir):** catalog builds from a
fixture `CLI_TOOLS_PATH`; `search_tools → load_tool` equips a CLI tool; the
per-step resolver adapts it and a call returns fenced output via the
`FakeCommandSandbox`; **deleting the folder revokes** the tool (resolver drops it,
load denied); MCP + CLI sources compose in one catalog/registry without collision.
**Verify:** `npx vitest run packages/core`.

> **CHECKPOINT 2** — a CLI tool flows discover → load → call end-to-end in core
> against the fake sandbox, MCP still green. Review before API wiring.

### Slice 4 — API wiring + config + Phase 10 DoD
**Build:**
- `config.ts`: `CLI_TOOLS_PATH` → `AppConfig.cliToolsPath` (default `''` = off);
  scratch root (e.g. `CLI_SCRATCH_DIR`) + default ceilings (`CLI_TIMEOUT_MS`,
  `CLI_MAX_OUTPUT_BYTES`). Validate the path at startup; log + run with CLI off if
  missing/unreadable (don't crash boot).
- Generalize `buildMcpWiring` → `buildToolAcquisitionWiring`: compose the MCP
  source (when `mcpServers` non-empty) **and** the CLI source (when `cliToolsPath`
  set) into one `sources[]`; build the `SubprocessSandbox`. Returns null only when
  **neither** source is configured (behaviour unchanged when both off).
  `refreshCatalog()` rebuilds from all sources.
- `index.ts` + `test/helpers.ts`: wire the generalized builder; `refreshCatalog`
  at startup builds MCP + CLI.
- **`packages/api/src/routes/phase10-dod.test.ts`** (mirror `phase9-dod.test.ts`),
  using a temp `CLI_TOOLS_PATH` fixture + an **injected `FakeCommandSandbox`** for
  determinism/cross-platform (Phase 9 used `FakeMcpGateway` the same way):
  1. **discover → load → call**: `search_tools → load_tool → cli__<tool>` returns
     the expected output; `search_tools`, `load_tool`, and the namespaced CLI tool
     are all in `tool_calls`.
  2. **unknown/invalid denied**: a `tool_id` with no folder is denied **before any
     spawn**; the attempt is still audited.
  3. **scaling**: only the core set (native + `search_tools`/`load_tool`) is
     advertised regardless of catalog size; no `cli__` tool until loaded.
  4. **survives restart**: a cold app instance over the same DB calls a CLI tool
     loaded by the previous one (registry rebuilt from the equipped row; exec
     contract re-read from the trusted folder).
  5. **remember**: a recalled procedural routine naming the CLI tool surfaces a
     proactive-load hint (load-advisor), proving the "remember" half.
- One **non-fake** test exercising `SubprocessSandbox` against a trivial portable
  binary (e.g. `node -e`), guarded so it's skippable where unavailable.
**Acceptance:** `phase10-dod.test.ts` green; full `core`+`api`+`db` suites green at
**≥80% coverage**; `make ci` clean; CLI **off by default** (empty `CLI_TOOLS_PATH`
→ behaviour identical to today).
**Verify:** `make ci`.

> **CHECKPOINT 3** — Phase 10 DoD passes; feature off by default. Review before docs.

### Slice 5 — Docs alignment
**Build (mirrors the Phase 9 doc pattern):**
- `companion-tools.md`: status banner → CLI track built; make the CLI rows in
  §3/§7 present-tense; document `CLI_TOOLS_PATH` folder convention
  (`TOOL.md`/`TOOL.json`) + the per-folder = per-tool model in §6; state the
  **network-isolation limitation** in §7.
- `development-plan.md`: Phase 10 status → ✅ Done; add an **Implemented** note;
  flip the Phase 10 row in the table; resolve the CLI half of the whitelist-
  governance open question (`CLI_TOOLS_PATH`, filesystem/config, redeploy-to-admit).
- `architecture.md` §9 + `implementation.md` §6: CLI track **built** — name the
  `CommandSandbox`/`SubprocessSandbox`, the `CapabilitySource` abstraction, the
  `CLI_TOOLS_PATH` convention + config keys, and the deferred OS-level isolation.
- `.env.example`: document `CLI_TOOLS_PATH` (+ scratch/ceiling vars), the
  read-only/trusted requirement, and an example folder.
- `product-overview.md`: confirm the acquire-vs-combine capability copy still reads
  true (likely no change).
**Acceptance:** single-source preserved (mechanism in `companion-tools.md`, status
in `development-plan.md`); doc-set sweep finds no "CLI not built / planned"
conflicts; `/consolidate-doc` not needed.
**Verify:** grep sweep for stale CLI-unbuilt claims; manual read.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `CLI_TOOLS_PATH` writable by app/tenant → arbitrary binary admission | Hard constraint: RO, deployment-controlled, non-overlapping; assert at startup; document |
| No network isolation in the portable sandbox | Narrow whitelist + fixed binary; note as accepted PoC limitation; OS sandbox → Phase 8 |
| argv template too weak for real CLIs (optional flags, variadic) | PoC supports positional/named substitution + documented convention; richer template language flagged as possible follow-up |
| Subprocess resource exhaustion (fork bombs, huge output, hung process) | Output byte cap + kill-on-exceed; wall-clock timeout; ephemeral cwd with disk cap; (CPU cgroup → Phase 8) |
| Slice 1 refactor silently changes MCP behaviour | CHECKPOINT 1: Phase 9 DoD + full MCP suite must pass unchanged before CLI code |
| Binary resolved via mutable PATH | Resolve to absolute path / configured bin dir; reject relative/PATH lookup |

## 8. Out of scope (Beyond the PoC)

OS-level sandbox (namespaces/containers) + network isolation; ingesting tool docs
into semantic memory; a dedicated experimentation/probe harness; multi-tool "packs"
in one folder; runtime DB-backed CLI admission + operator UI; directory hot-reload
/ watch; external-tool cost metering.

## 9. Verification summary

- Per-slice: `npx vitest run <paths>` + `tsc --noEmit`.
- Gate (CHECKPOINT 3): `make ci` (lint + typecheck + `test:coverage` ≥80%).
- DoD: `packages/api/src/routes/phase10-dod.test.ts` green.
- Iron Laws (`AGENTS.md`): no merge without tests ≥80%, explicit types, evidence
  before claims, single-source docs.
