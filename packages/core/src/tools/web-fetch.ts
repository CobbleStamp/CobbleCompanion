/**
 * The `web_fetch` tool (read-only): fetch a URL and return its readable text so
 * the companion can read a page mid-turn. Reuses the ingestion link resolver
 * (SSRF guard + byte cap + content-type detection) and the content-parser
 * registry, so a fetched PDF/HTML/Markdown is read with the same parser an
 * upload would use. Never throws — a fetch/parse failure is returned as text.
 */

import { parseContent } from '../ingestion/content-parser.js';
import type { LinkResolver } from '../ingestion/link-resolver.js';
import type { ToolResult } from '../harness/hooks.js';
import { consoleLogger, type Logger } from '../logging.js';
import { readHttpUrlArg, type Tool, toolErrorMessage } from './tool.js';

/** Default cap on returned text — a read tool feeds context, not a full archive. */
const DEFAULT_MAX_CHARS = 8000;

export interface WebFetchOptions {
  readonly resolver: LinkResolver;
  /** Truncate returned text to this many characters (default 8000). */
  readonly maxChars?: number;
  readonly logger?: Logger;
}

export function createWebFetchTool(options: WebFetchOptions): Tool {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const logger = options.logger ?? consoleLogger;
  return {
    name: 'web_fetch',
    description:
      'Fetch a web page or document by its absolute URL and return its readable text. ' +
      'Read-only — use it to read something before deciding what matters.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute http(s) URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    effectful: false,
    async run(rawArgs): Promise<ToolResult> {
      const url = readHttpUrlArg(rawArgs, 'url');
      if (url === null) {
        return { name: 'web_fetch', content: 'Error: web_fetch needs a valid absolute "url".' };
      }
      try {
        const content = await options.resolver.resolve(url);
        const doc = await parseContent(content);
        const truncated = doc.rawText.length > maxChars;
        const text = doc.rawText.slice(0, maxChars);
        return {
          name: 'web_fetch',
          content: truncated ? `${text}\n…[truncated]` : text,
        };
      } catch (error) {
        logger.error('web_fetch failed', {
          operation: 'tool.web_fetch',
          url,
          error,
        });
        return {
          name: 'web_fetch',
          content: `Error fetching ${url}: ${toolErrorMessage(error)}`,
        };
      }
    },
  };
}
