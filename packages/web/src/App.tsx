import { googleLogout } from '@react-oauth/google';
import type { CompanionDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchCurrentUser, listCompanions, setAccessTokenGetter } from './api/client.js';
import type { AuthMode } from './auth/config.js';
import { clearStoredToken, loadStoredToken, storeToken } from './auth/session.js';
import { Chat } from './pages/Chat.js';
import { CreateCompanion } from './pages/CreateCompanion.js';
import { Growth } from './pages/Growth.js';
import { MemoryBrowser } from './pages/MemoryBrowser.js';
import { SignIn } from './pages/SignIn.js';
import { Sources } from './pages/Sources.js';

interface AppProps {
  readonly authMode: AuthMode;
}

/** Top-level entry: Google owns the signed-out gate; dev_bypass skips it. */
export function App({ authMode }: AppProps): JSX.Element {
  if (authMode === 'dev_bypass') {
    return <DevBypassApp />;
  }
  return <GoogleApp />;
}

/**
 * google mode: gate the companion flow behind Google Sign-In. The ID token from
 * the <GoogleLogin> credential is sent as the bearer on every request (stateless
 * — the API verifies it against Google's JWKS). It is persisted to
 * `sessionStorage` so a page refresh restores the session instead of bouncing
 * back to the sign-in gate; an expired token is dropped on load (see
 * ./auth/session.ts). The lazy initializer wires the token getter synchronously
 * on first render, before <CompanionFlow> mounts and calls fetchCurrentUser.
 */
function GoogleApp(): JSX.Element {
  const [idToken, setIdToken] = useState<string | null>(() => {
    const restored = loadStoredToken();
    if (restored !== null) {
      setAccessTokenGetter(async () => restored);
    }
    return restored;
  });

  if (!idToken) {
    return (
      <SignIn
        onCredential={(token) => {
          storeToken(token);
          setAccessTokenGetter(async () => token);
          setIdToken(token);
        }}
      />
    );
  }
  return (
    <CompanionFlow
      onSignOut={() => {
        googleLogout();
        clearStoredToken();
        setAccessTokenGetter(async () => null);
        setIdToken(null);
      }}
    />
  );
}

/** dev_bypass mode: no Google provider; send a dummy bearer the API ignores. */
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

type View = 'chat' | 'memory' | 'sources' | 'growth';

/** The authenticated flow: load companion, then chat, feed sources, or browse memory. */
function CompanionFlow({ onSignOut }: CompanionFlowProps): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [companion, setCompanion] = useState<CompanionDto | null>(null);
  const [view, setView] = useState<View>('chat');

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
    if (view === 'memory') {
      return <MemoryBrowser companion={companion} onBack={() => setView('chat')} />;
    }
    if (view === 'sources') {
      return (
        <Sources
          companionName={companion.name}
          companionId={companion.id}
          onBack={() => setView('chat')}
        />
      );
    }
    if (view === 'growth') {
      return (
        <Growth
          companionName={companion.name}
          companionId={companion.id}
          onBack={() => setView('chat')}
        />
      );
    }
    return (
      <Chat
        companion={companion}
        onSignOut={onSignOut}
        onOpenMemory={() => setView('memory')}
        onOpenSources={() => setView('sources')}
        onOpenGrowth={() => setView('growth')}
      />
    );
  }
  return <main className="card">Loading…</main>;
}
