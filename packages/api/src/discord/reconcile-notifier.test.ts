import type { Logger } from '@cobble/core';
import { describe, expect, it, vi } from 'vitest';
import { createReconcileNotifier } from './reconcile-notifier.js';

const silent: Logger = { error: () => {}, warn: () => {}, info: () => {} };

describe('createReconcileNotifier', () => {
  it('is a no-op (never fetches) when no URL is configured', async () => {
    const fetchFn = vi.fn();
    const reconcile = createReconcileNotifier({ url: '', logger: silent, fetchFn });

    await reconcile('u1');

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs the userId on success (no retry)', async () => {
    const calls: Array<{
      url: string;
      init: { method: string; headers: Record<string, string>; body: string };
    }> = [];
    const fetchFn = vi.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 204 };
    });
    const reconcile = createReconcileNotifier({
      url: 'http://discord:8080/internal/reconcile',
      logger: silent,
      fetchFn,
    });

    await reconcile('u1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://discord:8080/internal/reconcile');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ userId: 'u1' });
  });

  it('retries on a non-ok response, then logs an error after exhausting attempts', async () => {
    const errors: string[] = [];
    const logger: Logger = { error: (m) => errors.push(m), warn: () => {}, info: () => {} };
    const fetchFn = vi.fn(async () => ({ ok: false, status: 503 }));
    const reconcile = createReconcileNotifier({
      url: 'http://discord:8080/internal/reconcile',
      logger,
      attempts: 3,
      fetchFn,
    });

    await reconcile('u1');

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(errors.some((m) => m.includes('reconcile trigger failed'))).toBe(true);
  });

  it('recovers on a later attempt without logging an error', async () => {
    const errors: string[] = [];
    const logger: Logger = { error: (m) => errors.push(m), warn: () => {}, info: () => {} };
    let calls = 0;
    const fetchFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection refused');
      return { ok: true, status: 204 };
    });
    const reconcile = createReconcileNotifier({
      url: 'http://discord:8080/internal/reconcile',
      logger,
      fetchFn,
    });

    await reconcile('u1');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(0);
  });
});
