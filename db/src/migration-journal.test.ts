/**
 * Migration-journal ordering tests.
 *
 * Drizzle's migrator applies a migration only when its journal `when`
 * timestamp is greater than the max `created_at` recorded in
 * `__drizzle_migrations`. A journal whose `when` values are not strictly
 * increasing therefore *silently skips* migrations on any database that
 * upgraded incrementally — while a fresh database (like the replay test's)
 * applies everything and hides the bug.
 *
 * Regression for: 0002 was committed with a hand-rounded `when` later than
 * 0003–0005's, so existing volumes at 0002-tip never received 0003–0005
 * ("relation ingestion_jobs does not exist" on API boot).
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

async function readJournal(): Promise<Journal> {
  const raw = await readFile(join(migrationsFolder, 'meta', '_journal.json'), 'utf8');
  return JSON.parse(raw) as Journal;
}

/** Copy the migrations folder, truncating the journal to its first `count` entries. */
async function writePrefixFolder(journal: Journal, count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cobble-migrations-prefix-'));
  await cp(migrationsFolder, dir, { recursive: true });
  const truncated: Journal = { ...journal, entries: journal.entries.slice(0, count) };
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(truncated), 'utf8');
  return dir;
}

async function listTables(client: PGlite): Promise<string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return result.rows.map((row) => row.table_name);
}

describe('migration journal ordering', () => {
  it('has strictly increasing `when` timestamps (drizzle skips out-of-order entries)', async () => {
    const journal = await readJournal();
    expect(journal.entries.length).toBeGreaterThan(0);
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const curr = journal.entries[i]!;
      expect(
        curr.when,
        `journal entry ${curr.tag} (when=${curr.when}) must be after ${prev.tag} (when=${prev.when})`,
      ).toBeGreaterThan(prev.when);
    }
  });

  // Spins up a fresh PGlite per migration prefix and replays the whole folder
  // through each — this is single-threaded WASM CPU work that is inherently
  // O(migrations²) and grows with every new migration. In isolation it runs in
  // ~6s, but the full monorepo suite (~120 files in one vitest run) oversubscribes
  // CI's few cores ~2.5x, stretching it well past a 30s ceiling. Parallelizing the
  // prefixes doesn't help (one worker thread, CPU-bound), so the fix is headroom:
  // a broken migration throws immediately rather than hanging, so a high timeout
  // never delays a real failure — it only absorbs scheduling jitter under load.
  it(
    'reaches the final schema from every incremental upgrade point',
    { timeout: 120_000 },
    async () => {
      const journal = await readJournal();
      // For each prefix length: migrate to that point, then migrate with the
      // full folder — the path every existing database takes on upgrade.
      for (let count = 1; count < journal.entries.length; count++) {
        const prefixFolder = await writePrefixFolder(journal, count);
        const client = new PGlite({ extensions: { vector } });
        try {
          const db = drizzle(client);
          await migrate(db, { migrationsFolder: prefixFolder });
          await migrate(db, { migrationsFolder });
          const tables = await listTables(client);
          expect(tables, `upgrade from prefix of ${count} migrations`).toEqual(
            expect.arrayContaining([
              'companions',
              'ingestion_jobs',
              'sections',
              'user_token_usage',
            ]),
          );
        } finally {
          await client.close();
          await rm(prefixFolder, { recursive: true, force: true });
        }
      }
    },
  );
});
