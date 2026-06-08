/**
 * The `search_tools` core tool (companion-tools.md §5) — how the companion finds
 * a tool for a job without carrying the whole catalog in context. It runs a cheap
 * LLM lookup **off the main loop** (its own one-shot call) over the lightweight
 * catalog and returns a ranked shortlist of ids + one-liners — never argument
 * schemas. The model then `load_tool`s one of the ids. `effectful: false`: search
 * takes no action, so it is never gated. Never throws — failures become results.
 */

import type { ToolResult } from '../harness/hooks.js';
import type { LlmGateway } from '../llm/gateway.js';
import { consoleLogger, type Logger } from '../logging.js';
import {
  render,
  SELECT_TOOLS,
  toolSearchTemplate,
  type ToolSearchCatalogItem,
} from '../prompts/index.js';
import type { VitalityStore } from '../quota/vitality-store.js';
import { readStringArg, type Tool } from '../tools/tool.js';
import { createUsageAccumulator, meteredLlmGateway } from '../usage.js';
import type { ToolCatalogStore } from './tool-catalog-store.js';

export interface SearchToolsOptions {
  readonly catalog: ToolCatalogStore;
  readonly gateway: LlmGateway;
  /** Cheap model for the lookup (reuse the ingestion model). */
  readonly model: string;
  /** How many matches to return as the shortlist (default 5). */
  readonly topK?: number;
  /** Bills the lookup to the owner's stamina; omit = unmetered (tests). */
  readonly quota?: VitalityStore;
  readonly logger?: Logger;
}

const DEFAULT_TOP_K = 5;

export function createSearchToolsTool(options: SearchToolsOptions): Tool {
  const logger = options.logger ?? consoleLogger;
  const topK = options.topK ?? DEFAULT_TOP_K;
  return {
    name: 'search_tools',
    description:
      'Find tools that could do a job. Describe the job in plain language; returns a ' +
      'ranked shortlist of tool ids you can then load with load_tool. Use this when ' +
      'you lack a tool for what the user needs.',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: 'The job you need a tool for, in plain language.',
        },
      },
      required: ['intent'],
      additionalProperties: false,
    },
    effectful: false,
    stepSummary(args): string {
      return `Searched for tools: ${readStringArg(args, 'intent') ?? 'a job'}`;
    },
    async run(rawArgs, ctx): Promise<ToolResult> {
      const intent = readStringArg(rawArgs, 'intent');
      if (intent === null) {
        return {
          name: 'search_tools',
          content: 'Error: search_tools needs an "intent" describing the job.',
          isError: true,
        };
      }
      const usage = createUsageAccumulator();
      try {
        const entries = await options.catalog.list();
        if (entries.length === 0) {
          return { name: 'search_tools', content: 'No tools are available to search.' };
        }
        const items: ToolSearchCatalogItem[] = entries.map((entry) => ({
          toolId: entry.toolId,
          toolName: entry.toolName,
          description: entry.description,
        }));
        const prompt = render(toolSearchTemplate, { intent, items });
        const llm = meteredLlmGateway(options.gateway, usage.sink);
        const stream = llm.stream({
          model: options.model,
          messages: prompt.messages,
          ...(prompt.tools ? { tools: prompt.tools } : {}),
          promptRef: prompt.ref,
        });
        let next = await stream.next();
        while (!next.done) {
          next = await stream.next();
        }
        const result = next.value;

        const known = new Map(entries.map((entry) => [entry.toolId, entry]));
        const call = result.toolCalls.find((toolCall) => toolCall.name === SELECT_TOOLS);
        const ids = parseToolIds(call?.args);
        // Keep only ids that are really in the catalog (drop hallucinations),
        // de-dupe, and cap to the shortlist size.
        const seen = new Set<string>();
        const matched = ids
          .filter((id) => known.has(id) && !seen.has(id) && seen.add(id))
          .slice(0, topK)
          .map((id) => known.get(id)!);

        if (matched.length === 0) {
          return {
            name: 'search_tools',
            content: 'No matching tools found. Try describing the job differently.',
          };
        }
        const lines = matched.map((entry) => `- ${entry.toolId}: ${entry.description}`).join('\n');
        return {
          name: 'search_tools',
          content: `Found ${matched.length} tool(s). Load one with load_tool(tool_id):\n${lines}`,
        };
      } catch (error) {
        logger.error('search_tools failed; returning no matches', {
          operation: 'mcp.searchTools',
          companionId: ctx.companionId,
          error,
        });
        return {
          name: 'search_tools',
          content: 'Tool search is unavailable right now.',
          isError: true,
        };
      } finally {
        // Bill the lookup to the companion's stamina (like the affect read), so an
        // off-loop model call is never free. Best-effort.
        const spent = usage.total().totalTokens;
        if (options.quota && ctx.companionId && spent > 0) {
          await options.quota.spend(ctx.companionId, spent).catch((error: unknown) =>
            logger.error('failed to bill search_tools usage', {
              operation: 'mcp.searchTools.bill',
              companionId: ctx.companionId,
              error,
            }),
          );
        }
      }
    },
  };
}

/** Read the `toolIds` string array from the structured call, tolerating junk. */
function parseToolIds(args: unknown): readonly string[] {
  if (typeof args !== 'object' || args === null) {
    return [];
  }
  const value = (args as Record<string, unknown>)['toolIds'];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((id): id is string => typeof id === 'string' && id.length > 0);
}
