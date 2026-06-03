/**
 * Source parser: the abstraction the ingestion pipeline depends on to turn an
 * `IngestionPayload` (however the source entered — upload, typed note, or link)
 * into the canonical `ParsedDocument`. It is a thin router: typed notes parse
 * directly, uploads map their kind to a content type, and links are resolved to
 * content first; all three then share the one content-parser registry. The
 * pipeline knows only "parse this payload" — which format, and how a link is
 * fetched, are entirely this module's concern.
 */

import { contentTypeForUploadKind, parseContent } from './content-parser.js';
import { createHttpLinkResolver, type LinkResolver } from './link-resolver.js';
import { parseNote, type ParsedDocument } from './parser.js';
import type { IngestionPayload } from './pipeline.js';

/** Turns any ingestion payload into the canonical parsed document. */
export interface SourceParser {
  parse(payload: IngestionPayload): Promise<ParsedDocument>;
}

export interface SourceParserOptions {
  /** How links are turned into content; defaults to the SSRF-guarded HTTP resolver. */
  readonly linkResolver?: LinkResolver;
}

/** Build the default source parser; inject a fake `linkResolver` in tests. */
export function createSourceParser(options: SourceParserOptions = {}): SourceParser {
  const linkResolver = options.linkResolver ?? createHttpLinkResolver();
  return {
    async parse(payload: IngestionPayload): Promise<ParsedDocument> {
      switch (payload.kind) {
        case 'note':
          return parseNote(payload.text);
        case 'link':
          return parseContent(await linkResolver.resolve(payload.url));
        default:
          // Every remaining kind is a file upload carrying bytes; its content
          // type follows from the kind the route detected from the extension.
          return parseContent({
            bytes: payload.bytes,
            contentType: contentTypeForUploadKind(payload.kind),
          });
      }
    },
  };
}
