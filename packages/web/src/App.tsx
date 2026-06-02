import type { CompanionDto } from '@cobble/shared';
import { useEffect, useState } from 'react';
import { fetchCurrentUser, listCompanions } from './api/client.js';
import { Chat } from './pages/Chat.js';
import { CreateCompanion } from './pages/CreateCompanion.js';
import { SignIn } from './pages/SignIn.js';

type Status = 'loading' | 'signed-out' | 'no-companion' | 'ready';

/** Top-level state machine for the Phase 0 walking skeleton. */
export function App(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading');
  const [companion, setCompanion] = useState<CompanionDto | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    const user = await fetchCurrentUser();
    if (!user) {
      setStatus('signed-out');
      return;
    }
    const companions = await listCompanions();
    if (companions.length === 0) {
      setStatus('no-companion');
      return;
    }
    setCompanion(companions[0] ?? null);
    setStatus('ready');
  }

  if (status === 'loading') {
    return <main className="card">Loading…</main>;
  }
  if (status === 'signed-out') {
    return <SignIn />;
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
    return (
      <Chat
        companion={companion}
        onSignedOut={() => {
          setCompanion(null);
          setStatus('signed-out');
        }}
      />
    );
  }
  return <main className="card">Loading…</main>;
}
