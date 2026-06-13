import type { ServiceRegistry } from '@cobble/core';
import { describe, expect, it } from 'vitest';
import {
  DevBypassVerifier,
  GoogleIdTokenVerifier,
  ServiceTokenVerifier,
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

describe('DevBypassVerifier', () => {
  it('resolves to the configured google email for any request', async () => {
    const verifier: TokenVerifier = new DevBypassVerifier('dev@cobble.local');
    const claims = await verifier.verify(authReq({ authorization: 'Bearer anything' }));
    expect(claims.ok).toBe(true);
    expect(claims).toMatchObject({ identity: { authSource: 'google', email: 'dev@cobble.local' } });
  });
});

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
