import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createPgDatabase } from './client.js';

/**
 * Apply pending migrations to the configured Postgres database. Run via
 * `pnpm db:migrate`. Excluded from coverage (an ops entrypoint).
 */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
  const { db, pool } = createPgDatabase(connectionString);
  try {
    await migrate(db, { migrationsFolder });
    // eslint-disable-next-line no-console
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed', error);
  process.exitCode = 1;
});
