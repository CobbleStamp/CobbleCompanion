/**
 * The reactable-message parse (companion-reactions.md §3): only the companion's
 * own `message`-kind turns pass. This function is the single runtime chokepoint —
 * `ReactionLearner.learn` accepts only its proof-carrying result, so these cases
 * are exactly what can and cannot reach the billed value-read.
 */

import type { MessageDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { asReactableMessage } from './reactable.js';

function message(overrides: Partial<MessageDto>): MessageDto {
  return {
    id: 'm1',
    companionId: 'c1',
    role: 'assistant',
    content: 'an answer',
    sourceId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('asReactableMessage', () => {
  it('passes an assistant message-kind turn', () => {
    const parsed = asReactableMessage(message({ kind: 'message' }));
    expect(parsed?.id).toBe('m1');
  });

  it('treats an absent kind as message (older rows/fixtures)', () => {
    expect(asReactableMessage(message({}))).not.toBeNull();
  });

  it('rejects tool_step and proposal chrome', () => {
    expect(asReactableMessage(message({ kind: 'tool_step' }))).toBeNull();
    expect(asReactableMessage(message({ kind: 'proposal' }))).toBeNull();
  });

  it("rejects the user's own and system turns — the value-read must never judge them", () => {
    expect(asReactableMessage(message({ role: 'user' }))).toBeNull();
    expect(asReactableMessage(message({ role: 'system' }))).toBeNull();
  });
});
