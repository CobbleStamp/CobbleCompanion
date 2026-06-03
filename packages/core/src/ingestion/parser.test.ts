/**
 * Parser tests: paragraph atomicity for notes, Readability extraction for
 * links, and page-aware extraction from a real (minimal, hand-built) PDF.
 */

import { describe, expect, it } from 'vitest';
import { parseLinkHtml, parseNote, parsePdf } from './parser.js';

/**
 * Build a minimal valid PDF with one Helvetica text line per page — enough for
 * pdf.js to extract real text without fixture binaries in the repo.
 */
function buildTestPdf(pageTexts: readonly string[]): Uint8Array {
  const objects: string[] = [];
  const pageRefs = pageTexts.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageRefs}] /Count ${pageTexts.length} >>\nendobj\n`,
  );
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  pageTexts.forEach((text, i) => {
    const contentRef = 5 + i * 2;
    objects.push(
      `${4 + i * 2} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R >>\nendobj\n`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `${contentRef} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(header.length + body.length);
    body += object;
  }
  const xrefStart = header.length + body.length;
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(header + body + xref + trailer);
}

describe('parseNote', () => {
  it('splits on blank lines into atomic, ordered paragraphs', () => {
    const document = parseNote('First paragraph.\n\nSecond one\nspans lines.\n\n\nThird.');
    expect(document.paragraphs.map((p) => p.text)).toEqual([
      'First paragraph.',
      'Second one spans lines.',
      'Third.',
    ]);
    expect(document.paragraphs.map((p) => p.ord)).toEqual([1, 2, 3]);
    expect(document.rawText).toBe('First paragraph.\n\nSecond one spans lines.\n\nThird.');
  });

  it('drops whitespace-only paragraphs', () => {
    expect(parseNote('one\n\n   \n\ntwo').paragraphs).toHaveLength(2);
  });
});

describe('parseLinkHtml', () => {
  it('extracts the readable article text, stripping boilerplate', () => {
    const html = `<!DOCTYPE html><html><head><title>Peru</title></head><body>
      <nav>Home | About | Contact</nav>
      <article>
        <h1>Ceviche</h1>
        <p>${'Ceviche is a coastal Peruvian dish with citrus-cured fish. '.repeat(8)}</p>
        <p>${'It became popular across Lima during the twentieth century. '.repeat(8)}</p>
      </article>
      <footer>© example.com</footer></body></html>`;

    const document = parseLinkHtml(html, 'https://example.com/ceviche');
    expect(document.rawText).toContain('citrus-cured fish');
    expect(document.rawText).not.toContain('Home | About');
    expect(document.paragraphs.length).toBeGreaterThan(0);
  });

  it('throws when no readable content exists', () => {
    expect(() => parseLinkHtml('<html><body></body></html>', 'https://example.com')).toThrow(
      /no readable article content/,
    );
  });
});

describe('parsePdf', () => {
  it('extracts text per page with 1-based page provenance', async () => {
    const bytes = buildTestPdf([
      'Pizarro founded Lima in 1535.',
      'Ceviche is cured with lime juice.',
    ]);

    const document = await parsePdf(bytes);
    expect(document.rawText).toContain('Pizarro founded Lima');
    expect(document.rawText).toContain('Ceviche is cured');
    const pages = document.paragraphs.map((p) => p.page);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(2);
  });

  it('throws on bytes with no extractable text', async () => {
    await expect(parsePdf(new TextEncoder().encode('not a pdf'))).rejects.toThrow();
  });
});
