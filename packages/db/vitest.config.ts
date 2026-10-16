import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres with RLS enabled, started once
 * for the whole run by the global setup (CLAUDE.md §10).
 *
 * Two projects, so `pnpm test:security` can run the isolation and permission
 * suites on their own. That job is a required CI gate and must never be
 * skipped or made optional.
 */
export default defineConfig({
  test: {
    globalSetup: ['./src/testing/global-setup.ts'],
    // Containers are slow to start; give the suite room without hiding a hang.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.security.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'security',
          include: ['src/**/*.security.spec.ts'],
        },
      },
    ],
  },
});
