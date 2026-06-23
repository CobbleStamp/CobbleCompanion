import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createPgDatabase, type Database } from './client.js';
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

/**
 * A throwaway database on a **real Postgres** server (the `pgvector/pgvector`
 * instance from docker-compose), migrated with the production migrations. Use
 * this — not {@link createTestDatabase} — for the integration suite
 * (`*.integration.test.ts`, run via `make test-integration`), where the property
 * under test depends on real Postgres semantics that single-connection PGlite
 * cannot exercise: concurrent `ON CONFLICT DO UPDATE … setWhere` claim races
 * (deliver-scalability.md §7 Q1; job-queue.ts, embodiment/store.ts).
 *
 * One fresh database per call (named `cobble_it_<rand>`) gives full isolation, so
 * files run in parallel without colliding. `connectionString` is exposed so a test
 * can open **additional** handles ({@link createPgDatabase}) — separate pools use
 * separate backend connections, which is what makes the race real. `close()` drops
 * the database (terminating any straggler connections first).
 *
 * Reads `DATABASE_URL` (the server + a maintenance database to issue
 * `CREATE DATABASE` against); throws if unset.
 */
export interface IntegrationDatabase {
  db: Database;
  connectionString: string;
  close: () => Promise<void>;
}

export async function createIntegrationDatabase(): Promise<IntegrationDatabase> {
  const adminUrl = process.env['DATABASE_URL'];
  if (!adminUrl) {
    throw new Error(
      'DATABASE_URL is required for integration tests — run them via `make test-integration` ' +
        '(boots the docker-compose Postgres) rather than `pnpm test`.',
    );
  }

  const dbName = `cobble_it_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Identifier is hex-only, but quote it anyway — never interpolate untrusted
    // data into DDL (this value is generated, not user-supplied).
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  const testUrl = withDatabase(adminUrl, dbName);
  const { db, pool } = createPgDatabase(testUrl);
  await migratePg(db, { migrationsFolder });

  return {
    db,
    connectionString: testUrl,
    close: async () => {
      await pool.end();
      const dropper = new pg.Client({ connectionString: adminUrl });
      await dropper.connect();
      try {
        // Extra handles a test opened may still hold connections; terminate them
        // so DROP DATABASE is not blocked.
        await dropper.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity ' +
            'WHERE datname = $1 AND pid <> pg_backend_pid()',
          [dbName],
        );
        await dropper.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** Return `connectionString` with its database (path) swapped for `dbName`. */
function withDatabase(connectionString: string, dbName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${dbName}`;
  return url.toString();
}
