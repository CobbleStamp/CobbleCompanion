/**
 * Segmenter tests: boundary-JSON validation (coverage, ordering, no
 * mid-paragraph splits) and the fixed-size fallback on unusable model output.
 */

import { describe, expect, it } from 'vitest';
import { FakeLlmGateway } from '../llm/fake.js';
import type { Logger } from '../logging.js';
import type { Paragraph } from './parser.js';
import { parseBoundaries, segmentParagraphs } from './segmenter.js';

const silentLogger: Logger = { error: () => undefined, info: () => undefined };

function paragraphs(count: number): readonly Paragraph[] {
  return Array.from({ length: count }, (_, i) => ({ ord: i + 1, text: `Paragraph ${i + 1}.` }));
}

describe('parseBoundaries', () => {
  it('accepts contiguous full-coverage sections', () => {
    const raw =
      '{"sections":[{"topic":"Intro","start":1,"end":2},{"topic":"Body","start":3,"end":4}]}';
    expect(parseBoundaries(raw, 1, 4)).toEqual([
      { topicTitle: 'Intro', paraStart: 1, paraEnd: 2 },
      { topicTitle: 'Body', paraStart: 3, paraEnd: 4 },
    ]);
  });

  it('tolerates prose around the JSON object', () => {
    const raw = 'Here you go:\n{"sections":[{"topic":"All","start":1,"end":3}]}\nDone!';
    expect(parseBoundaries(raw, 1, 3)).toHaveLength(1);
  });

  it.each([
    ['gap', '{"sections":[{"topic":"A","start":1,"end":1},{"topic":"B","start":3,"end":4}]}'],
    ['overlap', '{"sections":[{"topic":"A","start":1,"end":2},{"topic":"B","start":2,"end":4}]}'],
    ['incomplete coverage', '{"sections":[{"topic":"A","start":1,"end":3}]}'],
    ['out of bounds', '{"sections":[{"topic":"A","start":1,"end":9}]}'],
    ['empty topic', '{"sections":[{"topic":"","start":1,"end":4}]}'],
    ['not json', 'I could not segment this.'],
  ])('rejects %s', (_label, raw) => {
    expect(parseBoundaries(raw, 1, 4)).toBeNull();
  });
});

describe('segmentParagraphs', () => {
  it('returns the model boundaries when valid', async () => {
    const gateway = new FakeLlmGateway([
      '{"sections":[{"topic":"Conquest","start":1,"end":2},{"topic":"Cuisine","start":3,"end":5}]}',
    ]);

    const boundaries = await segmentParagraphs(gateway, 'cheap-model', paragraphs(5), silentLogger);
    expect(boundaries).toEqual([
      { topicTitle: 'Conquest', paraStart: 1, paraEnd: 2 },
      { topicTitle: 'Cuisine', paraStart: 3, paraEnd: 5 },
    ]);
    // The prompt numbers paragraphs so the model can only reference whole ones.
    expect(gateway.lastParams?.messages[1]?.content).toContain('[5] Paragraph 5.');
  });

  it('falls back to fixed-size grouping covering everything on invalid output', async () => {
    const gateway = new FakeLlmGateway(['not json at all']);

    const boundaries = await segmentParagraphs(
      gateway,
      'cheap-model',
      paragraphs(14),
      silentLogger,
    );
    expect(boundaries[0]?.paraStart).toBe(1);
    expect(boundaries[boundaries.length - 1]?.paraEnd).toBe(14);
    // Contiguous, no gaps or overlaps.
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i]?.paraStart).toBe(boundaries[i - 1]!.paraEnd + 1);
    }
  });
});
