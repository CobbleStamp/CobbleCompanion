import { describe, expect, it } from 'vitest';
import { Auth0TokenVerifier, DevBypassVerifier } from './jwt-verifier.js';

describe('DevBypassVerifier', () => {
  it('resolves to the configured email for any token', async () => {
    const verifier = new DevBypassVerifier('dev@cobble.local');
    const claims = await verifier.verify('anything');
    expect(claims.email).toBe('dev@cobble.local');
    expect(claims.sub).toBe('dev|local');
  });
});

describe('Auth0TokenVerifier', () => {
  it('rejects a malformed token without touching the network', async () => {
    const verifier = new Auth0TokenVerifier('tenant.us.auth0.com', 'https://api.cobble.test');
    await expect(verifier.verify('not-a-jwt')).rejects.toThrow();
  });
});
