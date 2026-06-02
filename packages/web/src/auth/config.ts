const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export type AuthMode = 'auth0' | 'dev_bypass';

export interface AuthBootstrap {
  readonly mode: AuthMode;
  readonly domain: string;
  readonly clientId: string;
  readonly audience: string;
}

interface RawConfig {
  readonly mode?: string;
  readonly auth0_domain: string;
  readonly auth0_client_id: string;
  readonly auth0_audience: string;
}

/**
 * Fetch the SPA auth config from the public `/auth/config` endpoint before
 * deciding which provider tree to mount. A single bundle can then target any
 * environment without build-time secrets.
 */
export async function fetchAuthBootstrap(): Promise<AuthBootstrap> {
  const res = await fetch(`${API_URL}/auth/config`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`GET /auth/config failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawConfig;
  const mode: AuthMode = raw.mode === 'dev_bypass' ? 'dev_bypass' : 'auth0';
  const cfg: AuthBootstrap = {
    mode,
    domain: raw.auth0_domain,
    clientId: raw.auth0_client_id,
    audience: raw.auth0_audience,
  };
  if (mode === 'auth0' && (!cfg.domain || !cfg.clientId || !cfg.audience)) {
    throw new Error(
      'Auth0 not configured on the API: /auth/config returned empty domain / ' +
        'client_id / audience. Set AUTH0_DOMAIN, AUTH0_CLIENT_ID and ' +
        'AUTH0_AUDIENCE in the API env.',
    );
  }
  return cfg;
}
