import { defineConfig } from 'vitest/config';

/**
 * API tests run against a real Postgres with RLS enabled (CLAUDE.md §10).
 * The `security` project holds the four mandatory per-module suites and is a
 * required CI gate.
 */
export default defineConfig({
  test: {
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
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
        test: { name: 'security', include: ['src/**/*.security.spec.ts'] },
      },
    ],
  },
});
