import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import type { Database } from './client.js';
import { schema } from './schema.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * An in-memory PGlite-backed database with the full schema applied via the same
 * generated migrations as production (testing.md "use an in-memory database
 * instead of mocking DB calls"). Returns the drizzle handle and a `close()`.
 */
export async function createTestDatabase(): Promise<{
  db: Database;
  close: () => Promise<void>;
}> {
  // pgvector is loaded so the same migrations (incl. CREATE EXTENSION vector)
  // run against PGlite as against server Postgres.
  const client = new PGlite({ extensions: { vector } });
  const pglite = drizzle(client, { schema });
  await migrate(pglite, { migrationsFolder });
  // PGlite and node-postgres drizzle handles share the same query-builder surface
  // for our schema; expose it through the production Database type.
  const db = pglite as unknown as Database;
  return {
    db,
    close: async () => {
      await client.close();
    },
  };
}
