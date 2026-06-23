import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests (`*.integration.test.ts`) need a real Postgres and run
    // only via `make test-integration` / vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    // Many suites now drive the product over a real WebSocket listener (Phase D —
    // the one surface), so under full-suite parallelism a turn's handshake + claim +
    // streamed agent loop can run well past the 5s default. Give them headroom; in
    // isolation each is sub-second.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
