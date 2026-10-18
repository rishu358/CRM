import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    // The S3 adapter test starts a MinIO container, which has to be pulled and
    // booted before the first assertion.
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});
