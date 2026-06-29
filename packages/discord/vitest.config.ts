import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Integration tests (`*.integration.test.ts`) drive a real `/ws` + Postgres and
    // run only via the integration config, like the api package.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
