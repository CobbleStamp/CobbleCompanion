import type { CompanionDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { assembleContext, buildPersona } from './context.js';

const companion: CompanionDto = {
  id: 'c1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and gentle',
  evolvedPersona: null,
  proactivityDial: 'gentle',
  createdAt: new Date(0).toISOString(),
};

describe('buildPersona', () => {
  it('embeds the companion identity', () => {
    const persona = buildPersona(companion);
    expect(persona).toContain('Pebble');
    expect(persona).toContain('fox');
    expect(persona).toContain('curious and gentle');
  });

  it('keeps the seed temperament and omits the evolved clause before any evolution', () => {
    const persona = buildPersona(companion);
    expect(persona).toContain('began as "curious and gentle"');
    expect(persona).not.toContain('Through your history together');
  });

  it('blends the evolved persona alongside the seed once it exists', () => {
    const evolved = buildPersona({
      ...companion,
      evolvedPersona: "You've grown playful and you know they cook to unwind.",
    });
    // The immutable seed is preserved …
    expect(evolved).toContain('began as "curious and gentle"');
    // … and the evolved growth is blended in.
    expect(evolved).toContain('Through your history together, you have grown');
    expect(evolved).toContain('they cook to unwind');
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
