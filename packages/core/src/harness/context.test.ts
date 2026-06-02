import type { CompanionDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { assembleContext, buildPersona } from './context.js';

const companion: CompanionDto = {
  id: 'c1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and gentle',
  createdAt: new Date(0).toISOString(),
};

describe('buildPersona', () => {
  it('embeds the companion identity', () => {
    const persona = buildPersona(companion);
    expect(persona).toContain('Pebble');
    expect(persona).toContain('fox');
    expect(persona).toContain('curious and gentle');
  });
});

describe('assembleContext', () => {
  it('puts the persona first, then history in order', () => {
    const messages = assembleContext(companion, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('Pebble');
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('returns just the persona when there is no history', () => {
    const messages = assembleContext(companion, []);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('system');
  });
});
