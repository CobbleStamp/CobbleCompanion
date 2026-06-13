import type { Logger, UserClaim, UserRecord } from '@cobble/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppDeps } from './app.js';
import { makeRequireAuth } from './auth-guard.js';
import type { AuthClaims, AuthFailure, TokenVerifier } from './auth/jwt-verifier.js';

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

/** A verifier that always returns the supplied failure — the rejection path. */
function rejectingVerifier(failure: AuthFailure): TokenVerifier {
  return {
    verify: async () => ({ ok: false, failure }),
  };
}

/** A verifier that always resolves to the supplied claims — the success path. */
function resolvingVerifier(claims: AuthClaims): TokenVerifier {
  return { verify: async () => claims };
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
  it('logs an expired token at info (no error, no stack) and replies 401', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const guard = makeGuard(
      rejectingVerifier({ status: 401, kind: 'expired', message: 'invalid token' }),
      capturingLogger(errors, infos),
    );

    const { reply, codes } = captureReply();
    await guard(bearerRequest(), reply);

    expect(codes).toEqual([401]);
    expect(errors).toHaveLength(0);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.message).toBe('token expired; re-authentication required');
    expect(infos[0]!.context).toEqual({ operation: 'auth.verify' });
  });

  it('logs a genuine verification failure at error with the underlying cause', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const bad = Object.assign(new Error('signature verification failed'), {
      code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
    });
    const guard = makeGuard(
      rejectingVerifier({ status: 401, kind: 'invalid', message: 'invalid token', cause: bad }),
      capturingLogger(errors, infos),
    );

    const { reply } = captureReply();
    await guard(bearerRequest(), reply);

    expect(infos).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('authentication rejected');
    expect(errors[0]!.context.kind).toBe('invalid');
    expect(errors[0]!.context.error).toBe(bad);
  });

  it('replies 400 when the verifier rejects a bad header claim (e.g. X-User-Id)', async () => {
    const errors: LogEntry[] = [];
    const infos: LogEntry[] = [];
    const guard = makeGuard(
      rejectingVerifier({
        status: 400,
        kind: 'invalid',
        message: 'X-User-Id missing or not a valid UUID',
      }),
      capturingLogger(errors, infos),
    );

    const { reply, codes } = captureReply();
    await guard(bearerRequest(), reply);

    expect(codes).toEqual([400]);
    expect(errors).toHaveLength(1);
  });
});

describe('makeRequireAuth success path', () => {
  const userRecord: UserRecord = {
    id: 'user-1',
    authSource: 'service',
    serviceClientId: 'sprout',
    externalId: '11111111-2222-4333-8444-555555555555',
    email: null,
    createdAt: '2026-06-13T00:00:00.000Z',
  };

  /** Deps that record what the guard provisions and seeds on the success path. */
  function successDeps(claims: AuthClaims): {
    deps: AppDeps;
    resolvedClaims: UserClaim[];
    seeded: Array<{ userId: string; name: string }>;
  } {
    const resolvedClaims: UserClaim[] = [];
    const seeded: Array<{ userId: string; name: string }> = [];
    const deps = {
      tokenVerifier: resolvingVerifier(claims),
      identity: {
        ensureUserByClaim: async (claim: UserClaim) => {
          resolvedClaims.push(claim);
          return userRecord;
        },
      },
      userModel: {
        seedName: async (userId: string, name: string) => {
          seeded.push({ userId, name });
        },
      },
      logger: capturingLogger([], []),
    } as unknown as AppDeps;
    return { deps, resolvedClaims, seeded };
  }

  it('provisions by the verifier claim and seeds the display name (e.g. X-User-Name)', async () => {
    const identity: UserClaim = {
      authSource: 'service',
      clientId: 'sprout',
      externalId: userRecord.externalId!,
    };
    const { deps, resolvedClaims, seeded } = successDeps({ ok: true, identity, seedName: 'Ada' });

    const request = { headers: { authorization: 'Bearer some-token' } } as FastifyRequest;
    const { reply, codes } = captureReply();
    await makeRequireAuth(deps)(request, reply);

    // No 4xx reply, the user is scoped, the claim flowed through, and the seed landed.
    expect(codes).toEqual([]);
    expect(request.userId).toBe('user-1');
    expect(resolvedClaims).toEqual([identity]);
    expect(seeded).toEqual([{ userId: 'user-1', name: 'Ada' }]);
  });

  it('does not seed a name when the claim carries no seedName', async () => {
    const identity: UserClaim = {
      authSource: 'service',
      clientId: 'sprout',
      externalId: userRecord.externalId!,
    };
    const { deps, seeded } = successDeps({ ok: true, identity });

    const request = { headers: { authorization: 'Bearer some-token' } } as FastifyRequest;
    const { reply } = captureReply();
    await makeRequireAuth(deps)(request, reply);

    expect(request.userId).toBe('user-1');
    expect(seeded).toHaveLength(0);
  });
});
