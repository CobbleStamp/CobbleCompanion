/**
 * Direct unit tests for the pure transcript-folding helpers in chat-lines.ts.
 * These exercise the edge branches the Chat.tsx integration tests do not reach —
 * in particular the same-reference no-churn contract and immutability of every
 * fold/reduce (the inputs must never be mutated). React-free, so no jsdom render.
 */

import type {
  Citation,
  MessageDto,
  ReactionDto,
  StreamReactionAddedEvent,
  StreamReactionRemovedEvent,
} from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import {
  appendToLast,
  applyReaction,
  citeLast,
  dedupeCitations,
  dropAttachmentTail,
  dropEmptyAssistantTail,
  finalizeLast,
  formatCitation,
  insertStep,
  mergeMessage,
  mergeSnapshot,
  reactionsEqual,
  type ChatLine,
} from './chat-lines.js';

// --- Fixture builders (realistic shapes matching the contracts) ---

function line(overrides: Partial<ChatLine> = {}): ChatLine {
  return { role: 'assistant', content: 'hi', ...overrides };
}

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm1',
    companionId: 'c1',
    sourceId: null,
    role: 'assistant',
    content: 'hi',
    kind: 'message',
    createdAt: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

function reaction(overrides: Partial<ReactionDto> = {}): ReactionDto {
  return { messageId: 'm1', reactor: 'user', emoji: '❤️', ...overrides };
}

function citation(overrides: Partial<Citation> = {}): Citation {
  return {
    sourceId: 's1',
    sourceTitle: 'Peru: A Culinary History',
    chapterTitle: null,
    topicTitle: 'Ceviche',
    paraStart: 12,
    paraEnd: 18,
    pageStart: null,
    pageEnd: null,
    ...overrides,
  };
}

function added(overrides: Partial<StreamReactionAddedEvent> = {}): StreamReactionAddedEvent {
  return { type: 'reaction_added', messageId: 'm1', reactor: 'user', emoji: '❤️', ...overrides };
}

function removed(overrides: Partial<StreamReactionRemovedEvent> = {}): StreamReactionRemovedEvent {
  return { type: 'reaction_removed', messageId: 'm1', reactor: 'user', emoji: '❤️', ...overrides };
}

describe('applyReaction', () => {
  it('returns the SAME array reference when re-adding a reaction already present (no churn)', () => {
    const before: ChatLine[] = [line({ id: 'm1', reactions: [reaction()] })];
    const after = applyReaction(before, added());
    expect(after).toBe(before);
  });

  it('returns the SAME array reference when removing a reaction that is absent (no churn)', () => {
    const before: ChatLine[] = [line({ id: 'm1', reactions: [] })];
    const after = applyReaction(before, removed());
    expect(after).toBe(before);
  });

  it('returns the SAME array reference when the target message is not rendered', () => {
    const before: ChatLine[] = [line({ id: 'other', reactions: [] })];
    const after = applyReaction(before, added({ messageId: 'm1' }));
    expect(after).toBe(before);
  });

  it('returns a NEW array adding the reaction without mutating the original (add case)', () => {
    const originalReactions: readonly ReactionDto[] = [];
    const before: ChatLine[] = [line({ id: 'm1', reactions: originalReactions })];
    const after = applyReaction(before, added({ emoji: '🎉' }));

    expect(after).not.toBe(before);
    // Original array and its line are untouched.
    expect(before[0]!.reactions).toBe(originalReactions);
    expect(before[0]!.reactions).toEqual([]);
    // New line carries the added reaction.
    expect(after[0]!.reactions).toEqual([{ messageId: 'm1', reactor: 'user', emoji: '🎉' }]);
    expect(after).toHaveLength(1);
  });

  it('returns a NEW array removing the reaction without mutating the original (remove case)', () => {
    const originalReactions: readonly ReactionDto[] = [reaction({ emoji: '👍' })];
    const before: ChatLine[] = [line({ id: 'm1', reactions: originalReactions })];
    const after = applyReaction(before, removed({ emoji: '👍' }));

    expect(after).not.toBe(before);
    // Original is unchanged.
    expect(before[0]!.reactions).toBe(originalReactions);
    expect(before[0]!.reactions).toEqual([{ messageId: 'm1', reactor: 'user', emoji: '👍' }]);
    // New line dropped the reaction.
    expect(after[0]!.reactions).toEqual([]);
  });

  it('updates only the matching line and leaves siblings by reference', () => {
    const sibling = line({ id: 'm0', content: 'first' });
    const target = line({ id: 'm1', reactions: [] });
    const before: ChatLine[] = [sibling, target];
    const after = applyReaction(before, added({ emoji: '✨' }));

    expect(after[0]).toBe(sibling); // untouched sibling kept by reference
    expect(after[1]).not.toBe(target);
    expect(after[1]!.reactions).toEqual([{ messageId: 'm1', reactor: 'user', emoji: '✨' }]);
  });
});

describe('reactionsEqual', () => {
  it('is order-independent: same set in a different order is equal', () => {
    const a: ReactionDto[] = [reaction({ emoji: '❤️' }), reaction({ emoji: '🎉' })];
    const b: ReactionDto[] = [reaction({ emoji: '🎉' }), reaction({ emoji: '❤️' })];
    expect(reactionsEqual(a, b)).toBe(true);
  });

  it('differs when lengths differ', () => {
    expect(reactionsEqual([reaction()], [])).toBe(false);
  });

  it('differs when keyed by reactor+emoji a pair is missing', () => {
    const a: ReactionDto[] = [reaction({ reactor: 'user', emoji: '❤️' })];
    const b: ReactionDto[] = [reaction({ reactor: 'companion', emoji: '❤️' })];
    expect(reactionsEqual(a, b)).toBe(false);
  });

  it('treats two empty sets as equal', () => {
    expect(reactionsEqual([], [])).toBe(true);
  });

  it('backs the no-churn contract in mergeMessage (equal sets, different order → same ref)', () => {
    const before: ChatLine[] = [
      line({ id: 'm1', reactions: [reaction({ emoji: '❤️' }), reaction({ emoji: '🎉' })] }),
    ];
    // Server delivers the same set in the opposite order.
    const after = mergeMessage(
      before,
      message({ reactions: [reaction({ emoji: '🎉' }), reaction({ emoji: '❤️' })] }),
    );
    expect(after).toBe(before);
  });
});

describe('mergeMessage', () => {
  it('returns the SAME array reference for a no-op merge (present id, unchanged reactions)', () => {
    const before: ChatLine[] = [line({ id: 'm1', reactions: [reaction()] })];
    const after = mergeMessage(before, message({ reactions: [reaction()] }));
    expect(after).toBe(before);
  });

  it('returns a NEW immutable array when the snapshot adds a reaction to a present row', () => {
    const before: ChatLine[] = [line({ id: 'm1' })];
    const after = mergeMessage(before, message({ reactions: [reaction({ emoji: '❤️' })] }));

    expect(after).not.toBe(before);
    expect(before[0]!.reactions).toBeUndefined(); // original untouched
    expect(after[0]!.reactions).toEqual([{ messageId: 'm1', reactor: 'user', emoji: '❤️' }]);
  });

  it('drops the reactions overlay when the server set is empty on a present row', () => {
    const before: ChatLine[] = [line({ id: 'm1', reactions: [reaction()] })];
    const after = mergeMessage(before, message({ reactions: [] }));

    expect(after).not.toBe(before);
    expect('reactions' in after[0]!).toBe(false);
    expect(before[0]!.reactions).toEqual([reaction()]); // original untouched
  });

  it('reconciles an id-less optimistic user line in place (matched by content)', () => {
    const before: ChatLine[] = [line({ role: 'user', content: 'hello' })];
    const after = mergeMessage(before, message({ id: 'u1', role: 'user', content: 'hello' }));

    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('u1'); // adopted the authoritative row in place
    expect(before[0]!.id).toBeUndefined(); // original untouched
  });

  it('appends a genuinely new row at the right position', () => {
    const before: ChatLine[] = [line({ id: 'm1', content: 'first' })];
    const after = mergeMessage(before, message({ id: 'm2', content: 'second' }));

    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]); // existing line kept by reference
    expect(after[1]!.id).toBe('m2');
    expect(before).toHaveLength(1); // original untouched
  });
});

describe('mergeSnapshot', () => {
  it('returns the SAME array reference when the snapshot adds nothing (idle re-sync)', () => {
    const before: ChatLine[] = [line({ id: 'm1' }), line({ id: 'm2', content: 'two' })];
    const history: MessageDto[] = [message({ id: 'm1' }), message({ id: 'm2', content: 'two' })];
    const after = mergeSnapshot(before, history);
    expect(after).toBe(before);
  });

  it('returns a NEW array folding in only the new rows, original untouched', () => {
    const before: ChatLine[] = [line({ id: 'm1' })];
    const history: MessageDto[] = [message({ id: 'm1' }), message({ id: 'm2', content: 'new' })];
    const after = mergeSnapshot(before, history);

    expect(after).not.toBe(before);
    expect(after).toHaveLength(2);
    expect(after[1]!.id).toBe('m2');
    expect(before).toHaveLength(1); // original untouched
  });
});

describe('insertStep', () => {
  it('returns a single-line list on the empty-list branch', () => {
    const after = insertStep(
      [],
      message({ id: 's1', kind: 'tool_step', content: 'Read example.com' }),
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe('s1');
    expect(after[0]!.kind).toBe('tool_step');
  });

  it('slots the step ABOVE the trailing assistant bubble (append-to-last branch)', () => {
    const before: ChatLine[] = [
      line({ id: 'u1', role: 'user', content: 'q' }),
      line({ id: 'a1', role: 'assistant', content: 'reply' }),
    ];
    const after = insertStep(
      before,
      message({ id: 's1', kind: 'tool_step', content: 'looked up' }),
    );

    expect(after).toHaveLength(3);
    expect(after[0]).toBe(before[0]); // earlier lines kept by reference
    expect(after[1]!.id).toBe('s1'); // step inserted before the reply
    expect(after[2]).toBe(before[1]); // trailing reply preserved by reference
    expect(before).toHaveLength(2); // original untouched
  });
});

describe('dropEmptyAssistantTail', () => {
  it('no-ops on an empty list (same reference)', () => {
    const before: ChatLine[] = [];
    expect(dropEmptyAssistantTail(before)).toBe(before);
  });

  it('no-ops when the tail is a non-empty assistant line (same reference)', () => {
    const before: ChatLine[] = [line({ role: 'assistant', content: 'words' })];
    expect(dropEmptyAssistantTail(before)).toBe(before);
  });

  it('drops a trailing empty assistant bubble, leaving the rest intact', () => {
    const before: ChatLine[] = [
      line({ role: 'user', content: 'hi' }),
      line({ role: 'assistant', content: '' }),
    ];
    const after = dropEmptyAssistantTail(before);

    expect(after).toHaveLength(1);
    expect(after[0]).toBe(before[0]);
    expect(before).toHaveLength(2); // original untouched
  });
});

describe('dropAttachmentTail', () => {
  it('no-ops on an empty list (same reference)', () => {
    const before: ChatLine[] = [];
    expect(dropAttachmentTail(before)).toBe(before);
  });

  it('no-ops when the tail is not an attachment (same reference)', () => {
    const before: ChatLine[] = [line({ attachment: false })];
    expect(dropAttachmentTail(before)).toBe(before);
  });

  it('drops a trailing attachment chip, leaving the rest intact', () => {
    const before: ChatLine[] = [
      line({ role: 'user', content: 'note' }),
      line({ role: 'user', content: 'report.pdf', attachment: true }),
    ];
    const after = dropAttachmentTail(before);

    expect(after).toHaveLength(1);
    expect(after[0]).toBe(before[0]);
    expect(before).toHaveLength(2); // original untouched
  });
});

describe('dedupeCitations', () => {
  it('collapses duplicate citations keyed by sourceId + para span', () => {
    const c = citation({ sourceId: 's1', paraStart: 12, paraEnd: 18 });
    const after = dedupeCitations([c, { ...c }]);
    expect(after).toHaveLength(1);
  });

  it('preserves distinct citations and keeps input order stable', () => {
    const first = citation({ sourceId: 's1', paraStart: 1, paraEnd: 2 });
    const second = citation({ sourceId: 's1', paraStart: 3, paraEnd: 4 });
    const third = citation({ sourceId: 's2', paraStart: 1, paraEnd: 2 });
    // Order: first, second, duplicate-of-first, third → first, second, third.
    const after = dedupeCitations([first, second, { ...first }, third]);

    expect(after).toHaveLength(3);
    expect(after[0]).toBe(first);
    expect(after[1]).toBe(second);
    expect(after[2]).toBe(third);
  });

  it('treats the same span from different sources as distinct', () => {
    const a = citation({ sourceId: 's1', paraStart: 5, paraEnd: 9 });
    const b = citation({ sourceId: 's2', paraStart: 5, paraEnd: 9 });
    expect(dedupeCitations([a, b])).toHaveLength(2);
  });
});

describe('appendToLast', () => {
  it('no-ops on an empty list (same reference)', () => {
    const before: ChatLine[] = [];
    expect(appendToLast(before, 'x')).toBe(before);
  });

  it('appends the delta to the last line only, original untouched', () => {
    const before: ChatLine[] = [line({ content: 'a' }), line({ content: 'partial ' })];
    const after = appendToLast(before, 'draft');

    expect(after[1]!.content).toBe('partial draft');
    expect(after[0]).toBe(before[0]); // earlier line kept by reference
    expect(before[1]!.content).toBe('partial '); // original untouched
  });
});

describe('citeLast', () => {
  it('no-ops on an empty list (same reference)', () => {
    const before: ChatLine[] = [];
    expect(citeLast(before, [citation()])).toBe(before);
  });

  it('attaches citations to the last line only, original untouched', () => {
    const before: ChatLine[] = [line({ content: 'a' }), line({ content: 'reply' })];
    const citations = [citation()];
    const after = citeLast(before, citations);

    expect(after[1]!.citations).toBe(citations);
    expect(after[0]).toBe(before[0]);
    expect(before[1]!.citations).toBeUndefined(); // original untouched
  });
});

describe('finalizeLast', () => {
  it('no-ops on an empty list (same reference)', () => {
    const before: ChatLine[] = [];
    expect(finalizeLast(before, message())).toBe(before);
  });

  it('replaces the streamed last line with the persisted id/role/content, preserving citations', () => {
    const citations = [citation()];
    const before: ChatLine[] = [
      line({ id: 'u1', role: 'user', content: 'q' }),
      line({ role: 'assistant', content: 'streamed partial', citations }),
    ];
    const after = finalizeLast(
      before,
      message({ id: 'm-final', role: 'assistant', content: 'Final authoritative answer.' }),
    );

    expect(after[1]!.id).toBe('m-final');
    expect(after[1]!.content).toBe('Final authoritative answer.');
    expect(after[1]!.citations).toBe(citations); // citations attached during the stream preserved
    expect(after[0]).toBe(before[0]); // earlier line kept by reference
    expect(before[1]!.id).toBeUndefined(); // original untouched
    expect(before[1]!.content).toBe('streamed partial');
  });
});

describe('formatCitation', () => {
  it('formats title with chapter, para span, and page', () => {
    const c = citation({
      sourceTitle: 'Peru book',
      chapterTitle: '4',
      paraStart: 12,
      paraEnd: 18,
      pageStart: 41,
    });
    expect(formatCitation(c)).toBe('Peru book (ch. 4, para 12–18, p. 41)');
  });

  it('omits chapter and page when absent', () => {
    const c = citation({
      sourceTitle: 'A Doc',
      chapterTitle: null,
      paraStart: 3,
      paraEnd: 7,
      pageStart: null,
    });
    expect(formatCitation(c)).toBe('A Doc (para 3–7)');
  });
});
