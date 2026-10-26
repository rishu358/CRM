// LOCAL ONLY, never committed. Same projects as vitest.config.ts, with the local database setup.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./local-db-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 180_000,
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
      {
        extends: true,
        test: { name: 'security', include: ['src/**/*.security.spec.ts'] },
      },
    ],
  },
});
