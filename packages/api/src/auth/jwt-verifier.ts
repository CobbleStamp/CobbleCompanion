import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Claims we trust off a verified Google ID token. */
export interface VerifiedClaims {
  readonly sub: string;
  readonly email?: string;
  /**
   * The profile display name (Google's `name` claim). UNVERIFIED — Google does not
   * vouch for it the way it does `email_verified` — so it is used only as a *seed*
   * for what the companion calls the user, never for identity or authorization. The
   * companion confirms or replaces it on first meeting.
   */
  readonly name?: string;
}

/**
 * Verifies a bearer token and returns its claims, or throws if invalid. This is
 * the testability seam (fakes-over-mocks): production uses
 * `GoogleIdTokenVerifier`, tests inject a fake, and local dev uses
 * `DevBypassVerifier`.
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedClaims>;
}

/**
 * Validates Google ID tokens: RS256 signature against Google's JWKS, plus
 * issuer/audience/expiry checks. `jose`'s `createRemoteJWKSet` handles JWKS
 * fetch, caching, and key-rotation cooldown internally.
 *
 * `audience` is the OAuth Web client ID (the SPA and API share it). Google puts
 * `email` / `email_verified` in the ID token by default — no custom claim or
 * Action needed. We require `email_verified === true` before trusting the email.
 */
export class GoogleIdTokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
  );

  constructor(private readonly clientId: string) {}

  async verify(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: this.clientId,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('token missing sub claim');
    }
    if (payload.email_verified !== true) {
      throw new Error('email not verified');
    }
    const name = typeof payload.name === 'string' ? payload.name : undefined;
    return {
      sub: payload.sub,
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      ...(name ? { name } : {}),
    };
  }
}

/** Local/dev verifier: accepts any token and resolves to a fixed identity. */
export class DevBypassVerifier implements TokenVerifier {
  constructor(private readonly email: string) {}

  async verify(): Promise<VerifiedClaims> {
    return { sub: 'dev|local', email: this.email };
  }
}
