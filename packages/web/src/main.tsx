import { GoogleOAuthProvider } from '@react-oauth/google';
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
 * Fetch the auth config, then mount the right tree: <GoogleOAuthProvider/> for
 * google mode (Google Identity Services), or the bare app for dev_bypass.
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
    <GoogleOAuthProvider clientId={state.cfg.googleClientId}>
      <App authMode="google" />
    </GoogleOAuthProvider>
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
