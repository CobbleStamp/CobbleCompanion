import type { ServiceRegistry } from '@cobble/core';
import { describe, expect, it } from 'vitest';
import {
  CompositeVerifier,
  GoogleIdTokenVerifier,
  ServiceTokenVerifier,
  type AuthClaims,
  type AuthRequest,
  type TokenVerifier,
} from './jwt-verifier.js';

/** Build an AuthRequest from a flat header map (keys are matched case-insensitively). */
function authReq(headers: Record<string, string | undefined>): AuthRequest {
  return {
    authorization: headers['authorization'],
    header: (name: string) => headers[name.toLowerCase()],
  };
}

const SECRET = 'a'.repeat(40);
const CLIENT = 'sprout';
const UUID = '11111111-2222-4333-8444-555555555555';

/** A registry that accepts exactly one (client_id, secret) pair. */
function fakeRegistry(clientId: string, secret: string): ServiceRegistry {
  return {
    authenticate: async (c, s) => c === clientId && s === secret,
  };
}

describe('GoogleIdTokenVerifier', () => {
  it('returns a failure (does not throw) for a malformed token, without touching the network', async () => {
    const verifier = new GoogleIdTokenVerifier('test-google-client-id.apps.googleusercontent.com');
    const claims = await verifier.verify(authReq({ authorization: 'Bearer not-a-jwt' }));
    expect(claims.ok).toBe(false);
    if (!claims.ok) {
      expect(claims.failure.status).toBe(401);
      expect(claims.failure.kind).toBe('invalid');
    }
  });

  it('fails with "authentication required" when no Bearer header is present', async () => {
    const verifier = new GoogleIdTokenVerifier('test-google-client-id.apps.googleusercontent.com');
    const claims = await verifier.verify(authReq({}));
    expect(claims).toMatchObject({
      ok: false,
      failure: { status: 401, message: 'authentication required' },
    });
  });
});

describe('ServiceTokenVerifier', () => {
  const verifier = new ServiceTokenVerifier(fakeRegistry(CLIENT, SECRET));
  const creds = { authorization: `Bearer ${SECRET}`, 'x-service-client-id': CLIENT };

  it('resolves to a client-scoped service identity for valid creds + a valid UUID', async () => {
    const claims = await verifier.verify(authReq({ ...creds, 'x-user-id': UUID }));
    expect(claims.ok).toBe(true);
    expect(claims).toMatchObject({
      identity: { authSource: 'service', clientId: CLIENT, externalId: UUID },
    });
    if (claims.ok) {
      expect(claims.seedName).toBeUndefined();
    }
  });

  it('seeds the display name from the optional X-User-Name header', async () => {
    const claims = await verifier.verify(
      authReq({ ...creds, 'x-user-id': UUID, 'x-user-name': '  Ada  ' }),
    );
    expect(claims).toMatchObject({ ok: true, seedName: 'Ada' });
  });

  it('rejects a wrong secret with 401', async () => {
    const claims = await verifier.verify(
      authReq({
        authorization: 'Bearer wrong-secret',
        'x-service-client-id': CLIENT,
        'x-user-id': UUID,
      }),
    );
    expect(claims).toMatchObject({ ok: false, failure: { status: 401 } });
  });

  it('rejects an unknown client_id with 401', async () => {
    const claims = await verifier.verify(
      authReq({
        authorization: `Bearer ${SECRET}`,
        'x-service-client-id': 'stranger',
        'x-user-id': UUID,
      }),
    );
    expect(claims).toMatchObject({ ok: false, failure: { status: 401 } });
  });

  it('rejects a missing X-Service-Client-Id with 401', async () => {
    const claims = await verifier.verify(
      authReq({ authorization: `Bearer ${SECRET}`, 'x-user-id': UUID }),
    );
    expect(claims).toMatchObject({ ok: false, failure: { status: 401 } });
  });

  it('rejects a missing Authorization header with 401', async () => {
    const claims = await verifier.verify(
      authReq({ 'x-service-client-id': CLIENT, 'x-user-id': UUID }),
    );
    expect(claims).toMatchObject({ ok: false, failure: { status: 401 } });
  });

  it('rejects a missing X-User-Id with 400 (only after the credential validates)', async () => {
    const claims = await verifier.verify(authReq({ ...creds }));
    expect(claims).toMatchObject({
      ok: false,
      failure: { status: 400, message: 'X-User-Id missing or not a valid UUID' },
    });
  });

  it('rejects a non-UUID X-User-Id with 400', async () => {
    const claims = await verifier.verify(authReq({ ...creds, 'x-user-id': 'not-a-uuid' }));
    expect(claims).toMatchObject({ ok: false, failure: { status: 400 } });
  });
});

describe('CompositeVerifier', () => {
  /** A verifier that records it was called and returns a tagged identity. */
  function tagged(label: string): TokenVerifier & { called: boolean } {
    const stub = {
      called: false,
      async verify(): Promise<AuthClaims> {
        stub.called = true;
        return { ok: true, identity: { authSource: 'google', email: `${label}@x` } };
      },
    };
    return stub;
  }

  it('routes a request carrying X-Service-Client-Id to the service verifier', async () => {
    const google = tagged('google');
    const service = tagged('service');
    const composite = new CompositeVerifier(google, service);
    const claims = await composite.verify(
      authReq({ authorization: `Bearer ${SECRET}`, 'x-service-client-id': CLIENT }),
    );
    expect(service.called).toBe(true);
    expect(google.called).toBe(false);
    expect(claims).toMatchObject({ identity: { email: 'service@x' } });
  });

  it('does NOT fall through to the browser scheme when service auth fails', async () => {
    const google = tagged('google');
    const failingService: TokenVerifier = {
      async verify(): Promise<AuthClaims> {
        return { ok: false, failure: { status: 401, kind: 'invalid', message: 'bad creds' } };
      },
    };
    const composite = new CompositeVerifier(google, failingService);
    const claims = await composite.verify(authReq({ 'x-service-client-id': 'stranger' }));
    expect(google.called).toBe(false);
    expect(claims).toMatchObject({ ok: false, failure: { message: 'bad creds' } });
  });

  it('routes a plain bearer (no service header) to Google', async () => {
    const google = tagged('google');
    const service = tagged('service');
    const composite = new CompositeVerifier(google, service);
    await composite.verify(authReq({ authorization: 'Bearer some-google-jwt' }));
    expect(google.called).toBe(true);
    expect(service.called).toBe(false);
  });
});
