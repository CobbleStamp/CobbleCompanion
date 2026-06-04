/** The tool-call audit log: append a call and list it back, newest first, scoped. */

import { createTestDatabase } from '@cobble/db/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleIdentityStore } from '../identity/store.js';
import { DrizzleToolCallLog } from './tool-call-log.js';

describe('DrizzleToolCallLog', () => {
  let close: () => Promise<void>;
  let log: DrizzleToolCallLog;
  let companionId: string;

  beforeEach(async () => {
    const created = await createTestDatabase();
    close = created.close;
    log = new DrizzleToolCallLog(created.db);
    const identity = new DrizzleIdentityStore(created.db);
    const user = await identity.ensureUserByEmail('owner@example.com');
    const companion = await identity.createCompanion(user.id, {
      name: 'A',
      form: 'fox',
      temperament: 'curious',
    });
    companionId = companion.id;
  });

  afterEach(async () => {
    await close();
  });

  it('records each executed call and lists them newest first', async () => {
    await log.record(companionId, 'web_fetch', { url: 'https://x.dev' }, 'PAGE');
    await log.record(companionId, 'memory_search', { query: 'peru' }, 'two hits');

    const rows = await log.list(companionId, 10);
    expect(rows.map((r) => r.name)).toEqual(['memory_search', 'web_fetch']);
    expect(rows[0]!.args).toEqual({ query: 'peru' });
    expect(rows[1]!.result).toBe('PAGE');
  });

  it('respects the limit', async () => {
    await log.record(companionId, 'a', {}, '1');
    await log.record(companionId, 'b', {}, '2');
    expect(await log.list(companionId, 1)).toHaveLength(1);
  });
});
