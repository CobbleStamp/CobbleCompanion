import { describe, expect, it } from 'vitest';
import {
  createCompanionSchema,
  proactivityDialSchema,
  proposalOriginSchema,
  sendMessageSchema,
  setProactivityDialSchema,
  topUpSchema,
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

  it('validates a top-up: positive integer amount into a known pool', () => {
    expect(topUpSchema.parse({ pool: 'energy', amount: 500 })).toEqual({
      pool: 'energy',
      amount: 500,
    });
    expect(topUpSchema.safeParse({ pool: 'energy', amount: 0 }).success).toBe(false);
    expect(topUpSchema.safeParse({ pool: 'mana', amount: 10 }).success).toBe(false);
    expect(topUpSchema.safeParse({ pool: 'stamina', amount: 1.5 }).success).toBe(false);
  });
});
