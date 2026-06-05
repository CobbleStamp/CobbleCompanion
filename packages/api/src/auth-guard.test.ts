import type { Logger } from '@cobble/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from './app.js';
import { makeRequireAuth } from './auth-guard.js';
import type { TokenVerifier } from './auth/jwt-verifier.js';

interface LogEntry {
  readonly message: string;
  readonly context: Record<string, unknown>;
}

function capturingLogger(errors: LogEntry[], infos: LogEntry[]): Logger {
  return {
    error: (message, context) => errors.push({ message, context }),
    warn: (message, context) => infos.push({ message, context: context ?? {} }),
    info: (message, context) => infos.push({ message, context: context ?? {} }),
  };
}

/** A verifier that always rejects with the supplied error — the failure path. */
function failingVerifier(error: unknown): TokenVerifier {
  return {
    verify: async () => {
      throw error;
    },
  };
}

function bearerRequest(): FastifyRequest {
  return { headers: { authorization: 'Bearer some-token' } } as FastifyRequest;
}

/** A reply stub that records the status code and lets the preHandler await it. */
function captureReply(): { reply: FastifyReply; codes: number[] } {
  const codes: number[] = [];
  const reply = {
    code(code: number) {
      codes.push(code);
      return reply;
    },
    async send() {
      // no-op: the guard awaits this to finish the 401 response.
    },
  } as unknown as FastifyReply;
  return { reply, codes };
}

function makeGuard(verifier: TokenVerifier, logger: Logger) {
  const deps = { tokenVerifier: verifier, logger } as unknown as AppDeps;
  return makeRequireAuth(deps);
}

describe('makeRequireAuth verification logging', () => {
  it('logs an expired token at info (no error, no stack)', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const expired = Object.assign(new Error('"exp" claim timestamp check failed'), {
      code: 'ERR_JWT_EXPIRED',
    });
    const guard = makeGuard(failingVerifier(expired), capturingLogger(errors, infos));

    const { reply, codes } = captureReply();
    await guard(bearerRequest(), reply);

    expect(codes).toEqual([401]);
    expect(errors).toHaveLength(0);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.message).toBe('token expired; re-authentication required');
    expect(infos[0]!.context).toEqual({ operation: 'auth.verify' });
  });

  it('logs a genuine verification failure at error with the full error', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const bad = Object.assign(new Error('signature verification failed'), {
      code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    });
    const guard = makeGuard(failingVerifier(bad), capturingLogger(errors, infos));

    const { reply } = captureReply();
    await guard(bearerRequest(), reply);

    expect(infos).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('token verification failed');
    expect(errors[0]!.context.error).toBe(bad);
  });
});
