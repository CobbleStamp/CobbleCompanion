import { describe, expect, it } from 'vitest';
import { createCompanionSchema, sendMessageSchema } from './contracts.js';

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
