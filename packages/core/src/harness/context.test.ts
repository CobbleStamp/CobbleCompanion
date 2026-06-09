import type { CompanionDto, UserFactDto } from '@cobble/shared';
import { describe, expect, it } from 'vitest';
import { affectAttunementLine, assembleContext, buildPersona, coPromptRefs } from './context.js';

const companion: CompanionDto = {
  id: 'c1',
  name: 'Pebble',
  form: 'fox',
  temperament: 'curious and gentle',
  evolvedPersona: null,
  proactivityDial: 'gentle',
  createdAt: new Date(0).toISOString(),
};

/** A minimal current user-fact for persona assembly. */
function userFact(predicate: string, object: string): UserFactDto {
  return {
    id: `${predicate}-1`,
    source: 'transcript',
    factType: 'attribute',
    subject: 'user',
    predicate,
    object,
    confidence: 0.9,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe('buildPersona', () => {
  it('embeds the companion identity', () => {
    const persona = buildPersona(companion, []);
    expect(persona).toContain('Pebble');
    expect(persona).toContain('fox');
    expect(persona).toContain('curious and gentle');
  });

  it('keeps the seed temperament and omits the evolved clause before any evolution', () => {
    const persona = buildPersona(companion, []);
    expect(persona).toContain('began as "curious and gentle"');
    expect(persona).not.toContain('Through your history together');
  });

  it('blends the evolved persona alongside the seed once it exists', () => {
    const evolved = buildPersona(
      {
        ...companion,
        evolvedPersona: "You've grown playful and you know they cook to unwind.",
      },
      [],
    );
    // The immutable seed is preserved …
    expect(evolved).toContain('began as "curious and gentle"');
    // … and the evolved growth is blended in.
    expect(evolved).toContain('Through your history together, you have grown');
    expect(evolved).toContain('they cook to unwind');
  });

  it('names the user from the name fact when known', () => {
    const persona = buildPersona(companion, [userFact('name', 'Ada')]);
    expect(persona).toContain('called Ada');
  });

  it('flags an unknown name so the companion asks rather than guesses', () => {
    const persona = buildPersona(companion, []);
    expect(persona).toContain("do not yet know the user's name");
    expect(persona).not.toContain('called ');
  });

  it('renders the other Tier-1 facts as a labelled profile line', () => {
    const persona = buildPersona(companion, [
      userFact('name', 'Ada'),
      userFact('livesIn', 'Berlin'),
      userFact('worksAs', 'an analyst'),
    ]);
    expect(persona).toContain('called Ada');
    expect(persona).toContain('lives in: Berlin');
    expect(persona).toContain('works as: an analyst');
    // The name is the addressing line, not duplicated into the profile list.
    expect(persona).not.toContain('name: Ada');
  });

  it('groups a multi-valued predicate into one labelled line', () => {
    const persona = buildPersona(companion, [
      userFact('languages', 'French'),
      userFact('languages', 'German'),
    ]);
    expect(persona).toContain('speaks: French, German');
  });

  it('drops non-Tier-1 facts so Phase-12 beliefs cannot leak into the persona', () => {
    const persona = buildPersona(companion, [
      userFact('livesIn', 'Berlin'),
      userFact('prefers', 'tea over coffee'),
      userFact('interestedIn', 'astronomy'),
    ]);
    expect(persona).toContain('lives in: Berlin');
    expect(persona).not.toContain('tea over coffee');
    expect(persona).not.toContain('astronomy');
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

  it('injects an attunement system line when a prior mood read exists', () => {
    const messages = assembleContext(companion, [{ role: 'user', content: 'hi' }], {
      valence: -0.6,
      note: 'frustrated, terse',
    });
    expect(messages[0]?.role).toBe('system'); // persona
    expect(messages[1]?.role).toBe('system'); // attunement
    expect(messages[1]?.content).toContain('frustrated, terse');
    expect(messages[1]?.content).not.toContain('-0.6'); // the valence number is never surfaced
    expect(messages[2]).toEqual({ role: 'user', content: 'hi' });
  });

  it('omits attunement for a neutral/empty mood read', () => {
    expect(assembleContext(companion, [], { valence: 0, note: '' })).toHaveLength(1);
    expect(assembleContext(companion, [], null)).toHaveLength(1);
  });

  it('threads the user profile into the persona system prompt', () => {
    const messages = assembleContext(companion, [], null, [userFact('name', 'Ada')]);
    expect(messages[0]?.content).toContain('called Ada');
  });
});

describe('coPromptRefs', () => {
  // The trace co-prompt list must track the SAME predicate assembleContext uses
  // to push the attunement line, or the stamp drifts from what was actually sent.
  it('lists the attunement ref exactly when a mood note is present', () => {
    const refs = coPromptRefs({ valence: -0.6, note: 'frustrated, terse' });
    expect(refs).toHaveLength(1);
    expect(refs[0]?.id).toBe('affect-attunement');
  });

  it('is empty for a neutral/empty/absent mood read', () => {
    expect(coPromptRefs({ valence: 0, note: '' })).toHaveLength(0);
    expect(coPromptRefs(null)).toHaveLength(0);
    expect(coPromptRefs(undefined)).toHaveLength(0);
  });
});

describe('affectAttunementLine', () => {
  it('describes the mood and instructs attunement, hiding the number', () => {
    const line = affectAttunementLine({ valence: 0.8, note: 'relieved' });
    expect(line).toContain('relieved');
    expect(line).toContain('Attune');
    expect(line).not.toContain('0.8');
  });

  it('is null without a meaningful note', () => {
    expect(affectAttunementLine({ valence: 0.9, note: '   ' })).toBeNull();
    expect(affectAttunementLine(null)).toBeNull();
    expect(affectAttunementLine(undefined)).toBeNull();
  });
});
