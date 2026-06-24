/**
 * Client-side JWT expiry inspection for the app **access** token. The token lives only
 * in memory (session-manager.ts) — never in web storage — so there is no persistence
 * here: a page reload re-establishes the session by replaying the HttpOnly refresh
 * cookie against `POST /auth/refresh`. This module's sole job is to let the session
 * manager decide *when* an access token is close enough to its `exp` to refresh ahead
 * of a request. The value is advisory only; the API verifies every token authoritatively.
 */

/**
 * Read a JWT's `exp` (seconds since epoch) without verifying its signature. Returns
 * null when the token is malformed or carries no numeric `exp`.
 */
function tokenExpirySeconds(token: string): number | null {
  const segments = token.split('.');
  const [headerSegment, payloadSegment] = segments;
  // Require all three JWT segments (header.payload.signature) before trusting the
  // payload, so a malformed token fails closed (treated as expired → a refresh).
  if (segments.length !== 3 || !headerSegment || !payloadSegment) return null;
  try {
    const json = atob(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * True when the token has no readable future expiry as of `nowMs`. Pass a `nowMs`
 * skewed into the future (e.g. `Date.now() + 30_000`) to treat a token that is about
 * to expire as already expired, so the caller refreshes ahead of the deadline.
 */
export function isTokenExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = tokenExpirySeconds(token);
  if (exp === null) return true;
  return exp * 1000 <= nowMs;
}
