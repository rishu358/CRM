import { defineConfig } from 'vitest/config';

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
      { extends: true, test: { name: 'security', include: ['src/**/*.security.spec.ts'] } },
    ],
  },
});
