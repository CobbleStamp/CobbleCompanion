/**
 * A **capability source** (companion-tools.md §8) — one origin of acquirable
 * tools that plugs into the shared discover → load → call → remember spine. The
 * spine is source-agnostic: the catalog, `search_tools`, the equipped set, the
 * per-step registry, and proactive loading all work the same regardless of where
 * a tool comes from. Each source supplies only the three operations that *are*
 * source-specific:
 *
 *  - **enumerate** its tools into the lightweight catalog (`listCatalog`),
 *  - **resolve** a tool's authoritative schema at load time (`resolveSnapshot`),
 *  - **adapt** an equipped tool into a callable {@link Tool} (`adapt`),
 *
 * plus an **admissibility** check (`isAdmissible`) the catalog/registry consult so
 * a tool whose source revoked it (a de-whitelisted MCP server, a removed CLI tool
 * folder) is never advertised or dispatched.
 *
 * Phase 9 ships one implementation (MCP, ./mcp/mcp-source.ts); Phase 10 adds a
 * second (CLI). The two differ only in transport — MCP proxies over HTTP, CLI
 * runs a local subprocess — so they compose into one catalog and one registry
 * without either knowing about the other.
 */

import type { McpToolSnapshot, ToolCatalogEntry, ToolSource } from '@cobble/shared';

import type { EquippedToolRecord } from './equipped-store.js';
import type { Tool } from '../tools/tool.js';

/**
 * What one source contributes to a catalog refresh: the entries it currently
 * advertises, plus the `serverRef`s it knows are admissible but could **not**
 * enumerate this pass (e.g. an MCP server was unreachable). The builder preserves
 * the existing catalog rows for those refs rather than pruning them — "stale beats
 * gone", so a transient outage never empties the catalog (catalog-builder.ts).
 */
export interface CatalogContribution {
  readonly entries: readonly ToolCatalogEntry[];
  readonly retainStaleRefs: ReadonlySet<string>;
}

/** One origin of acquirable tools (MCP servers, host CLIs). */
export interface CapabilitySource {
  /** Which source kind this is — the discriminant catalog/equipped rows carry. */
  readonly source: ToolSource;
  /**
   * Enumerate this source's catalog entries for a refresh. Best-effort: a partial
   * outage should surface what it can and flag the rest via `retainStaleRefs`
   * rather than throwing; a total failure may throw (the caller keeps every stale
   * row for this source).
   */
  listCatalog(): Promise<CatalogContribution>;
  /**
   * Whether a `serverRef` is admissible **right now** — the live trust check the
   * catalog stub can never widen (an MCP whitelist lookup, a CLI tool-folder
   * presence check). Consulted at load, at registry resolution, and by the
   * equipped-summary arm so a revoked tool is never advertised or dispatched.
   */
  isAdmissible(serverRef: string): boolean;
  /**
   * Fetch the **authoritative** snapshot (name + description + argument schema)
   * for a catalog entry at `load_tool` time — never trusting the catalog stub —
   * or `null` when the tool is no longer offered. MCP fetches it from the server;
   * CLI reads it from the tool's definition folder.
   */
  resolveSnapshot(entry: ToolCatalogEntry): Promise<McpToolSnapshot | null>;
  /**
   * Adapt an equipped record into a callable {@link Tool}, or `null` when the
   * record's `serverRef` is no longer admissible (revoked since it was equipped).
   * The returned tool proxies the call over this source's transport.
   */
  adapt(record: EquippedToolRecord): Tool | null;
}

/** Index sources by their `source` discriminant for per-entry dispatch. */
export function indexCapabilitySources(
  sources: readonly CapabilitySource[],
): ReadonlyMap<ToolSource, CapabilitySource> {
  const byKind = new Map<ToolSource, CapabilitySource>();
  for (const source of sources) {
    byKind.set(source.source, source);
  }
  return byKind;
}
