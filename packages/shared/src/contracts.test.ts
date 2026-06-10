import { describe, expect, it } from 'vitest';
import {
  autonomousReadFallback,
  createCompanionSchema,
  companionUnavailableNotice,
  exhaustedGreetingFallback,
  feedSchema,
  proactivityDialSchema,
  proposalOriginSchema,
  sendMessageSchema,
  setProactivityDialSchema,
} from './contracts.js';

describe('createCompanionSchema', () => {
  it('accepts a seed companion', () => {
    const parsed = createCompanionSchema.parse({
      name: 'Pebble',
      form: 'fox',
      temperament: 'curious and gentle',
    });
    expect(parsed.name).toBe('Pebble');
  });

  it('rejects an empty name', () => {
    const result = createCompanionSchema.safeParse({
      name: '   ',
      form: 'fox',
      temperament: 'curious',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an over-long temperament', () => {
    const result = createCompanionSchema.safeParse({
      name: 'Pebble',
      form: 'fox',
      temperament: 'x'.repeat(281),
    });
    expect(result.success).toBe(false);
  });
});

describe('sendMessageSchema', () => {
  it('trims content', () => {
    const parsed = sendMessageSchema.parse({ content: '  hello  ' });
    expect(parsed.content).toBe('hello');
  });

  it('rejects empty content', () => {
    const result = sendMessageSchema.safeParse({ content: '   ' });
    expect(result.success).toBe(false);
  });
});

describe('Phase 4 proactivity schemas', () => {
  it('accepts the proposal origins and rejects unknown ones', () => {
    expect(proposalOriginSchema.parse('chat')).toBe('chat');
    expect(proposalOriginSchema.parse('autonomous')).toBe('autonomous');
    expect(proposalOriginSchema.safeParse('idle').success).toBe(false);
  });

  it('accepts the proactivity dial values', () => {
    expect(proactivityDialSchema.parse('off')).toBe('off');
    expect(setProactivityDialSchema.parse({ dial: 'active' }).dial).toBe('active');
    expect(setProactivityDialSchema.safeParse({ dial: 'loud' }).success).toBe(false);
  });

  it('validates a feed: a known food type, rejecting unknown ones', () => {
    expect(feedSchema.parse({ food: 'ration' })).toEqual({ food: 'ration' });
    expect(feedSchema.parse({ food: 'spark' })).toEqual({ food: 'spark' });
    expect(feedSchema.parse({ food: 'treat' })).toEqual({ food: 'treat' });
    expect(feedSchema.safeParse({ food: 'mana' }).success).toBe(false);
    expect(feedSchema.safeParse({}).success).toBe(false);
  });
});

describe('autonomousReadFallback', () => {
  it('uses the singular form naming the single title (count === 1)', () => {
    expect(autonomousReadFallback(['The Pragmatic Programmer'])).toBe(
      'While you were away I read The Pragmatic Programmer from my list. Ask me anything about it.',
    );
  });

  it('uses the plural form with the count for multiple titles', () => {
    expect(autonomousReadFallback(['One', 'Two', 'Three'])).toBe(
      'While you were away I read 3 things from my list. Ask me anything about them.',
    );
  });

  it('falls back to the plural form for an empty list (count === 0)', () => {
    expect(autonomousReadFallback([])).toBe(
      'While you were away I read 0 things from my list. Ask me anything about them.',
    );
  });
});

describe('exhaustedGreetingFallback', () => {
  it('names the companion in the token-free worn-out line', () => {
    const line = exhaustedGreetingFallback('Pebble');
    expect(line).toContain('Pebble');
    expect(line.toLowerCase()).toContain('feed me');
  });
});

describe('companionUnavailableNotice', () => {
  it('is a transient failure notice — never the exhausted "feed me" line', () => {
    const notice = companionUnavailableNotice();
    expect(notice.toLowerCase()).not.toContain('feed me');
    expect(notice.toLowerCase()).not.toContain('worn out');
    expect(notice.length).toBeGreaterThan(0);
  });
});
