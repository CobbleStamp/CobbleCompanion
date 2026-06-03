/**
 * Link-resolver tests: content-type detection precedence (header → magic bytes
 * → URL extension → text fallback) and the HTTP resolver's safety behaviors
 * (SSRF refusal, size ceiling, non-2xx) — all with a fake fetch, no network.
 */

import { describe, expect, it } from 'vitest';
import { createHttpLinkResolver, detectContentType } from './link-resolver.js';

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const respondWith = (body: BodyInit, contentType: string): typeof fetch =>
  (async () =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } })) as typeof fetch;

describe('detectContentType', () => {
  const url = 'https://example.com/x';

  it('trusts a recognized Content-Type header first', () => {
    // Header says PDF even though the body looks like HTML — header wins.
    expect(detectContentType('application/pdf', bytesOf('<html>'), url)).toBe('pdf');
  });

  it('sniffs magic bytes when the header is generic', () => {
    expect(detectContentType('application/octet-stream', bytesOf('%PDF-1.7'), url)).toBe('pdf');
    expect(detectContentType('', bytesOf('<!DOCTYPE html><html>'), url)).toBe('html');
  });

  it('falls back to the URL extension for the ambiguous zip family', () => {
    const zipBytes = bytesOf('PK ...');
    expect(detectContentType('application/octet-stream', zipBytes, 'https://x.com/a.docx')).toBe(
      'docx',
    );
    expect(detectContentType('application/octet-stream', zipBytes, 'https://x.com/a.pptx')).toBe(
      'pptx',
    );
    expect(detectContentType('', bytesOf('notes'), 'https://x.com/readme.md')).toBe('markdown');
  });

  it('falls back to plain text for an unlabeled textual body', () => {
    expect(detectContentType('', bytesOf('just some prose with no markup'), url)).toBe('text');
  });

  it('returns null for unidentifiable binary content', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]); // has a NUL byte
    expect(detectContentType('image/png', png, 'https://x.com/photo.png')).toBeNull();
  });
});

describe('createHttpLinkResolver', () => {
  it('resolves a PDF link to pdf content (the same parser an upload would use)', async () => {
    const resolver = createHttpLinkResolver({
      fetchFn: respondWith('%PDF-1.7 body bytes', 'application/pdf'),
    });
    const content = await resolver.resolve('https://example.com/report.pdf');
    expect(content.contentType).toBe('pdf');
    expect(content.sourceUrl).toBe('https://example.com/report.pdf');
    expect(content.bytes.byteLength).toBeGreaterThan(0);
  });

  it('resolves an HTML article to html content with the URL as base', async () => {
    const resolver = createHttpLinkResolver({
      fetchFn: respondWith('<html><body><p>hi</p></body></html>', 'text/html; charset=utf-8'),
    });
    const content = await resolver.resolve('https://example.com/post');
    expect(content.contentType).toBe('html');
  });

  it('refuses a private/metadata address without fetching (SSRF guard)', async () => {
    const resolver = createHttpLinkResolver({
      fetchFn: (() => {
        throw new Error('fetch must not be called for blocked URLs');
      }) as typeof fetch,
    });
    await expect(resolver.resolve('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
  });

  it('rejects a body that exceeds the byte ceiling', async () => {
    const resolver = createHttpLinkResolver({
      maxBytes: 16,
      fetchFn: respondWith('x'.repeat(64), 'text/html'),
    });
    await expect(resolver.resolve('https://example.com/huge')).rejects.toThrow(/too large/);
  });

  it('rejects a non-2xx response', async () => {
    const resolver = createHttpLinkResolver({
      fetchFn: (async () => new Response('nope', { status: 404 })) as typeof fetch,
    });
    await expect(resolver.resolve('https://example.com/missing')).rejects.toThrow(/responded 404/);
  });

  it('rejects content it cannot identify or read as text', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const resolver = createHttpLinkResolver({ fetchFn: respondWith(png, 'image/png') });
    await expect(resolver.resolve('https://example.com/photo.png')).rejects.toThrow(/can read/);
  });
});
