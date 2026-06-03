/**
 * Content parsing: the single registry that maps a *content type* to its
 * parser. Both ingestion channels funnel here once they hold bytes + a known
 * type — an uploaded file (type from its extension) and a fetched link (type
 * from its response). Keeping the type→parser decision in one place means a new
 * format is one entry, and the link path gains it for free (a PDF link parses
 * with the same parser as a PDF upload).
 */

import type { UploadSourceKind } from '@cobble/shared';
import {
  parseDocx,
  parseLinkHtml,
  parseMarkdown,
  parseNote,
  parsePdf,
  parsePptx,
  type ParsedDocument,
} from './parser.js';

/** Normalized media categories the system can parse into a `ParsedDocument`. */
export type ContentType = 'pdf' | 'html' | 'markdown' | 'text' | 'docx' | 'pptx';

/** Acquired content ready to parse: bytes plus the type that selects the parser. */
export interface RawContent {
  readonly bytes: Uint8Array;
  readonly contentType: ContentType;
  /** Base URL for parsers that resolve relative references (HTML/Readability). */
  readonly sourceUrl?: string;
}

/** Recognized Unicode byte-order marks (UTF-8 first so it wins over a 2-byte prefix). */
const BYTE_ORDER_MARKS: ReadonlyArray<{
  readonly signature: readonly number[];
  readonly encoding: string;
}> = [
  { signature: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { signature: [0xff, 0xfe], encoding: 'utf-16le' },
  { signature: [0xfe, 0xff], encoding: 'utf-16be' },
];

/** The encoding of a leading BOM, or null when no recognized BOM is present. */
function bomEncoding(bytes: Uint8Array): string | null {
  const bom = BYTE_ORDER_MARKS.find((candidate) =>
    candidate.signature.every((byte, index) => bytes[index] === byte),
  );
  return bom?.encoding ?? null;
}

/**
 * Decode bytes to text for the text-based parsers, honoring a leading UTF-8 or
 * UTF-16 BOM (TextDecoder strips the BOM itself); defaults to UTF-8. Lossy on
 * invalid input.
 */
function decodeText(bytes: Uint8Array): string {
  return new TextDecoder(bomEncoding(bytes) ?? 'utf-8').decode(bytes);
}

/**
 * Heuristic: does this content look like binary rather than decodable text? A
 * recognized Unicode BOM marks it as text (UTF-16's own bytes contain NULs, so
 * the BOM must be checked first); otherwise a NUL byte in the first 1 KB betrays
 * binary content. Shared by the upload route and the link resolver so both
 * channels judge "is this text?" identically.
 */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bomEncoding(bytes)) {
    return false;
  }
  return bytes.subarray(0, 1024).includes(0);
}

/** The type → parser registry — the one place formats are wired to parsers. */
const PARSERS: Record<
  ContentType,
  (content: RawContent) => ParsedDocument | Promise<ParsedDocument>
> = {
  pdf: (content) => parsePdf(content.bytes),
  docx: (content) => parseDocx(content.bytes),
  pptx: (content) => parsePptx(content.bytes),
  html: (content) => parseLinkHtml(decodeText(content.bytes), content.sourceUrl ?? ''),
  markdown: (content) => parseMarkdown(decodeText(content.bytes)),
  text: (content) => parseNote(decodeText(content.bytes)),
};

/** Parse already-acquired content into the canonical document. */
export function parseContent(content: RawContent): Promise<ParsedDocument> {
  return Promise.resolve(PARSERS[content.contentType](content));
}

/** The content type produced by each file-upload kind. */
const UPLOAD_KIND_CONTENT_TYPE: Record<UploadSourceKind, ContentType> = {
  pdf: 'pdf',
  txt: 'text',
  md: 'markdown',
  docx: 'docx',
  pptx: 'pptx',
};

/** Map an upload kind (from the file's extension) to its content type. */
export function contentTypeForUploadKind(kind: UploadSourceKind): ContentType {
  return UPLOAD_KIND_CONTENT_TYPE[kind];
}

/** Map an HTTP `Content-Type` header (charset stripped) to a ContentType, or null. */
export function contentTypeFromMime(headerValue: string): ContentType | null {
  const mime = headerValue.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (mime) {
    case 'application/pdf':
      return 'pdf';
    case 'text/html':
    case 'application/xhtml+xml':
      return 'html';
    case 'text/markdown':
    case 'text/x-markdown':
      return 'markdown';
    case 'text/plain':
      return 'text';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    default:
      return null;
  }
}

/**
 * Best-effort content-type sniff from the leading bytes, for when the HTTP
 * header is missing or generic. High-confidence signatures only: PDF (`%PDF-`)
 * and HTML/XML markup. The OOXML zip family (`PK`) is ambiguous between
 * docx/pptx/xlsx, so it is left to the header or the URL extension.
 */
export function sniffContentType(bytes: Uint8Array): ContentType | null {
  const lead = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
  if (lead.startsWith('%PDF-')) {
    return 'pdf';
  }
  if (/^\s*<(?:!doctype html|html\b|\?xml)/i.test(lead)) {
    return 'html';
  }
  return null;
}
