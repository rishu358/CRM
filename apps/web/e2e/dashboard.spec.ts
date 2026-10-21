import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The dashboard, end to end (MVP_SPEC M10, ADR-0038).
 *
 * Through the browser because the claim worth proving crosses every layer: the
 * sign-in redirect that makes this the landing page, five endpoints that
 * authorize one widget at a time, and cards that each have to cope with their own
 * loading, refusal and empty states. The seed gives the owner a pipeline across
 * four open stages (one deal in dollars), a deal won today, and leads from four
 * sources; the rep owns two of the deals and two of the leads.
 *
 * Assertions about numbers are about shape and scope, not exact money: other
 * suites win and lose deals, and a dashboard test that failed because a deals
 * test had run first would be testing the order, not the dashboard.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

test.describe('landing', () => {
  test('signing in lands on the dashboard, which is the first thing in the sidebar', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);

    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main navigation' }).first();
    await expect(nav.getByRole('list').first().getByRole('link').first()).toHaveText(/Dashboard/);
    await expect(nav.getByRole('link', { name: /Dashboard/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('G then H gets back from anywhere', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'Contacts' })).toBeVisible();

    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await page.waitForURL('**/dashboard');
  });
});

test.describe('the owner sees the whole company', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, credentials.owner);
  });

  test('shows the four headline figures, each with a value rather than a spinner', async ({
    page,
  }) => {
    for (const label of [
      'Won this month',
      'Open pipeline',
      'Open leads by source',
      'Overdue tasks',
    ]) {
      const card = page.locator('section').first().getByText(label, { exact: true });
      await expect(card).toBeVisible();
    }
    // Loading skeletons are gone once the figures arrive.
    await expect(page.getByRole('status', { name: 'Loading this figure' })).toHaveCount(0);
    // Money is shown as money, in the company's currency.
    await expect(page.locator('section').first().getByText(/₹/).first()).toBeVisible();
  });

  test('the pipeline card lists the open stages in order and leaves Won and Lost out', async ({
    page,
  }) => {
    const card = page.getByTestId('widget-pipeline');
    const stages = card.getByRole('listitem');
    await expect(stages.first()).toBeVisible();
    await expect(stages).toHaveCount(4);
    await expect(stages.nth(0)).toContainText('New');
    await expect(stages.nth(1)).toContainText('Qualified');
    await expect(stages.nth(2)).toContainText('Proposal');
    await expect(stages.nth(3)).toContainText('Negotiation');
    await expect(card.getByText('Won', { exact: true })).toHaveCount(0);
  });

  test('the leads card groups by source, with the seeded ones', async ({ page }) => {
    const card = page.getByTestId('widget-leads');
    await expect(card.getByText('Website', { exact: true })).toBeVisible();
    await expect(card.getByText('Referral', { exact: true })).toBeVisible();
    await expect(card.getByText('Exhibition', { exact: true })).toBeVisible();
  });

  test('the leaderboard ranks people and marks which one is you', async ({ page }) => {
    const card = page.getByTestId('widget-leaderboard');
    await expect(card.getByText('You', { exact: true })).toBeVisible();
    await expect(card.getByLabel('Rank 1')).toBeVisible();
  });

  test('a card links to where the work is done', async ({ page }) => {
    await page.getByRole('link', { name: 'Open the board' }).click();
    await page.waitForURL('**/deals');
    await page.goBack();
    await page.getByRole('link', { name: 'Open My Day' }).click();
    await page.waitForURL('**/my-day');
  });
});

test.describe('a rep sees only their own work', () => {
  test('the leaderboard has nobody else on it, and the lead sources are only theirs', async ({
    page,
  }) => {
    await signIn(page, credentials.rep);

    const board = page.getByTestId('widget-leaderboard');
    // Another suite may have given this rep a win, so the board may be empty or have one
    // row. What it may never have is a row for somebody else.
    await expect(board.getByRole('status')).toHaveCount(0);
    expect(await board.locator('li').count()).toBeLessThanOrEqual(1);
    await expect(board.locator('li').filter({ hasNotText: 'You' })).toHaveCount(0);

    const leads = page.getByTestId('widget-leads');
    await expect(leads.getByText('Website', { exact: true })).toBeVisible();
    // The owner's leads came from these, and the rep owns none of them.
    await expect(leads.getByText('Exhibition', { exact: true })).toHaveCount(0);
    await expect(leads.getByText('Referral', { exact: true })).toHaveCount(0);
  });

  test('does not get the setup checklist, which is for administrators', async ({ page }) => {
    await signIn(page, credentials.rep);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('nothing scrolls sideways and every card is reachable', async ({ page }) => {
    await signIn(page, credentials.owner);
    await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    for (const heading of [
      'Open pipeline',
      'Open leads by source',
      'Overdue tasks',
      'Leaderboard',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
  });
});
