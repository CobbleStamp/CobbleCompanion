/**
 * The per-companion tool-registry resolver (companion-tools.md §4) — composes the
 * fixed core tools (native tools + search_tools/load_tool) with the companion's
 * **equipped** tools into one {@link ToolRegistry}, behind the same interface the
 * harness consumes. The harness calls this **per model step**, so a tool loaded
 * mid-turn appears on the next step. Each equipped tool is adapted on the fly by
 * its {@link CapabilitySource}; a tool whose source has since revoked it (a
 * de-whitelisted MCP server, a removed CLI tool) contributes nothing (revocation
 * takes effect immediately, even mid-conversation). A successful or failed call
 * bumps the tool's recency so the LRU keeps the tools actually in use
 * (equipped-store.ts).
 */

import { type CapabilitySource, indexCapabilitySources } from '../acquisition/capability-source.js';
import { consoleLogger, type Logger } from '../logging.js';
import { type Tool } from '../tools/tool.js';
import { ToolRegistry } from '../tools/registry.js';
import type { EquippedToolStore } from './equipped-store.js';

export interface EquippedRegistryResolverOptions {
  /** The always-present core tools: native tools + search_tools + load_tool. */
  readonly nativeTools: readonly Tool[];
  readonly equipped: EquippedToolStore;
  /** The capability sources that adapt equipped records into callable tools. */
  readonly sources: readonly CapabilitySource[];
  readonly logger?: Logger;
}

/**
 * Build a `resolveRegistry(companionId)` for the harness: core tools + the
 * companion's equipped (and still-admissible) tools. The harness degrades to its
 * static registry if this throws, so a store hiccup never breaks a turn.
 */
export function createEquippedRegistryResolver(
  options: EquippedRegistryResolverOptions,
): (companionId: string) => Promise<ToolRegistry> {
  const logger = options.logger ?? consoleLogger;
  const sources = indexCapabilitySources(options.sources);
  return async (companionId) => {
    const equipped = await options.equipped.list(companionId);
    const acquired: Tool[] = [];
    for (const record of equipped) {
      const source = sources.get(record.source);
      // `adapt` returns null when the record's source has revoked it → drop it.
      const base = source?.adapt(record) ?? null;
      if (!base) {
        continue;
      }
      acquired.push(withUsageTracking(base, options.equipped, companionId, record.toolId, logger));
    }
    return new ToolRegistry([...options.nativeTools, ...acquired], logger);
  };
}

/** Wrap a tool so a call bumps its recency (keeps the LRU honest). */
function withUsageTracking(
  base: Tool,
  equipped: EquippedToolStore,
  companionId: string,
  toolId: string,
  logger: Logger,
): Tool {
  return {
    ...base,
    async run(args, ctx) {
      const result = await base.run(args, ctx);
      // The tool was used regardless of outcome — record recency/frequency.
      await equipped.touch(companionId, toolId).catch((error: unknown) =>
        logger.error('failed to record equipped-tool usage', {
          operation: 'acquisition.equippedResolver.touch',
          companionId,
          toolId,
          error,
        }),
      );
      return result;
    },
  };
}
