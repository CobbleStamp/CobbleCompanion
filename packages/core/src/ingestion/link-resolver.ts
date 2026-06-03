/**
 * Link resolver: turns a user-supplied URL into {@link RawContent} — bytes plus
 * the detected content type — which the content-parser registry then parses.
 * The pipeline knows only "resolve this URL"; fetching, the SSRF guard, the
 * byte ceiling, and content-type detection are all the implementation's
 * concern. Because it returns a content type rather than assuming HTML, a link
 * to a PDF / Markdown / plain-text resource is read with the right parser —
 * the same parsers an upload of that format would use.
 */

import { uploadKindForFilename } from '@cobble/shared';
import {
  contentTypeForUploadKind,
  contentTypeFromMime,
  looksBinary,
  sniffContentType,
  type ContentType,
  type RawContent,
} from './content-parser.js';
import { readBytesWithLimit, safeLinkFetch } from './safe-fetch.js';
import { assertPublicHttpUrl } from './url-guard.js';

/** Default byte ceiling for fetched link bodies (mirrors the upload cap's default). */
const DEFAULT_MAX_LINK_BYTES = 25 * 1024 * 1024;

/**
 * Resolves a URL to acquired content. The single capability the pipeline
 * delegates; how the content is obtained is entirely the implementation's
 * concern.
 */
export interface LinkResolver {
  resolve(url: string): Promise<RawContent>;
}

export interface HttpLinkResolverOptions {
  /** Injectable fetch (tests pass a fake; default is the SSRF-guarded fetch). */
  readonly fetchFn?: typeof fetch;
  /** Byte ceiling for fetched link bodies (default 25 MiB). */
  readonly maxBytes?: number;
}

/**
 * Detect a fetched link's content type. Precedence: the HTTP `Content-Type`
 * header (authoritative when recognized), then a magic-byte sniff (for servers
 * that mislabel or omit the header), then the URL's file extension (resolves
 * the OOXML zip family the sniff can't disambiguate), and finally — for a body
 * that looks like text ({@link looksBinary} is false) — plain text. Returns null
 * when the content is binary and unidentifiable, so the resolver can reject it.
 */
export function detectContentType(
  headerValue: string,
  bytes: Uint8Array,
  url: string,
): ContentType | null {
  const fromHeader = contentTypeFromMime(headerValue);
  if (fromHeader) {
    return fromHeader;
  }
  const sniffed = sniffContentType(bytes);
  if (sniffed) {
    return sniffed;
  }
  const fromExtension = contentTypeFromUrlExtension(url);
  if (fromExtension) {
    return fromExtension;
  }
  return looksBinary(bytes) ? null : 'text';
}

/** Resolve a content type from a URL's path extension (e.g. `…/report.pdf`). */
function contentTypeFromUrlExtension(url: string): ContentType | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const kind = uploadKindForFilename(pathname);
  return kind ? contentTypeForUploadKind(kind) : null;
}

/**
 * The default {@link LinkResolver}: SSRF-guarded HTTP fetch → size cap →
 * content-type detection. Accountable for safely turning a public web URL into
 * acquired content; throws a user-safe Error on any unreachable, unsafe,
 * oversized, or unparseable response.
 */
export function createHttpLinkResolver(options: HttpLinkResolverOptions = {}): LinkResolver {
  const fetchFn = options.fetchFn ?? safeLinkFetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_LINK_BYTES;
  return {
    async resolve(rawUrl: string): Promise<RawContent> {
      // SSRF guard, two layers: string-level URL checks here, and the default
      // fetch resolves DNS through the guarded lookup so a public hostname
      // cannot rebind to a private address. Redirects are refused so a public
      // URL cannot bounce the fetch elsewhere.
      const url = assertPublicHttpUrl(rawUrl);
      const response = await fetchFn(url, { redirect: 'error' });
      if (!response.ok) {
        throw new Error(`link fetch responded ${response.status}`);
      }
      const header = response.headers.get('content-type') ?? '';
      const bytes = await readBytesWithLimit(response, maxBytes);
      const contentType = detectContentType(header, bytes, url.href);
      if (!contentType) {
        throw new Error('the link did not return content Cobble can read');
      }
      return { bytes, contentType, sourceUrl: url.href };
    },
  };
}
