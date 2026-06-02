import { useAuth0 } from '@auth0/auth0-react';
import type { CompanionDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchCurrentUser, listCompanions, setAccessTokenGetter } from './api/client.js';
import { AuthBridge } from './auth/AuthBridge.js';
import type { AuthMode } from './auth/config.js';
import { Chat } from './pages/Chat.js';
import { CreateCompanion } from './pages/CreateCompanion.js';
import { SignIn } from './pages/SignIn.js';

interface AppProps {
  readonly authMode: AuthMode;
}

/** Top-level entry: Auth0 owns the signed-out gate; dev_bypass skips it. */
export function App({ authMode }: AppProps): JSX.Element {
  if (authMode === 'dev_bypass') {
    return <DevBypassApp />;
  }
  return <Auth0App />;
}

/** auth0 mode: gate the companion flow behind Universal Login. */
function Auth0App(): JSX.Element {
  const { isLoading, isAuthenticated, loginWithRedirect, logout } = useAuth0();

  if (isLoading) {
    return <main className="card">Loading…</main>;
  }
  if (!isAuthenticated) {
    return <SignIn onSignIn={() => void loginWithRedirect()} />;
  }
  return (
    <>
      <AuthBridge />
      <CompanionFlow
        onSignOut={() => void logout({ logoutParams: { returnTo: window.location.origin } })}
      />
    </>
  );
}

/** dev_bypass mode: no Auth0 provider; send a dummy bearer the API ignores. */
function DevBypassApp(): JSX.Element {
  useEffect(() => {
    setAccessTokenGetter(async () => 'dev');
  }, []);
  return <CompanionFlow onSignOut={() => window.location.reload()} />;
}

type Status = 'loading' | 'no-companion' | 'ready';

interface CompanionFlowProps {
  readonly onSignOut: () => void;
}

/** The authenticated walking skeleton: load companion, then chat. */
function CompanionFlow({ onSignOut }: CompanionFlowProps): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [companion, setCompanion] = useState<CompanionDto | null>(null);

  useEffect(() => {
    void (async () => {
      const user = await fetchCurrentUser();
      if (!user) {
        setStatus('loading');
        return;
      }
      const companions = await listCompanions();
      if (companions.length === 0) {
        setStatus('no-companion');
        return;
      }
      setCompanion(companions[0] ?? null);
      setStatus('ready');
    })();
  }, []);

  if (status === 'loading') {
    return <main className="card">Loading…</main>;
  }
  if (status === 'no-companion') {
    return (
      <CreateCompanion
        onCreated={(created) => {
          setCompanion(created);
          setStatus('ready');
        }}
      />
    );
  }
  if (companion) {
    return <Chat companion={companion} onSignOut={onSignOut} />;
  }
  return <main className="card">Loading…</main>;
}
