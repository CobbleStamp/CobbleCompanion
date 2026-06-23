/**
 * The admin-only observability route (deliver-scalability.md §C "C2"). Asserts the
 * gate: an unauthenticated request is 401, an ordinary signed-in user is 403, and
 * only an `is_admin` user gets the queue snapshot. The snapshot's own correctness
 * is covered by the core reader test (queue-metrics.test.ts) — here we prove the
 * route is wired and access-controlled.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestApp, type TestApp } from '../test/helpers.js';

describe('GET /admin/queue', () => {
  let harness: TestApp;

  /** Provision a user for `email` (so the row exists), then set its admin flag. */
  async function provisionUser(email: string, isAdmin: boolean): Promise<void> {
    const user = await harness.deps.identity.ensureUserByEmail(email);
    await harness.deps.identity.setAdmin(user.id, isAdmin);
  }

  beforeEach(async () => {
    harness = await makeTestApp();
  });
  afterEach(async () => {
    await harness.close();
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/admin/queue' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an authenticated non-admin user with 403', async () => {
    await provisionUser('plain@example.com', false);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: harness.bearerFor('plain@example.com'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the queue snapshot for an admin user', async () => {
    await provisionUser('admin@example.com', true);
    const res = await harness.app.inject({
      method: 'GET',
      url: '/admin/queue',
      headers: harness.bearerFor('admin@example.com'),
    });
    expect(res.statusCode).toBe(200);
    // The full C2 shape, all zero on a fresh store.
    expect(res.json()).toEqual({
      pendingDue: 0,
      pendingTotal: 0,
      pendingByType: { consolidate: 0, motivation: 0, reaction_learn: 0, ingest: 0 },
      oldestPendingDueAgeMs: null,
      failedTotal: 0,
      failedByType: { consolidate: 0, motivation: 0, reaction_learn: 0, ingest: 0 },
      liveJobClaims: 0,
      reclaimedJobClaims: 0,
      liveEmbodiments: 0,
    });
  });
});
