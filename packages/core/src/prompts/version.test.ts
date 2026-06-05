/** Content-hash stability + sensitivity for prompt versioning. */

import { describe, expect, it } from 'vitest';
import { contentHash } from './version.js';
import type { PromptBuild } from './types.js';

const base: PromptBuild = {
  messages: [
    { role: 'system', content: 'You segment a document.' },
    { role: 'user', content: 'paragraphs' },
  ],
};

describe('contentHash', () => {
  it('is deterministic for the same build', () => {
    expect(contentHash(base)).toBe(contentHash(base));
  });

  it('changes when the instruction wording changes', () => {
    const reworded: PromptBuild = {
      messages: [
        { role: 'system', content: 'You segment a document carefully.' },
        { role: 'user', content: 'paragraphs' },
      ],
    };
    expect(contentHash(reworded)).not.toBe(contentHash(base));
  });

  it('changes when an advertised tool changes', () => {
    const withTool: PromptBuild = {
      ...base,
      tools: [{ name: 'report', description: 'report', parameters: { type: 'object' } }],
    };
    expect(contentHash(withTool)).not.toBe(contentHash(base));
  });

  it('ignores message fields beyond role and content', () => {
    const withExtras: PromptBuild = {
      messages: [
        { role: 'system', content: 'You segment a document.' },
        { role: 'user', content: 'paragraphs', toolCallId: 'irrelevant' },
      ],
    };
    expect(contentHash(withExtras)).toBe(contentHash(base));
  });

  it('returns a fixed-length hex digest', () => {
    expect(contentHash(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});
