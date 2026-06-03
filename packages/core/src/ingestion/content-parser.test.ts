/**
 * Content-parser registry tests: each content type routes to its parser, and
 * the type-resolution helpers (upload kind, MIME header, magic-byte sniff).
 */

import { describe, expect, it } from 'vitest';
import {
  contentTypeForUploadKind,
  contentTypeFromMime,
  looksBinary,
  parseContent,
  sniffContentType,
} from './content-parser.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Prefix a byte signature (e.g. a BOM) onto UTF-8 text bytes. */
const withPrefix = (prefix: readonly number[], text: string): Uint8Array =>
  new Uint8Array([...prefix, ...bytesOf(text)]);

describe('parseContent', () => {
  it('routes text content through the note parser', async () => {
    const doc = await parseContent({ contentType: 'text', bytes: bytesOf('one\n\ntwo') });
    expect(doc.paragraphs.map((p) => p.text)).toEqual(['one', 'two']);
  });

  it('routes markdown content through the markdown stripper', async () => {
    const doc = await parseContent({
      contentType: 'markdown',
      bytes: bytesOf('# Title\n\n**body**'),
    });
    expect(doc.paragraphs.map((p) => p.text)).toEqual(['Title', 'body']);
  });

  it('routes html content through Readability, using sourceUrl as the base', async () => {
    const html = `<html><body><article><h1>Ceviche</h1>
      <p>${'Ceviche is a coastal Peruvian dish cured in lime juice. '.repeat(8)}</p>
      </article></body></html>`;
    const doc = await parseContent({
      contentType: 'html',
      bytes: bytesOf(html),
      sourceUrl: 'https://example.com/ceviche',
    });
    expect(doc.rawText).toContain('coastal Peruvian dish');
  });

  it('dispatches to the PDF parser (which rejects non-PDF bytes)', async () => {
    await expect(
      parseContent({ contentType: 'pdf', bytes: bytesOf('not a pdf') }),
    ).rejects.toThrow();
  });

  it('decodes a UTF-16 (BOM-led) text body, stripping the BOM', async () => {
    // "one\n\ntwo" as UTF-16LE: 0xFF 0xFE BOM, then each char little-endian.
    const utf16le: number[] = [0xff, 0xfe];
    for (const ch of 'one\n\ntwo') {
      const code = ch.charCodeAt(0);
      utf16le.push(code & 0xff, (code >> 8) & 0xff);
    }
    const doc = await parseContent({ contentType: 'text', bytes: new Uint8Array(utf16le) });
    expect(doc.paragraphs.map((p) => p.text)).toEqual(['one', 'two']);
  });
});

describe('looksBinary', () => {
  it('treats prose as text and NUL-bearing bytes as binary', () => {
    expect(looksBinary(bytesOf('just some prose'))).toBe(false);
    expect(looksBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });

  it('treats a UTF-16/UTF-8 BOM as text even though UTF-16 bytes contain NULs', () => {
    expect(looksBinary(new Uint8Array([0xff, 0xfe, 0x68, 0x00]))).toBe(false); // UTF-16LE
    expect(looksBinary(new Uint8Array([0xfe, 0xff, 0x00, 0x68]))).toBe(false); // UTF-16BE
    expect(looksBinary(withPrefix([0xef, 0xbb, 0xbf], 'hi'))).toBe(false); // UTF-8 BOM
  });
});

describe('contentTypeForUploadKind', () => {
  it('maps each upload kind to its content type', () => {
    expect(contentTypeForUploadKind('pdf')).toBe('pdf');
    expect(contentTypeForUploadKind('txt')).toBe('text');
    expect(contentTypeForUploadKind('md')).toBe('markdown');
    expect(contentTypeForUploadKind('docx')).toBe('docx');
    expect(contentTypeForUploadKind('pptx')).toBe('pptx');
  });
});

describe('contentTypeFromMime', () => {
  it('maps known MIME types, ignoring charset parameters', () => {
    expect(contentTypeFromMime('application/pdf')).toBe('pdf');
    expect(contentTypeFromMime('text/html; charset=utf-8')).toBe('html');
    expect(contentTypeFromMime('application/xhtml+xml')).toBe('html');
    expect(contentTypeFromMime('text/markdown')).toBe('markdown');
    expect(contentTypeFromMime('text/plain')).toBe('text');
    expect(
      contentTypeFromMime(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe('docx');
    expect(
      contentTypeFromMime(
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    ).toBe('pptx');
  });

  it('returns null for unrecognized types', () => {
    expect(contentTypeFromMime('application/octet-stream')).toBeNull();
    expect(contentTypeFromMime('text/csv')).toBeNull();
    expect(contentTypeFromMime('')).toBeNull();
  });
});

describe('sniffContentType', () => {
  it('recognizes PDF and HTML by leading bytes', () => {
    expect(sniffContentType(bytesOf('%PDF-1.7\n...'))).toBe('pdf');
    expect(sniffContentType(bytesOf('<!DOCTYPE html><html>'))).toBe('html');
    expect(sniffContentType(bytesOf('  <html><body>hi'))).toBe('html');
  });

  it('returns null for content without a high-confidence signature', () => {
    expect(sniffContentType(bytesOf('just some prose'))).toBeNull();
    expect(sniffContentType(bytesOf('PK zip-family is ambiguous'))).toBeNull();
  });
});
