/**
 * Persists the Google ID token across page refreshes. Without this the token
 * lives only in React state, so a browser refresh drops the user back to the
 * sign-in gate even though the credential is still valid.
 *
 * We use `sessionStorage` (not `localStorage`): the bearer credential survives
 * refreshes and in-tab navigation but is cleared when the tab/browser closes —
 * a conservative posture for a credential. Google ID tokens are short-lived
 * (~1h), so this only restores a session within that window; an expired token
 * is dropped rather than sent.
 */
const STORAGE_KEY = 'cobble.idToken';

/**
 * Read a JWT's `exp` (seconds since epoch) without verifying its signature. The
 * value is only used client-side to avoid restoring or sending a token we can
 * already tell is stale — the API still verifies every token authoritatively.
 */
function tokenExpirySeconds(token: string): number | null {
  const [, payloadSegment, signatureSegment] = token.split('.');
  if (payloadSegment === undefined || signatureSegment === undefined) return null;
  try {
    const json = atob(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True when the token has no readable future expiry. */
export function isTokenExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = tokenExpirySeconds(token);
  if (exp === null) return true;
  return exp * 1000 <= nowMs;
}

/** The persisted ID token if one is stored and still valid; otherwise null. */
export function loadStoredToken(): string | null {
  const token = sessionStorage.getItem(STORAGE_KEY);
  if (token === null) return null;
  if (isTokenExpired(token)) {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
  return token;
}

export function storeToken(token: string): void {
  sessionStorage.setItem(STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
