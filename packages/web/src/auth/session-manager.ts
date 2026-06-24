/**
 * The single client-side authority for the app access token (implementation.md §5).
 * Holds the access token **in memory only** (never web storage — smaller XSS surface)
 * and keeps it fresh against the API:
 *
 *  - {@link SessionManager.getAccessToken} hands the transport (ws.ts) a valid token,
 *    transparently refreshing one that is missing or near `exp`. A definitive 401 on
 *    refresh fires {@link SessionManager.setOnExpire} so the UI can redirect to sign-in;
 *    a transient failure returns null without forcing sign-in (the caller may retry).
 *  - {@link SessionManager.signIn} performs the one-time Google-ID-token exchange.
 *  - {@link SessionManager.restore} re-establishes a session on page load from the
 *    HttpOnly refresh cookie, with no sign-in prompt.
 *  - {@link SessionManager.signOut} clears the token and the server-side cookie.
 *
 * Concurrent refreshes are de-duplicated to a single in-flight request, so a burst of
 * WS (re)connects after an expiry triggers exactly one `/auth/refresh`.
 */

import { postLogout, postRefresh, postSession, type SessionResult } from '../api/auth.js';
import { setAccessTokenGetter } from '../api/ws.js';
import { isTokenExpired } from './session.js';

/** The HTTP session calls, injectable so the manager is unit-testable without `fetch`. */
export interface SessionApi {
  postSession(googleIdToken: string): Promise<SessionResult>;
  postRefresh(): Promise<SessionResult>;
  postLogout(): Promise<void>;
}

/** Refresh this many ms before the access token's `exp`, so a refresh lands before a
 *  request would carry an already-dead token. */
const REFRESH_SKEW_MS = 30_000;

export class SessionManager {
  private token: string | null = null;
  private inflight: Promise<SessionResult> | null = null;
  private onExpire: (() => void) | null = null;

  constructor(
    private readonly api: SessionApi,
    private readonly now: () => number = Date.now,
  ) {}

  /** Register the handler invoked when the session is definitively gone (refresh
   *  returned 401). The UI redirects to the sign-in gate. Returns an unsubscribe. */
  setOnExpire(handler: () => void): () => void {
    this.onExpire = handler;
    return () => {
      if (this.onExpire === handler) this.onExpire = null;
    };
  }

  /** The transport's token getter: a valid access token, or null when none can be
   *  obtained. Refreshes ahead of `exp`; a 401 on refresh triggers the expire handler. */
  async getAccessToken(): Promise<string | null> {
    if (this.token && !isTokenExpired(this.token, this.now() + REFRESH_SKEW_MS)) {
      return this.token;
    }
    const result = await this.refresh();
    if (result.ok) return result.accessToken;
    if (result.reason === 'unauthorized') this.expire();
    return null;
  }

  /** Exchange a Google ID token for an app session. Returns whether it succeeded. */
  async signIn(googleIdToken: string): Promise<boolean> {
    const result = await this.api.postSession(googleIdToken);
    if (result.ok) {
      this.token = result.accessToken;
      return true;
    }
    return false;
  }

  /** Re-establish a session on page load from the refresh cookie. Returns whether a
   *  session was restored. Does not trigger the expire handler (no session yet to lose). */
  async restore(): Promise<boolean> {
    const result = await this.refresh();
    return result.ok;
  }

  /** Drop the session: clear the in-memory token and the server-side refresh cookie. */
  async signOut(): Promise<void> {
    this.token = null;
    await this.api.postLogout();
  }

  /** Refresh the access token, de-duplicating concurrent callers to one request. */
  private refresh(): Promise<SessionResult> {
    if (!this.inflight) {
      this.inflight = this.api
        .postRefresh()
        .then((result) => {
          if (result.ok) this.token = result.accessToken;
          return result;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private expire(): void {
    this.token = null;
    this.onExpire?.();
  }
}

/** The process-wide session manager, wired to the real HTTP session calls. */
export const sessionManager = new SessionManager({ postSession, postRefresh, postLogout });

// The transport (ws.ts) reads the bearer through this getter at every (re)connect, so
// an expired access token is refreshed transparently before a socket carries it.
setAccessTokenGetter(() => sessionManager.getAccessToken());
