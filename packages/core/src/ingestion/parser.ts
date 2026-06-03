/**
 * Source parsing — Layer 0 of ingestion (architecture.md ingestion flow).
 * Converts each source kind (PDF bytes, note text, link HTML) into the
 * canonical verbatim text plus its atomic paragraph structure. Paragraphs are
 * the indivisible unit of everything downstream: sections are built by grouping
 * whole paragraphs, never by splitting one.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { extractText, getDocumentProxy } from 'unpdf';

/** One atomic paragraph of a parsed source, with its position and PDF page. */
export interface Paragraph {
  /** 1-based paragraph ordinal within the source — the provenance unit. */
  readonly ord: number;
  readonly text: string;
  /** 1-based PDF page the paragraph starts on; absent for notes/links. */
  readonly page?: number;
}

/** A parsed source: the verbatim text and its paragraph structure. */
export interface ParsedDocument {
  readonly rawText: string;
  readonly paragraphs: readonly Paragraph[];
}

/** Split a text block into trimmed, non-empty paragraphs on blank-line breaks. */
function splitParagraphs(text: string): readonly string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length > 0);
}

/** Parse a plain-text note: paragraphs split on blank lines, no pages. */
export function parseNote(text: string): ParsedDocument {
  const paragraphs = splitParagraphs(text).map((paragraphText, i) => ({
    ord: i + 1,
    text: paragraphText,
  }));
  return {
    rawText: paragraphs.map((p) => p.text).join('\n\n'),
    paragraphs,
  };
}

/**
 * Parse fetched HTML into its readable article text (Readability strips nav,
 * ads, and boilerplate), then into paragraphs. The caller fetches the URL —
 * parsing stays free of network I/O.
 */
export function parseLinkHtml(html: string, url: string): ParsedDocument {
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const text = article?.textContent ?? '';
  if (text.trim().length === 0) {
    throw new Error('no readable article content found at the link');
  }
  return parseNote(text);
}

/**
 * Parse PDF bytes into per-page text and paragraphs. unpdf (serverless pdf.js)
 * extracts text page by page; paragraphs keep the 1-based page they start on
 * so citations can point at a real page range.
 */
export async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const pdf = await getDocumentProxy(bytes);
  const { text: pages } = await extractText(pdf, { mergePages: false });

  const paragraphs: Paragraph[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    for (const text of splitParagraphs(pages[pageIndex] ?? '')) {
      paragraphs.push({ ord: paragraphs.length + 1, text, page: pageIndex + 1 });
    }
  }
  if (paragraphs.length === 0) {
    throw new Error('no extractable text found in the PDF');
  }
  return {
    rawText: paragraphs.map((p) => p.text).join('\n\n'),
    paragraphs,
  };
}
