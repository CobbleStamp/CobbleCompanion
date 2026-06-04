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
import type { LeadStore } from './lead-store.js';
import { readHttpUrlArg, type Tool, toolErrorMessage } from './tool.js';

/** Default cap on returned text — a read tool feeds context, not a full archive. */
const DEFAULT_MAX_CHARS = 8000;

/** Cap on outbound links captured per fetch (the reading list isn't a crawler). */
const MAX_HARVESTED_LINKS = 20;

export interface WebFetchOptions {
  readonly resolver: LinkResolver;
  /** Truncate returned text to this many characters (default 8000). */
  readonly maxChars?: number;
  /**
   * When set, http(s) links found in a fetched HTML page are captured into the
   * lead inventory (the companion's reading list) — the substrate the Phase 4
   * motivation engine works through. Omitted = no harvesting (e.g. tests).
   */
  readonly leads?: LeadStore;
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
    async run(rawArgs, ctx): Promise<ToolResult> {
      const url = readHttpUrlArg(rawArgs, 'url');
      if (url === null) {
        return { name: 'web_fetch', content: 'Error: web_fetch needs a valid absolute "url".' };
      }
      try {
        const content = await options.resolver.resolve(url);
        // Capture outbound links into the reading list (best-effort — a harvest
        // hiccup must never fail the read). Only HTML pages carry links.
        if (options.leads && content.contentType === 'html') {
          await harvestLinks(
            content.bytes,
            content.sourceUrl ?? url,
            ctx.companionId,
            options,
            logger,
          );
        }
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

/** Record up to {@link MAX_HARVESTED_LINKS} outbound http(s) links as new leads. */
async function harvestLinks(
  bytes: Uint8Array,
  baseUrl: string,
  companionId: string,
  options: WebFetchOptions,
  logger: Logger,
): Promise<void> {
  if (!options.leads) return;
  try {
    const html = new TextDecoder('utf-8').decode(bytes);
    const found = extractLinks(html, baseUrl).slice(0, MAX_HARVESTED_LINKS);
    for (const link of found) {
      await options.leads.record(companionId, link, `found while reading ${baseUrl}`);
    }
  } catch (error) {
    logger.error('web_fetch link harvest failed', {
      operation: 'tool.web_fetch.harvest',
      companionId,
      baseUrl,
      error,
    });
  }
}

/** Pull absolute http(s) hrefs out of HTML, resolved against the base, deduped. */
function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const hrefPattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      if (
        (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
        resolved.href !== baseUrl
      ) {
        seen.add(resolved.href);
      }
    } catch {
      // A malformed href — skip it.
    }
  }
  return [...seen];
}
