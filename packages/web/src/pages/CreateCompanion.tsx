import type { CompanionDto } from '@cobble/shared';
import { useState } from 'react';
import { createCompanion } from '../api/client.js';

interface CreateCompanionProps {
  readonly onCreated: (companion: CompanionDto) => void;
}

/** Step 2: seed a companion — name, form, temperament (product-overview.md §5.5). */
export function CreateCompanion({ onCreated }: CreateCompanionProps): JSX.Element {
  const [name, setName] = useState('');
  const [form, setForm] = useState('');
  const [temperament, setTemperament] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const companion = await createCompanion({ name, form, temperament });
      onCreated(companion);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="card">
      <h1>Create your companion</h1>
      <form onSubmit={onSubmit}>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pebble"
        />
        <label htmlFor="form">Form</label>
        <input
          id="form"
          required
          value={form}
          onChange={(e) => setForm(e.target.value)}
          placeholder="a small clever fox"
        />
        <label htmlFor="temperament">Temperament</label>
        <input
          id="temperament"
          required
          value={temperament}
          onChange={(e) => setTemperament(e.target.value)}
          placeholder="curious, warm, a little mischievous"
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Bring them to life'}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
