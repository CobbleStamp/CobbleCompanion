/**
 * Parser tests: paragraph atomicity for notes, Readability extraction for
 * links, and page-aware extraction from a real (minimal, hand-built) PDF.
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  parseDocx,
  parseLinkHtml,
  parseMarkdown,
  parseNote,
  parsePdf,
  parsePptx,
  stripMarkdown,
} from './parser.js';

/**
 * Build a minimal valid .docx (the three OOXML parts mammoth reads) so docx
 * tests need no binary fixture in the repo. Each string becomes one `<w:p>`.
 */
async function buildTestDocx(paragraphs: readonly string[]): Promise<Uint8Array> {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

/** One `ppt/slides/slideN.xml` entry from its 1-based number and text runs. */
function pptxSlideFile(zip: JSZip, slideNumber: number, runs: readonly string[]): void {
  const texts = runs.map((text) => `<a:t>${text}</a:t>`).join('');
  zip.file(
    `ppt/slides/slide${slideNumber}.xml`,
    `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${texts}</p:sld>`,
  );
}

/** Build a minimal .pptx with one slide XML per slide of `<a:t>` text runs. */
async function buildTestPptx(slides: readonly (readonly string[])[]): Promise<Uint8Array> {
  const zip = new JSZip();
  slides.forEach((runs, i) => pptxSlideFile(zip, i + 1, runs));
  return zip.generateAsync({ type: 'uint8array' });
}

/** Build a .pptx with explicit slide numbers, so tests can create gaps. */
async function buildTestPptxNumbered(
  slides: readonly { readonly number: number; readonly runs: readonly string[] }[],
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const slide of slides) {
    pptxSlideFile(zip, slide.number, slide.runs);
  }
  return zip.generateAsync({ type: 'uint8array' });
}

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

describe('stripMarkdown', () => {
  it('removes structural syntax but keeps prose and link/image labels', () => {
    const md = [
      '# Peru',
      '',
      'Ceviche is **cured** in *lime* and `aji`.',
      '',
      '- visit [Lima](https://example.com/lima)',
      '- eat ![ceviche](https://example.com/c.jpg)',
      '',
      '> a quote',
    ].join('\n');
    const stripped = stripMarkdown(md);
    expect(stripped).toContain('Peru');
    expect(stripped).toContain('Ceviche is cured in lime and aji.');
    expect(stripped).toContain('visit Lima');
    expect(stripped).toContain('eat ceviche');
    expect(stripped).toContain('a quote');
    expect(stripped).not.toMatch(/[#*`>]|\]\(|!\[/);
  });
});

describe('parseMarkdown', () => {
  it('strips markdown and splits into atomic paragraphs', () => {
    const document = parseMarkdown('# Title\n\nFirst **para**.\n\nSecond para.');
    expect(document.paragraphs.map((p) => p.text)).toEqual([
      'Title',
      'First para.',
      'Second para.',
    ]);
    expect(document.paragraphs.every((p) => p.page === undefined)).toBe(true);
  });
});

describe('parseDocx', () => {
  it('extracts body paragraphs from a real (minimal) .docx', async () => {
    const bytes = await buildTestDocx([
      'Pizarro founded Lima in 1535.',
      'Ceviche is cured in lime.',
    ]);
    const document = await parseDocx(bytes);
    expect(document.paragraphs.map((p) => p.text)).toEqual([
      'Pizarro founded Lima in 1535.',
      'Ceviche is cured in lime.',
    ]);
    // No page concept in the OOXML flow.
    expect(document.paragraphs.every((p) => p.page === undefined)).toBe(true);
  });

  it('throws when the document has no extractable text', async () => {
    const bytes = await buildTestDocx([]);
    await expect(parseDocx(bytes)).rejects.toThrow(/no extractable text/);
  });
});

describe('parsePptx', () => {
  it('extracts one paragraph per slide with 1-based slide provenance', async () => {
    const bytes = await buildTestPptx([
      ['Peru', 'A culinary history'],
      ['Ceviche', 'cured in lime'],
    ]);
    const document = await parsePptx(bytes);
    expect(document.paragraphs).toHaveLength(2);
    expect(document.paragraphs[0]!.text).toBe('Peru A culinary history');
    expect(document.paragraphs.map((p) => p.page)).toEqual([1, 2]);
  });

  it('orders slides numerically, not lexically (slide2 before slide10)', async () => {
    const slides = Array.from({ length: 10 }, (_, i) => [`Slide ${i + 1}`]);
    const document = await parsePptx(await buildTestPptx(slides));
    expect(document.paragraphs[1]!.text).toBe('Slide 2');
    expect(document.paragraphs[9]!.text).toBe('Slide 10');
  });

  it('cites the real slide number, not the position, when slides have gaps', async () => {
    // slide2 deleted in authoring: page provenance must follow the filename
    // (1, 3), not the compacted loop index (1, 2).
    const bytes = await buildTestPptxNumbered([
      { number: 1, runs: ['First'] },
      { number: 3, runs: ['Third'] },
    ]);
    const document = await parsePptx(bytes);
    expect(document.paragraphs.map((p) => p.text)).toEqual(['First', 'Third']);
    expect(document.paragraphs.map((p) => p.page)).toEqual([1, 3]);
  });

  it('skips empty slides without shifting later slide numbers', async () => {
    const bytes = await buildTestPptxNumbered([
      { number: 1, runs: ['Intro'] },
      { number: 2, runs: [] }, // no text → skipped
      { number: 3, runs: ['Outro'] },
    ]);
    const document = await parsePptx(bytes);
    expect(document.paragraphs.map((p) => p.text)).toEqual(['Intro', 'Outro']);
    expect(document.paragraphs.map((p) => p.page)).toEqual([1, 3]);
  });

  it('decodes XML entities in slide text', async () => {
    const document = await parsePptx(await buildTestPptx([['Salt &amp; pepper &lt;here&gt;']]));
    expect(document.paragraphs[0]!.text).toBe('Salt & pepper <here>');
  });

  it('throws when the file contains no slides', async () => {
    const empty = await new JSZip().generateAsync({ type: 'uint8array' });
    await expect(parsePptx(empty)).rejects.toThrow(/no slides/);
  });
});
