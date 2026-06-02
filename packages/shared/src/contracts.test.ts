import { describe, expect, it } from 'vitest';
import { createCompanionSchema, requestMagicLinkSchema, sendMessageSchema } from './contracts.js';

describe('requestMagicLinkSchema', () => {
  it('normalizes email to trimmed lowercase', () => {
    const parsed = requestMagicLinkSchema.parse({ email: '  Ada@Example.COM ' });
    expect(parsed.email).toBe('ada@example.com');
  });

  it('rejects a malformed email', () => {
    const result = requestMagicLinkSchema.safeParse({ email: 'not-an-email' });
    expect(result.success).toBe(false);
  });
});

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
