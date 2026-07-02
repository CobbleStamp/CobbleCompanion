import { describe, expect, it } from 'vitest';
import { parseTriggerEvent } from './parse-trigger.js';

describe('parseTriggerEvent', () => {
  it('strips a leading user mention and returns the event', () => {
    expect(parseTriggerEvent('<@123456> LITE is 808.10 — −3.1% on the session')).toBe(
      'LITE is 808.10 — −3.1% on the session',
    );
  });

  it('strips the nickname mention form <@!id>', () => {
    expect(parseTriggerEvent('<@!987> price crossed')).toBe('price crossed');
  });

  it('strips several leading mentions', () => {
    expect(parseTriggerEvent('<@1> <@!2>   event text')).toBe('event text');
  });

  it('leaves a mention that appears later in the event text untouched', () => {
    expect(parseTriggerEvent('<@1> ping <@2> about this')).toBe('ping <@2> about this');
  });

  it('returns null for a mention-only message', () => {
    expect(parseTriggerEvent('<@123456>')).toBeNull();
    expect(parseTriggerEvent('<@123456>   ')).toBeNull();
  });

  it('returns null for an empty / whitespace message', () => {
    expect(parseTriggerEvent('')).toBeNull();
    expect(parseTriggerEvent('   ')).toBeNull();
  });

  it('returns the whole message when there is no leading mention', () => {
    // The router only forwards messages that mention the bot, but the parser must not
    // corrupt content that happens to arrive without a leading token.
    expect(parseTriggerEvent('bare event, no mention')).toBe('bare event, no mention');
  });
});
