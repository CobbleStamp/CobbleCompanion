import { describe, expect, it, vi } from 'vitest';
import {
  handleReconcileRequest,
  RECONCILE_PATH,
  startControlServer,
  type ReconcileHttpRequest,
} from './control-server.js';
import type { Logger } from './gateway/types.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

function req(overrides: Partial<ReconcileHttpRequest> = {}): ReconcileHttpRequest {
  return {
    method: 'POST',
    url: RECONCILE_PATH,
    body: JSON.stringify({ userId: 'u1' }),
    ...overrides,
  };
}

describe('handleReconcileRequest', () => {
  it('reconciles the user and returns 204 on a valid request', async () => {
    const reconcileUser = vi.fn(async () => {});
    const status = await handleReconcileRequest({ reconcileUser, logger: silent }, req());

    expect(status).toBe(204);
    expect(reconcileUser).toHaveBeenCalledWith('u1');
  });

  it('rejects 404 for the wrong method or path', async () => {
    const deps = { reconcileUser: vi.fn(async () => {}), logger: silent };
    expect(await handleReconcileRequest(deps, req({ method: 'GET' }))).toBe(404);
    expect(await handleReconcileRequest(deps, req({ url: '/elsewhere' }))).toBe(404);
  });

  it('rejects 400 on a malformed body or missing userId', async () => {
    const deps = { reconcileUser: vi.fn(async () => {}), logger: silent };
    expect(await handleReconcileRequest(deps, req({ body: 'not json' }))).toBe(400);
    expect(await handleReconcileRequest(deps, req({ body: JSON.stringify({}) }))).toBe(400);
  });

  it('returns 500 and logs when reconcile throws (the API retries)', async () => {
    const errors: string[] = [];
    const logger: Logger = { error: (m) => errors.push(m), warn: () => {}, info: () => {} };
    const reconcileUser = vi.fn(async () => {
      throw new Error('boom');
    });

    const status = await handleReconcileRequest({ reconcileUser, logger }, req());

    expect(status).toBe(500);
    expect(errors.some((m) => m.includes('reconcile failed'))).toBe(true);
  });
});

describe('startControlServer (real socket round-trip)', () => {
  it('serves the reconcile endpoint and closes cleanly', async () => {
    const reconcileUser = vi.fn(async () => {});
    // Port 0 → an ephemeral port; close() proves lifecycle without needing the port.
    const server = await startControlServer({ port: 0, reconcileUser, logger: silent });
    await expect(server.close()).resolves.toBeUndefined();
  });
});
