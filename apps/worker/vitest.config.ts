import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
    /**
     * One suite at a time.
     *
     * The relay claims `outbox_events` **across every tenant** — the one
     * documented exception to tenant scoping, and the reason the worker has a
     * role of its own. Two test files each running a relay therefore steal
     * each other's events: the other file's relay claims the row, finds no
     * handler subscribed to that type, and marks it relayed. The event is
     * gone and the test that was waiting for it fails somewhere unrelated.
     *
     * It is the production design working, not a flake to retry. Suites that
     * drive a relay cannot run concurrently against one queue, so they do not.
     */
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.spec.ts'],
          exclude: ['src/**/*.security.spec.ts'],
        },
      },
      { extends: true, test: { name: 'security', include: ['src/**/*.security.spec.ts'] } },
    ],
  },
});
