/**
 * Build the tool catalog from the configured capability sources (companion-tools.md
 * §5) — source-agnostic. Each {@link CapabilitySource} enumerates its tools into
 * lightweight catalog entries (id + name + description — no argument schema); the
 * builder upserts them and prunes entries no longer advertised. Runs at startup
 * and on a whitelist/definition change. A source that can't enumerate (a whole
 * source threw, or it flagged a `serverRef` it couldn't reach) keeps its existing
 * entries — "stale beats gone", so a transient outage never empties the catalog.
 */

import type { ToolSource } from '@cobble/shared';

import { type CapabilitySource, indexCapabilitySources } from '../acquisition/capability-source.js';
import { consoleLogger, type Logger } from '../logging.js';
import type { ToolCatalogStore, ToolCatalogEntry } from './tool-catalog-store.js';

export interface RefreshCatalogOptions {
  /** The capability sources to index (MCP, CLI, …). */
  readonly sources: readonly CapabilitySource[];
  readonly catalog: ToolCatalogStore;
  readonly logger?: Logger;
}

/**
 * Refresh the catalog to mirror the current sources. Returns the number of tools
 * indexed. Best-effort per source: a source that fails to enumerate keeps its
 * prior entries rather than dropping them.
 */
export async function refreshToolCatalog(options: RefreshCatalogOptions): Promise<number> {
  const logger = options.logger ?? consoleLogger;
  const indexed: ToolCatalogEntry[] = [];
  const retainStaleRefs = new Set<string>();
  const failedSources = new Set<ToolSource>();

  for (const source of options.sources) {
    try {
      const contribution = await source.listCatalog();
      indexed.push(...contribution.entries);
      for (const ref of contribution.retainStaleRefs) {
        retainStaleRefs.add(ref);
      }
    } catch (error) {
      // Total source failure: keep every existing row for this source.
      failedSources.add(source.source);
      logger.error('catalog refresh: a source failed to enumerate; keeping its stale entries', {
        operation: 'acquisition.refreshCatalog',
        source: source.source,
        error,
      });
    }
  }

  await options.catalog.upsert(indexed);
  await pruneStale(options.catalog, retainStaleRefs, failedSources, indexed, logger);
  return indexed.length;
}

/**
 * Drop catalog rows that are no longer valid. Keep a row if it was just
 * (re)indexed, if its `serverRef` was flagged retain-stale by its source (admissible
 * but unreachable this pass), or if its whole source failed to enumerate. Anything
 * else — a tool a reachable source stopped advertising, or a row whose source left
 * the configuration — is pruned.
 */
async function pruneStale(
  catalog: ToolCatalogStore,
  retainStaleRefs: ReadonlySet<string>,
  failedSources: ReadonlySet<ToolSource>,
  indexed: readonly ToolCatalogEntry[],
  logger: Logger,
): Promise<void> {
  const existing = await catalog.list();
  const freshIds = new Set(indexed.map((entry) => entry.toolId));
  const keep: string[] = [];
  for (const entry of existing) {
    if (
      freshIds.has(entry.toolId) ||
      retainStaleRefs.has(entry.serverRef) ||
      failedSources.has(entry.source)
    ) {
      keep.push(entry.toolId);
    }
  }
  await catalog.deleteNotIn(keep);
  const pruned = existing.length - keep.length;
  if (pruned > 0) {
    logger.info('catalog refresh: pruned stale tool entries', {
      operation: 'acquisition.refreshCatalog',
      pruned,
    });
  }
}

// Re-export so callers building the source map share one helper.
export { indexCapabilitySources };
