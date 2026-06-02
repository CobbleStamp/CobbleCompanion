import { describe, expect, it } from 'vitest';
import {
  DevBypassVerifier,
  GoogleIdTokenVerifier,
  type TokenVerifier,
} from './jwt-verifier.js';

describe('DevBypassVerifier', () => {
  it('resolves to the configured email for any token', async () => {
    const verifier: TokenVerifier = new DevBypassVerifier('dev@cobble.local');
    const claims = await verifier.verify('anything');
    expect(claims.email).toBe('dev@cobble.local');
    expect(claims.sub).toBe('dev|local');
  });
});

describe('GoogleIdTokenVerifier', () => {
  it('rejects a malformed token without touching the network', async () => {
    const verifier = new GoogleIdTokenVerifier('test-google-client-id.apps.googleusercontent.com');
    await expect(verifier.verify('not-a-jwt')).rejects.toThrow();
  });
});
