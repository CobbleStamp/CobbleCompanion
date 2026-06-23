import { defineConfig } from 'vitest/config';

// Integration test runner: the suites that need a **real Postgres** (the
// pgvector/pgvector instance from docker-compose), as opposed to the in-memory
// PGlite used by the default `pnpm test`. Run via `make test-integration`, which
// boots Postgres and sets DATABASE_URL. These cover properties PGlite's single
// connection cannot exercise — concurrent claim races (deliver-scalability.md §7).
//
// Kept out of the default run by `*.integration.test.ts` being excluded from each
// package's vitest.config.ts; this config matches exactly those files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.integration.test.ts', 'db/src/**/*.integration.test.ts'],
    // A fresh database is created + migrated per file; allow headroom over the 5s
    // default for the CREATE DATABASE + migrate round-trips.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
