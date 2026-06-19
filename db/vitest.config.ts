import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests (`*.integration.test.ts`) need a real Postgres and run
    // only via `make test-integration` / vitest.integration.config.ts.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
