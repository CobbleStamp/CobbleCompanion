/** Embedding-input construction tests (the contextual-header A/B knob). */

import { describe, expect, it } from 'vitest';
import { buildEmbeddingInput } from './embedder.js';

describe('buildEmbeddingInput', () => {
  const section = {
    originalText: 'He then moved the capital there in 1535.',
    contextHeader: '[Peru: A History — Pizarro founds Lima]',
  };

  it('prefixes the context header when enabled', () => {
    expect(buildEmbeddingInput(section, true)).toBe(
      '[Peru: A History — Pizarro founds Lima]\nHe then moved the capital there in 1535.',
    );
  });

  it('embeds pure verbatim text when disabled', () => {
    expect(buildEmbeddingInput(section, false)).toBe(section.originalText);
  });

  it('falls back to verbatim text when no header exists yet', () => {
    expect(buildEmbeddingInput({ ...section, contextHeader: null }, true)).toBe(
      section.originalText,
    );
  });
});
