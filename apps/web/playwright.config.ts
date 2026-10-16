import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the critical flows (CLAUDE.md §10).
 *
 * These exercise the whole stack — browser, Next.js, the credential proxy, the
 * API, RLS — because the properties being checked (a rep sees only their own
 * records, an edit persists) are produced by all of those together, and
 * testing any one layer alone would prove none of it.
 *
 * The API and a seeded database must already be running; `globalSetup` seeds a
 * tenant and hands the tests real session tokens.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @crm/web dev',
    url: process.env.WEB_URL ?? 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: '../..',
  },
});
