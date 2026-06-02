import { useState } from 'react';
import { requestMagicLink } from '../api/client.js';

/** Step 1 of the walking skeleton: request a magic-link sign-in email. */
export function SignIn(): JSX.Element {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestMagicLink(email);
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="card">
        <h1>Check your email</h1>
        <p>
          We sent a sign-in link to <strong>{email}</strong>. Open it to meet your companion. (In
          dev, the link is printed in the API server log.)
        </p>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>CobbleCompanion</h1>
      <p>Sign in to raise your companion.</p>
      <form onSubmit={onSubmit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send sign-in link'}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
