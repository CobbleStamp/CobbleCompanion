import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { schema } from './schema.js';

/**
 * The companion's persistence handle. Typed against {@link NodePgDatabase}; the
 * PGlite-backed test database (see ./testing.ts) is structurally compatible for
 * query building and is exposed through this same type.
 */
export type Database = NodePgDatabase<typeof schema>;

/** Create a production Postgres-backed database handle. TLS is expected in prod. */
export function createPgDatabase(connectionString: string): {
  db: Database;
  pool: pg.Pool;
} {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
