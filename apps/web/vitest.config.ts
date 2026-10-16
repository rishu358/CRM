import { defineConfig } from 'vitest/config';

/**
 * Component-level tests only.
 *
 * `e2e/` is Playwright's, and its specs import `@playwright/test`; without this
 * exclusion Vitest collects them and fails on an import it cannot satisfy.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    environment: 'node',
  },
});
