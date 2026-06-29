/**
 * File-upload format checks shared by the WS enqueue path and the filesystem
 * upload route (staging-object-storage.md §5). The server is authoritative: it
 * confirms the bytes match the kind the filename claimed, never trusting the
 * client-declared content type.
 */

import { looksBinary } from '@cobble/core';
import { UPLOAD_FORMATS, type UploadSourceKind } from '@cobble/shared';

/**
 * Bytes to peek for magic-byte validation. The signature checks need only a few,
 * but the txt/md binary heuristic inspects the first ~1 KB, so peek that much.
 */
export const MAGIC_PEEK_BYTES = 1024;

/** User-safe rejection when a filename's extension is not an ingestible format. */
export const UNSUPPORTED_FILE_TYPE =
  'unsupported file type — upload a PDF, .txt, .md, .docx, or .pptx';

/** User-safe rejection when an upload exceeds the configured ingestion byte cap. */
export const FILE_TOO_LARGE = 'the uploaded file is too large';

/**
 * Confirm the bytes match the kind the extension claimed, so a renamed file
 * (e.g. an executable called `.docx`) is rejected before a parser sees it.
 * Returns a user-safe message on mismatch, else null. Only the first few bytes
 * are needed, so a ranged `peek` of the staged object suffices.
 * - PDF: starts with `%PDF-`.
 * - docx/pptx: OOXML is a zip, so it starts with the `PK` local-file signature
 *   (the extension discriminates the zip-family formats; the parser confirms the
 *   inner structure).
 * - txt/md: no signature; reject only if it looks binary (a NUL byte without a
 *   recognized Unicode BOM).
 */
export function magicByteError(kind: UploadSourceKind, bytes: Uint8Array): string | null {
  const startsWith = (signature: string): boolean =>
    latin1(bytes.subarray(0, signature.length)) === signature;
  switch (kind) {
    case 'pdf':
      return startsWith('%PDF-') ? null : 'the uploaded file is not a valid PDF';
    case 'docx':
    case 'pptx':
      return startsWith('PK') ? null : `the uploaded file is not a valid ${kind} document`;
    case 'txt':
    case 'md':
      return looksBinary(bytes) ? 'the uploaded file does not look like text' : null;
    default: {
      // Exhaustiveness guard: a future UploadSourceKind added without a case above
      // is a compile error here, and at runtime the gate fails closed (rejects)
      // rather than letting unvalidated bytes through to a parser.
      const unsupported: never = kind;
      void unsupported;
      return 'unsupported file type';
    }
  }
}

/** Strip the matched extension to form a display title; fall back if empty. */
export function titleFromFilename(filename: string, kind: UploadSourceKind): string {
  const base = filename.replace(/\.[^./\\]+$/, '').trim();
  return base.length > 0 ? base : `Untitled ${kind.toUpperCase()}`;
}

/** The content type pinned on a staged upload for a given kind (first declared mime). */
export function contentTypeForKind(kind: UploadSourceKind): string {
  const format = UPLOAD_FORMATS.find((f) => f.kind === kind);
  return format?.mimeTypes[0] ?? 'application/octet-stream';
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
}
