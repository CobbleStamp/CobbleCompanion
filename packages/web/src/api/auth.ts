/**
 * The HTTP calls that establish and maintain the app-managed session
 * (implementation.md §5). `postSession` exchanges a Google ID token for the API's own
 * access token (and an HttpOnly refresh cookie the browser then carries); `postRefresh`
 * mints a fresh access token from that cookie; `postLogout` clears it. All three send
 * `credentials: 'include'` so the refresh cookie travels even cross-origin in dev.
 *
 * The session-manager (auth/session-manager.ts) is the only caller — these are kept
 * separate from the WS transport (client.ts/ws.ts) because they are the bootstrap that
 * mints the very bearer the transport rides on.
 */

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/**
 * The outcome of a session exchange. `unauthorized` (the API returned 401) means the
 * credential is genuinely rejected — the caller must re-authenticate. `error` is a
 * transient failure (network/5xx) the caller may retry without forcing sign-in.
 */
export type SessionResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly reason: 'unauthorized' | 'error' };

async function exchange(path: string, init: RequestInit): Promise<SessionResult> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      ...init,
    });
    if (res.status === 401) {
      return { ok: false, reason: 'unauthorized' };
    }
    if (!res.ok) {
      return { ok: false, reason: 'error' };
    }
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      return { ok: false, reason: 'error' };
    }
    return { ok: true, accessToken: body.access_token };
  } catch (error) {
    console.error('session exchange failed', { path, error });
    return { ok: false, reason: 'error' };
  }
}

/** Exchange a Google ID token (sent as the bearer) for an app session. */
export function postSession(googleIdToken: string): Promise<SessionResult> {
  return exchange('/auth/session', { headers: { authorization: `Bearer ${googleIdToken}` } });
}

/** Mint a fresh access token from the refresh cookie (no Google round-trip). */
export function postRefresh(): Promise<SessionResult> {
  return exchange('/auth/refresh', {});
}

/** Clear the refresh cookie server-side. Best-effort: errors are logged, not thrown. */
export async function postLogout(): Promise<void> {
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
    });
  } catch (error) {
    console.error('logout request failed', { error });
  }
}
