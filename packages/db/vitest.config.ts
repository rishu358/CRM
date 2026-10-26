import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres with RLS enabled, started once
 * for the whole run by the global setup (CLAUDE.md §10).
 *
 * Three projects:
 *
 *  - `unit` and `security` run together, in parallel. `pnpm test:security` runs
 *    the isolation and permission suites on their own; that job is a required CI
 *    gate and must never be skipped or made optional.
 *  - `perf` runs after them, one file at a time (ADR-0054). Each perf file builds
 *    tens of thousands of rows and their indexes in the one shared Postgres; run
 *    beside everything else, that took the container to roughly seven cores on a
 *    twelve-core machine and starved every other file's connections past their
 *    five-second connect timeout, so a different, unrelated test failed each time.
 *    The perf files are slow because they build a lot, not because they are
 *    unreliable, so the fix is to give them the database to themselves.
 */
export default defineConfig({
  test: {
    globalSetup: ['./src/testing/global-setup.ts'],
    // Containers are slow to start; give the suite room without hiding a hang.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // Every file talks to the one shared Postgres. Vitest's default is one worker per core minus one
    // (eleven on the development machine), which saturated that container and made unrelated
    // connections time out; four is measured, not a guess (ADR-0054). GitHub's two-core runners
    // already get one.
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.security.spec.ts', 'src/**/*.perf.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'security',
          include: ['src/**/*.security.spec.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'perf',
          include: ['src/**/*.perf.spec.ts'],
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
