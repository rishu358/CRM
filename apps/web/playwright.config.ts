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
  // A GitHub runner is about three to four times slower than a development
  // machine here: the same suite takes 8 minutes locally and 30 on CI. At the
  // local budget, 26 tests exceeded 30s — twice each, since CI already retries —
  // while every one of them passes locally. The budget is raised for CI only, so
  // a genuine hang is still caught quickly when running on a workstation.
  timeout: process.env.CI ? 90_000 : 30_000,
  expect: { timeout: process.env.CI ? 20_000 : 10_000 },
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
