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
    stepSummary(args): string {
      const url = readHttpUrlArg(args, 'url');
      return url !== null ? `Read ${displayHost(url)}` : 'Read a web page';
    },
    async run(rawArgs, ctx): Promise<ToolResult> {
      const url = readHttpUrlArg(rawArgs, 'url');
      if (url === null) {
        return {
          name: 'web_fetch',
          content: 'Error: web_fetch needs a valid absolute "url".',
          isError: true,
        };
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
          isError: true,
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

/**
 * Pull outbound links out of HTML for the reading list. Two filters keep junk
 * out of the lead inventory:
 *   1. Only `<a href>` anchors — real navigation links. A blanket "any href"
 *      sweep also captured `<link rel="icon">`, `<link rel="apple-touch-icon">`,
 *      `<link rel="stylesheet">`, `rel="preload">` assets, and feed links —
 *      none of which is a readable document, so each could only fail ingestion's
 *      content-type detection (`link-resolver.ts`).
 *   2. A static non-document extension skip as a backstop, for an anchor that
 *      points straight at an asset (`<a href="…/photo.png">`).
 * Hrefs are resolved against the base and deduped. Best-effort — this is a
 * reading list, not a crawler.
 */
function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  // `<a …>` only: word boundary after `a` (so `<article>` never matches), then
  // any in-tag attributes up to an ` href="…"`. `[^>]` keeps the match inside
  // the one anchor tag.
  const anchorHrefPattern = /<a\b[^>]*?\shref\s*=\s*["']([^"'#]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorHrefPattern.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      if (
        (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
        resolved.href !== baseUrl &&
        !isNonDocumentAsset(resolved)
      ) {
        seen.add(resolved.href);
      }
    } catch {
      // A malformed href — skip it.
    }
  }
  return [...seen];
}

/**
 * Extensions whose content ingestion can never read as a document — images,
 * fonts, stylesheets/scripts, media, archives. A lead pointing at one can only
 * fail content-type detection (`link-resolver.ts`), so skip it before it is
 * ever harvested. Document formats the pipeline *can* parse (pdf/txt/md/docx/
 * pptx) are deliberately absent.
 */
const NON_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ico',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.webp',
  '.bmp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.css',
  '.js',
  '.mjs',
  '.map',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.gz',
  '.tar',
  '.rar',
  '.7z',
]);

/** A URL whose last path segment ends in a known non-document extension. */
function isNonDocumentAsset(url: URL): boolean {
  const lastSegment = url.pathname.split('/').pop() ?? '';
  const dot = lastSegment.lastIndexOf('.');
  // No extension, or a dotfile with no name (`.htaccess`) — not an asset link.
  if (dot <= 0) return false;
  return NON_DOCUMENT_EXTENSIONS.has(lastSegment.slice(dot).toLowerCase());
}

/** The host shown in a `tool_step` line ("Read example.com"); falls back to the raw URL. */
function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
