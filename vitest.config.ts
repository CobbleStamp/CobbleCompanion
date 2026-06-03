import { defineConfig } from 'vitest/config';

// Root test runner for the whole monorepo. Each package declares its own project
// config (environment, setup). Coverage is enforced on the companion logic
// (shared/db/core/api); the web UI is exercised but excluded from the gate
// (development-plan.md §3 "≥80% coverage").
export default defineConfig({
  test: {
    projects: [
      'packages/shared/vitest.config.ts',
      'packages/core/vitest.config.ts',
      'packages/api/vitest.config.ts',
      'packages/web/vitest.config.ts',
      'db/vitest.config.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'packages/shared/src/**/*.ts',
        'db/src/**/*.ts',
        'packages/core/src/**/*.ts',
        'packages/api/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/*.d.ts',
        'packages/api/src/test/**',
        'db/src/migrate.ts',
        'db/src/testing.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
