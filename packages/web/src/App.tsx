import { googleLogout } from '@react-oauth/google';
import type { CompanionDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchCurrentUser, listCompanions } from './api/client.js';
import { sessionManager } from './auth/session-manager.js';
import { Activity } from './pages/Activity.js';
import { Chat } from './pages/Chat.js';
import { CreateCompanion } from './pages/CreateCompanion.js';
import { Discord } from './pages/Discord.js';
import { Growth } from './pages/Growth.js';
import { MemoryBrowser } from './pages/MemoryBrowser.js';
import { SignIn } from './pages/SignIn.js';
import { Sources } from './pages/Sources.js';

type AuthStatus = 'restoring' | 'signed-out' | 'signed-in';

/**
 * Top-level entry: gate the companion flow behind an app-managed session
 * (implementation.md §5). The <GoogleLogin> credential is exchanged **once** for the
 * API's own access token (held in memory by {@link sessionManager}) plus an HttpOnly
 * refresh cookie. On load the session is restored from that cookie via `/auth/refresh`
 * — no sign-in prompt — and the manager refreshes the access token transparently
 * thereafter. When a refresh fails for good (the refresh token expired), the expire
 * handler routes back to the sign-in gate, which also unmounts <Chat> and so stops its
 * WS reconnect loop.
 */
export function App(): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('restoring');

  useEffect(() => {
    let cancelled = false;
    const off = sessionManager.setOnExpire(() => {
      if (!cancelled) setStatus('signed-out');
    });
    void (async () => {
      const restored = await sessionManager.restore();
      if (!cancelled) setStatus(restored ? 'signed-in' : 'signed-out');
    })();
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  if (status === 'restoring') {
    return <main className="card">Loading…</main>;
  }
  if (status === 'signed-out') {
    return (
      <SignIn
        onCredential={async (idToken) => {
          const ok = await sessionManager.signIn(idToken);
          if (ok) setStatus('signed-in');
          return ok;
        }}
      />
    );
  }
  return (
    <CompanionFlow
      onSignOut={() => {
        googleLogout();
        void sessionManager.signOut();
        setStatus('signed-out');
      }}
    />
  );
}

type Status = 'loading' | 'no-companion' | 'ready';

interface CompanionFlowProps {
  readonly onSignOut: () => void;
}

type View = 'chat' | 'memory' | 'sources' | 'growth' | 'activity' | 'discord';

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
    if (view === 'activity') {
      return (
        <Activity
          companionName={companion.name}
          companionId={companion.id}
          onBack={() => setView('chat')}
        />
      );
    }
    if (view === 'discord') {
      return (
        <Discord
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
        onOpenActivity={() => setView('activity')}
        onOpenDiscord={() => setView('discord')}
      />
    );
  }
  return <main className="card">Loading…</main>;
}
