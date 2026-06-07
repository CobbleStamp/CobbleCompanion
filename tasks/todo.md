# Phase 10 (CLI tool acquisition) — Task List

Vertical slices, in dependency order. Each slice ships tests + a commit, mirroring
how Phase 9 landed. Full design: `tasks/plan.md`.

## Slice 1 — CapabilitySource seam (MCP wrapped, unchanged)
- [ ] Define `CapabilitySource` interface (`source`, `listCatalogEntries`, `isAdmissible`, `resolveSnapshot`, `adapt`)
- [ ] Refactor `catalog-builder` to iterate `sources[]` (dispatch by `entry.source`)
- [ ] Refactor `load-tool` to resolve schema + admissibility via the entry's source
- [ ] Refactor `equipped-resolver` to adapt each record via its source
- [ ] `McpCapabilitySource` wrapping gateway + whitelist + `mcpToolToTool`/`mcpToolName`
- [ ] `buildMcpWiring` constructs the MCP source and passes `[mcpSource]`
- [ ] (optional) move source-agnostic spine files to `packages/core/src/acquisition/`
- [ ] **AC:** full Phase 9 suite + `phase9-dod.test.ts` pass unchanged; `tsc` clean
- [ ] ▶ **CHECKPOINT 1** — review: MCP provably unchanged

## Slice 2 — CommandSandbox + CLI tool-def loader + adapter (core, no wiring)
- [ ] `CommandSandbox` interface + `SubprocessSandbox` (spawn, no shell, scrubbed env, ephemeral per-tenant cwd, timeout + output cap + kill-on-exceed)
- [ ] `FakeCommandSandbox` for tests
- [ ] `loadCliToolDef(folder)` — parse + validate `TOOL.json` + `TOOL.md`; invalid → null + log
- [ ] `cliToolName(folder)` (reuse the `mcpToolName` charset/hash rule)
- [ ] `cliToolToTool({def, sandbox})` — validate args, render argv (separate elements), run, fence untrusted, `effectful:false`, never throws
- [ ] **AC (unit):** arg validation; injection-safe argv; truncation+fence; timeout; output cap; env scrubbed; bad folder → null+log

## Slice 3 — CliCapabilitySource on the refactored seams (core e2e)
- [ ] `CliCapabilitySource`: `listCatalogEntries` (scan `CLI_TOOLS_PATH`, skip+log invalid), `isAdmissible`, `resolveSnapshot` (re-read folder), `adapt` (re-read exec contract at call time)
- [ ] Confirm **no DB migration needed** (tables already carry `source`); add one only if a gap surfaces
- [ ] **AC (integration, temp fixture):** catalog builds; search→load equips; resolver adapts + call returns fenced output via fake sandbox; deleting folder revokes; MCP+CLI compose without collision
- [ ] ▶ **CHECKPOINT 2** — review: CLI flows end-to-end in core; MCP green

## Slice 4 — API wiring + config + Phase 10 DoD
- [ ] `config.ts`: `CLI_TOOLS_PATH` (+ scratch dir + default ceilings) → `AppConfig`; validate at startup, degrade to off if unreadable
- [ ] Generalize `buildMcpWiring` → `buildToolAcquisitionWiring` composing MCP + CLI `sources[]`; build `SubprocessSandbox`; null only when both off
- [ ] Wire `index.ts` + `test/helpers.ts`; `refreshCatalog` builds both sources at startup
- [ ] `packages/api/src/routes/phase10-dod.test.ts` (fixture path + injected `FakeCommandSandbox`): (1) discover→load→call+logged (2) unknown/invalid denied pre-spawn + audited (3) scaling: core-set-only advertised (4) survives restart (5) proactive-load hint
- [ ] One guarded `SubprocessSandbox` test against a real trivial binary (`node -e`)
- [ ] **AC:** DoD green; full suite ≥80% coverage; `make ci` clean; CLI off by default
- [ ] ▶ **CHECKPOINT 3** — review: DoD passes, feature off by default

## Slice 5 — Docs alignment
- [ ] `companion-tools.md`: status banner (CLI built); §3/§7 CLI rows present-tense; §6 `CLI_TOOLS_PATH`/`TOOL.md`+`TOOL.json` convention; §7 network-isolation limitation
- [ ] `development-plan.md`: Phase 10 → ✅ Done + Implemented note + status table; resolve CLI half of whitelist-governance open question
- [ ] `architecture.md` §9 + `implementation.md` §6: CLI built — `CommandSandbox`, `CapabilitySource`, `CLI_TOOLS_PATH`, config keys, deferred OS isolation
- [ ] `.env.example`: `CLI_TOOLS_PATH` (+ scratch/ceilings), RO/trusted note, example folder
- [ ] `product-overview.md`: confirm acquire-vs-combine copy still true (likely no change)
- [ ] **AC:** single-source preserved; doc sweep finds no "CLI not built/planned" conflicts
