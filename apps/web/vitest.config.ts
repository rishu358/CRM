import { defineConfig } from 'vitest/config';

/**
 * Component-level tests only.
 *
 * `e2e/` is Playwright's, and its specs import `@playwright/test`; without this
 * exclusion Vitest collects them and fails on an import it cannot satisfy.
 */
export default defineConfig({
  /*
   * `tsconfig.json` sets `jsx: preserve` because Next compiles the JSX itself, and
   * Vitest would otherwise be handed JSX it cannot parse. Components are
   * rendered to markup in tests (`react-dom/server`), so they are compiled here.
   */
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.spec.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    environment: 'node',
  },
});
