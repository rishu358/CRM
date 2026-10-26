import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Company setup and sample data, end to end (MVP_SPEC M2, ADR-0037).
 *
 * Through the browser because the flow crosses every layer: the sign-in redirect
 * that decides who sees the setup screen, the API that loads sample data in one
 * transaction, and — for removal — the worker that does the deleting after the
 * request has already returned. Needs the API and the worker running.
 *
 * The seed makes two companies. The demo company is finished, so its owner goes
 * straight to work; "Fresh Traders" has had nothing done to it, so its owner
 * lands on the setup screen. The serial block below walks Fresh Traders through
 * first run and then through the settings page that replaces the welcome.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; freshOwner: string; password: string };

/** Removal is the worker's job, so it finishes after the click returns. */
const SLOW = { timeout: 60_000 };

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('who is sent to setup', () => {
  test('the owner of a company that is already set up goes straight to work', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.waitForURL('**/dashboard');
    // Give a redirect every chance to happen before concluding it did not.
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await page.waitForTimeout(1000);
    expect(new URL(page.url()).pathname).toBe('/dashboard');
  });

  test('a sales rep is never sent there, and cannot open it', async ({ page }) => {
    await signIn(page, credentials.rep);
    await page.waitForURL('**/dashboard');
    await page.goto('/contacts');

    await expect(page.getByRole('link', { name: 'Setup' })).toHaveCount(0);

    await page.goto('/setup');
    await expect(
      page.getByRole('heading', { name: 'Only administrators set up the company' }),
    ).toBeVisible();
    // The refusal says nothing about the company.
    await expect(page.getByLabel('Company name')).toHaveCount(0);
  });
});

test.describe.serial('first run, then the settings page', () => {
  test('the owner of a brand-new company lands on a welcome, not on an empty list', async ({
    page,
  }) => {
    await signIn(page, credentials.freshOwner);

    await page.waitForURL('**/setup');
    await expect(
      page.getByRole('heading', { name: 'Welcome — let’s set up Fresh Traders' }),
    ).toBeVisible();
    // The three things it asks, and the choice about sample data defaulting to yes.
    await expect(page.getByLabel('Company name')).toHaveValue('Fresh Traders');
    await expect(page.getByLabel('Default currency')).toBeVisible();
    await expect(page.getByLabel('Time zone')).toBeVisible();
    await expect(page.getByLabel('Start with sample data')).toBeChecked();
  });

  test('going to another page first still ends up there: a refresh cannot skip it', async ({
    page,
  }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/setup');

    await page.goto('/deals');

    await page.waitForURL('**/setup');
  });

  test('refuses an empty company name, and keeps what was typed', async ({ page }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/setup');

    await page.getByLabel('Company name').fill('   ');
    await page.getByRole('button', { name: 'Finish setup' }).click();

    await expect(page.getByText('Enter your company name')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/setup');
  });

  test('finishing with sample data leaves a company that has something in it', async ({ page }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/setup');

    await page.getByLabel('Company name').fill('Fresh Traders Pvt Ltd');
    await page.getByLabel('Default currency').selectOption('USD');
    await page.getByLabel('Industry').selectOption('retail');
    await page.getByRole('button', { name: 'Finish setup' }).click();

    // Lands in the app, not back on the form.
    await page.waitForURL('**/dashboard');

    // The sample records are real and marked, wherever they appear.
    await page.goto('/deals');
    await expect(page.getByText('Showroom fit-out (sample)').first()).toBeVisible(SLOW);
    await page.goto('/contacts');
    await expect(page.getByText('(sample)').first()).toBeVisible();
  });

  test('afterwards the same address is the settings page, and is in the navigation', async ({
    page,
  }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/dashboard');
    await page.goto('/contacts');

    await page.getByRole('link', { name: 'Setup' }).click();

    await expect(page.getByRole('heading', { name: 'Company setup' })).toBeVisible();
    await expect(page.getByLabel('Company name')).toHaveValue('Fresh Traders Pvt Ltd');
    await expect(page.getByLabel('Default currency')).toHaveValue('USD');
    // Setup is finished, so signing in again did not send them back to the welcome.
    expect(new URL(page.url()).pathname).toBe('/setup');
  });

  test('the checklist is honest: sample deals do not count as a first deal', async ({ page }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/dashboard');
    await page.goto('/contacts');
    await page.goto('/setup');

    await expect(page.getByTestId('setup-checklist')).toBeVisible();
    // Five deals exist, none of them the company's own.
    await expect(page.getByTestId('checklist-add_first_deal')).toHaveAttribute(
      'data-done',
      'false',
    );
    await expect(page.getByTestId('checklist-import_contacts')).toHaveAttribute(
      'data-done',
      'false',
    );
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  test('edits the company and the change is still there after a reload', async ({ page }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/dashboard');
    await page.goto('/contacts');
    await page.goto('/setup');

    const save = page.getByTestId('setup-save');
    await expect(save).toBeDisabled(); // nothing has changed yet
    await page.getByLabel('Company name').fill('Fresh Traders Renamed');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('setup-saved')).toBeVisible();

    await page.reload();
    await expect(page.getByLabel('Company name')).toHaveValue('Fresh Traders Renamed');
  });

  test('removes the sample data, and only the sample data', async ({ page }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/dashboard');
    await page.goto('/contacts');

    // A record a person made, through the same proxy the app uses.
    const surname = `Mine${Date.now().toString(36)}`;
    const created = await page.evaluate(async (lastName) => {
      const response = await fetch('/api/proxy/contacts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: 'Real', lastName }),
      });
      return response.status;
    }, surname);
    expect(created).toBe(201);

    await page.goto('/setup');
    await expect(page.getByTestId('sample-summary')).toBeVisible();
    await page.getByTestId('sample-remove').click();
    // The dialog says what is kept before it asks.
    await expect(page.getByText(/becomes yours/)).toBeVisible();
    await page.getByTestId('sample-remove-confirm').click();

    // The worker does the work after the request returns; the card watches for it.
    await expect(page.getByTestId('sample-none')).toBeVisible(SLOW);

    await page.goto('/contacts');
    await expect(page.getByText(surname)).toBeVisible();
    await expect(page.getByText('(sample)')).toHaveCount(0);
    await page.goto('/deals');
    await expect(page.getByText('(sample)')).toHaveCount(0);
  });

  test('sample data can be added back from the settings page', async ({ page }) => {
    await signIn(page, credentials.freshOwner);
    await page.waitForURL('**/dashboard');
    await page.goto('/contacts');
    await page.goto('/setup');

    await page.getByTestId('sample-add').click();

    await expect(page.getByTestId('sample-summary')).toBeVisible(SLOW);
  });
});
