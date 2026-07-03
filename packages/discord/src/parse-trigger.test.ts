import { describe, expect, it } from 'vitest';
import { parseTriggerEvent } from './parse-trigger.js';

const MISSION_ID = '0f4c10ac-9a3e-4b21-8c53-2f6f14be7a90';

describe('parseTriggerEvent', () => {
  it('strips a leading user mention and returns the mission id + event', () => {
    expect(
      parseTriggerEvent(`<@123456> mission:${MISSION_ID} LITE is 808.10 — −3.1% on the session`),
    ).toEqual({ missionId: MISSION_ID, event: 'LITE is 808.10 — −3.1% on the session' });
  });

  it('strips the nickname mention form <@!id>', () => {
    expect(parseTriggerEvent(`<@!987> mission:${MISSION_ID} price crossed`)).toEqual({
      missionId: MISSION_ID,
      event: 'price crossed',
    });
  });

  it('strips several leading mentions', () => {
    expect(parseTriggerEvent(`<@1> <@!2>   mission:${MISSION_ID} event text`)).toEqual({
      missionId: MISSION_ID,
      event: 'event text',
    });
  });

  it('leaves a mention that appears later in the event text untouched', () => {
    expect(parseTriggerEvent(`<@1> mission:${MISSION_ID} ping <@2> about this`)).toEqual({
      missionId: MISSION_ID,
      event: 'ping <@2> about this',
    });
  });

  it('normalises an uppercase mission id to lowercase', () => {
    expect(parseTriggerEvent(`<@1> mission:${MISSION_ID.toUpperCase()} event`)).toEqual({
      missionId: MISSION_ID,
      event: 'event',
    });
  });

  it('returns null when the mission tag is missing (every wake must name its mission)', () => {
    expect(parseTriggerEvent('<@123456> LITE is 808.10')).toBeNull();
    expect(parseTriggerEvent('bare event, no mention, no tag')).toBeNull();
  });

  it('returns null when the mission id is not a UUID', () => {
    expect(parseTriggerEvent('<@1> mission:not-a-uuid event text')).toBeNull();
    expect(parseTriggerEvent('<@1> mission: event text')).toBeNull();
  });

  it('returns null when nothing follows the mission tag', () => {
    expect(parseTriggerEvent(`<@1> mission:${MISSION_ID}`)).toBeNull();
    expect(parseTriggerEvent(`<@1> mission:${MISSION_ID}   `)).toBeNull();
  });

  it('returns null for a mention-only or empty message', () => {
    expect(parseTriggerEvent('<@123456>')).toBeNull();
    expect(parseTriggerEvent('<@123456>   ')).toBeNull();
    expect(parseTriggerEvent('')).toBeNull();
    expect(parseTriggerEvent('   ')).toBeNull();
  });

  it('parses a tag arriving without a leading mention (defensive: parsing ≠ trust)', () => {
    // The router only forwards messages that pass the sender+channel gate; the parser
    // itself accepts any well-formed wake text.
    expect(parseTriggerEvent(`mission:${MISSION_ID} bare event`)).toEqual({
      missionId: MISSION_ID,
      event: 'bare event',
    });
  });
});
