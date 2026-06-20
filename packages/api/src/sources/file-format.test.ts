/**
 * File-format magic-byte gate (security): the server confirms the bytes match the
 * kind the filename claimed, and fails *closed* for any kind it doesn't recognize
 * rather than letting unvalidated bytes reach a parser.
 */

import { describe, expect, it } from 'vitest';
import type { UploadSourceKind } from '@cobble/shared';
import { magicByteError } from './file-format.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('magicByteError', () => {
  it('accepts bytes that match the claimed kind', () => {
    expect(magicByteError('pdf', utf8('%PDF-1.7\n...'))).toBeNull();
    expect(magicByteError('docx', utf8('PK'))).toBeNull();
    expect(magicByteError('txt', utf8('plain words'))).toBeNull();
  });

  it('rejects bytes that do not match the claimed kind', () => {
    expect(magicByteError('pdf', utf8('not a pdf'))).toMatch(/not a valid PDF/);
    expect(magicByteError('pptx', utf8('MZ'))).toMatch(/not a valid pptx/);
  });

  it('fails closed for an unrecognized kind (defensive exhaustiveness guard)', () => {
    // Cast past the type to simulate a future UploadSourceKind added without a case:
    // the gate must reject, not silently pass the bytes through.
    const unknownKind = 'rtf' as unknown as UploadSourceKind;
    expect(magicByteError(unknownKind, utf8('anything'))).toBe('unsupported file type');
  });
});
