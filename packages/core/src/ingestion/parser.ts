/**
 * Source parsing — Layer 0 of ingestion (architecture.md ingestion flow).
 * Converts each source kind (PDF bytes, note text, link HTML) into the
 * canonical verbatim text plus its atomic paragraph structure. Paragraphs are
 * the indivisible unit of everything downstream: sections are built by grouping
 * whole paragraphs, never by splitting one.
 */

import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

import { sanitizeText } from '../text/sanitize.js';

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
    .map((paragraph) => sanitizeText(paragraph).replace(/\s+/g, ' ').trim())
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
 * Strip Markdown syntax to readable prose, preserving paragraph breaks. The
 * goal is clean embedding/recall text, not faithful rendering — heading hashes,
 * emphasis/code markers, list bullets, and blockquote arrows become noise to an
 * encoder, while link/image *labels* carry meaning so we keep them and drop the
 * URL. Fenced code blocks keep their contents (often the point of the note),
 * just without the fences.
 */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, '') // fenced code delimiters (keep the code text)
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // ATX headings
    .replace(/^\s{0,3}>\s?/gm, '') // blockquote markers
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '') // list bullets / ordinals
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '') // horizontal rules
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label text
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/`([^`]+)`/g, '$1'); // inline code
}

/** Parse a Markdown source: stripped to prose, then split like a note. */
export function parseMarkdown(markdown: string): ParsedDocument {
  return parseNote(stripMarkdown(markdown));
}

/**
 * Parse a Word (.docx) source. mammoth extracts the document body as raw text
 * with blank lines between paragraphs, which the note splitter turns into
 * atomic paragraphs. No page concept in the OOXML flow, so provenance is
 * paragraph-ordinal only (like notes/links).
 */
export async function parseDocx(bytes: Uint8Array): Promise<ParsedDocument> {
  const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  if (value.trim().length === 0) {
    throw new Error('no extractable text found in the Word document');
  }
  return parseNote(value);
}

/** Decode the five XML predefined entities that appear in OOXML text runs. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last, so a literal "&amp;" never double-decodes
}

/** 1-based slide ordinal from a `ppt/slides/slideN.xml` path. */
function slideOrdinal(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

/**
 * Parse a PowerPoint (.pptx) source. A pptx is a zip of per-slide XML; each
 * slide's visible text lives in `<a:t>` runs. We concatenate the runs per slide
 * and treat each slide as one paragraph, recording the slide number as `page`
 * so citations can point at a real slide (mirroring PDF page provenance).
 * Speaker notes, tables, and SmartArt text are out of scope for now.
 */
export async function parsePptx(bytes: Uint8Array): Promise<ParsedDocument> {
  const zip = await JSZip.loadAsync(bytes);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideOrdinal(a) - slideOrdinal(b));
  if (slidePaths.length === 0) {
    throw new Error('no slides found in the PowerPoint file');
  }

  const paragraphs: Paragraph[] = [];
  for (const path of slidePaths) {
    const entry = zip.file(path);
    if (!entry) continue;
    const xml = await entry.async('string');
    const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeXmlEntities(match[1] ?? ''),
    );
    const text = sanitizeText(runs.join(' ')).replace(/\s+/g, ' ').trim();
    if (text.length > 0) {
      // `page` is the real slide number from the filename, not the loop
      // position, so a deck with gaps or empty slides still cites correctly.
      paragraphs.push({ ord: paragraphs.length + 1, text, page: slideOrdinal(path) });
    }
  }
  if (paragraphs.length === 0) {
    throw new Error('no extractable text found in the PowerPoint file');
  }
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
