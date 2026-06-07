/**
 * The CLI {@link CapabilitySource} (companion-tools.md §3/§5) — host CLIs as a
 * second source over the shared spine, the structural twin of the MCP source.
 * The only difference is the transport: where the MCP source proxies over HTTP,
 * this runs a local subprocess through the {@link CommandSandbox}.
 *
 *  - `listCatalog`  — enumerate the tool store into lightweight catalog entries
 *    (short description for search; no argument schema). Refreshes the in-memory
 *    admissible-ref snapshot the sync `isAdmissible`/`adapt` checks consult.
 *  - `isAdmissible` — a tool is admissible iff it was present at the last refresh.
 *  - `resolveSnapshot` — read the tool's **fresh** definition at load time; the
 *    equipped snapshot carries the rich usage prompt + the argument schema.
 *  - `adapt` — return a tool that **re-reads the definition at call time** (so a
 *    removed tool folder is revoked immediately) and runs it through the sandbox.
 *
 * A whole-store enumeration failure propagates (catalog-builder keeps every stale
 * CLI row); a single missing tool resolves/adapts to "no longer available".
 */

import type { McpToolSnapshot, ToolCatalogEntry } from '@cobble/shared';

import type { CapabilitySource, CatalogContribution } from '../acquisition/capability-source.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { Tool } from '../tools/tool.js';
import type { EquippedToolRecord } from '../mcp/equipped-store.js';
import { cliToolName, runCliTool } from './adapter.js';
import type { CommandSandbox } from './sandbox.js';
import type { CliToolStore } from './tool-store.js';

export interface CliCapabilitySourceOptions {
  readonly toolStore: CliToolStore;
  readonly sandbox: CommandSandbox;
  /** Truncate returned text to this many characters (passed through to the adapter). */
  readonly maxChars?: number;
  /**
   * Deployment-wide run ceilings applied to any tool that declares no `limits` of
   * its own (CLI_TIMEOUT_MS / CLI_MAX_OUTPUT_BYTES, threaded through from config).
   */
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
  readonly logger?: Logger;
}

/** Build the CLI capability source from a tool store + a command sandbox. */
export function createCliCapabilitySource(options: CliCapabilitySourceOptions): CapabilitySource {
  const logger = options.logger ?? consoleLogger;
  // The set of refs admissible as of the last enumeration — the sync trust check.
  // Populated at startup (refreshCatalog) and kept current on the load path.
  let admissible = new Set<string>();

  return {
    source: 'cli',

    async listCatalog(): Promise<CatalogContribution> {
      const defs = await options.toolStore.list();
      admissible = new Set(defs.map((def) => def.ref));
      const entries: ToolCatalogEntry[] = defs.map((def) => ({
        toolId: cliToolName(def.ref),
        source: 'cli',
        serverRef: def.ref,
        toolName: def.ref,
        description: def.description,
      }));
      return { entries, retainStaleRefs: new Set<string>() };
    },

    isAdmissible(serverRef: string): boolean {
      return admissible.has(serverRef);
    },

    async resolveSnapshot(entry: ToolCatalogEntry): Promise<McpToolSnapshot | null> {
      const def = await options.toolStore.get(entry.serverRef);
      if (!def) {
        return null;
      }
      admissible.add(def.ref);
      // The equipped snapshot advertises the rich usage prompt + the arg schema;
      // the exec contract (binary/argv/limits) is re-read fresh at call time.
      return { name: cliToolName(def.ref), description: def.usage, inputSchema: def.parameters };
    },

    adapt(record: EquippedToolRecord): Tool | null {
      if (!admissible.has(record.serverRef)) {
        // Removed since it was equipped → drop it (revocation is immediate).
        return null;
      }
      const name = record.toolId;
      return {
        name,
        description: record.snapshot.description,
        parameters: record.snapshot.inputSchema,
        effectful: false,
        stepSummary: () => `Ran ${record.serverRef}`,
        run: async (args, ctx) => {
          // Re-read the definition from the trusted store at call time, so a tool
          // whose folder was removed since it was equipped is denied here.
          const def = await options.toolStore.get(record.serverRef);
          if (!def) {
            return { name, content: `Error: "${name}" is no longer available.`, isError: true };
          }
          return runCliTool(
            {
              def,
              sandbox: options.sandbox,
              ...(options.maxChars ? { maxChars: options.maxChars } : {}),
              ...(options.defaultTimeoutMs !== undefined
                ? { defaultTimeoutMs: options.defaultTimeoutMs }
                : {}),
              ...(options.defaultMaxOutputBytes !== undefined
                ? { defaultMaxOutputBytes: options.defaultMaxOutputBytes }
                : {}),
              logger,
            },
            args,
            ctx,
          );
        },
      };
    },
  };
}
