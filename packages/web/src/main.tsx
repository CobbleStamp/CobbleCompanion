import { Auth0Provider } from '@auth0/auth0-react';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { fetchAuthBootstrap, type AuthBootstrap } from './auth/config.js';
import './styles.css';

type BootstrapState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly cfg: AuthBootstrap }
  | { readonly kind: 'error'; readonly error: Error };

/**
 * Fetch the auth config, then mount the right tree: <Auth0Provider/> for auth0
 * mode (PKCE Universal Login), or the bare app for dev_bypass.
 */
function Bootstrap(): JSX.Element {
  const [state, setState] = useState<BootstrapState>({ kind: 'loading' });

  useEffect(() => {
    fetchAuthBootstrap()
      .then((cfg) => setState({ kind: 'ready', cfg }))
      .catch((err: unknown) =>
        setState({ kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }),
      );
  }, []);

  if (state.kind === 'loading') {
    return <main className="card">Loading…</main>;
  }
  if (state.kind === 'error') {
    return (
      <main className="card">
        <h1>Sign-in unavailable</h1>
        <p className="error">{state.error.message}</p>
      </main>
    );
  }

  if (state.cfg.mode === 'dev_bypass') {
    return <App authMode="dev_bypass" />;
  }

  return (
    <Auth0Provider
      domain={state.cfg.domain}
      clientId={state.cfg.clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: state.cfg.audience,
        scope: 'openid profile email offline_access',
      }}
      cacheLocation="localstorage"
      useRefreshTokens
    >
      <App authMode="auth0" />
    </Auth0Provider>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}
createRoot(container).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
);
