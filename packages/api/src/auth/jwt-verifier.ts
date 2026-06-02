import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/** Claims we trust off a verified Auth0 access token. */
export interface VerifiedClaims {
  readonly sub: string;
  readonly email?: string;
}

/**
 * Verifies a bearer token and returns its claims, or throws if invalid. This is
 * the testability seam (fakes-over-mocks): production uses `Auth0TokenVerifier`,
 * tests inject a fake, and local dev uses `DevBypassVerifier`.
 */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedClaims>;
}

/**
 * Validates Auth0 access tokens: RS256 signature against the tenant's JWKS, plus
 * issuer/audience/expiry checks. `jose`'s `createRemoteJWKSet` handles JWKS fetch,
 * caching, and key-rotation cooldown internally.
 *
 * The `email` claim is a custom claim set by the tenant's post-login Action
 * (`api.accessToken.setCustomClaim("email", event.user.email)`).
 */
export class Auth0TokenVerifier implements TokenVerifier {
  private readonly jwks: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(
    domain: string,
    private readonly audience: string,
  ) {
    this.issuer = `https://${domain}/`;
    this.jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('token missing sub claim');
    }
    return typeof payload.email === 'string'
      ? { sub: payload.sub, email: payload.email }
      : { sub: payload.sub };
  }
}

/** Local/dev verifier: accepts any token and resolves to a fixed identity. */
export class DevBypassVerifier implements TokenVerifier {
  constructor(private readonly email: string) {}

  async verify(): Promise<VerifiedClaims> {
    return { sub: 'dev|local', email: this.email };
  }
}
