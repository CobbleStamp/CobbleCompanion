const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export interface AuthBootstrap {
  readonly googleClientId: string;
}

interface RawConfig {
  readonly google_client_id?: string;
}

/**
 * Fetch the SPA auth config from the public `/auth/config` endpoint before mounting
 * the Google provider. A single bundle can then target any environment without
 * build-time secrets.
 */
export async function fetchAuthBootstrap(): Promise<AuthBootstrap> {
  const res = await fetch(`${API_URL}/auth/config`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`GET /auth/config failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as RawConfig;
  const cfg: AuthBootstrap = {
    googleClientId: raw.google_client_id ?? '',
  };
  if (!cfg.googleClientId) {
    throw new Error(
      'Google Sign-In not configured on the API: /auth/config returned an ' +
        'empty google_client_id. Set GOOGLE_CLIENT_ID in the API env.',
    );
  }
  return cfg;
}
