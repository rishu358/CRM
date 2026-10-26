import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Critical flows (MVP_SPEC §7, CLAUDE.md §10).
 *
 * Deliberately end to end: the record-scope rule being checked here is enforced
 * in SQL by RLS and the permission engine, surfaced through the API, and only
 * then rendered. Asserting it in the browser is the only way to know the whole
 * chain holds together.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

/** Sign in through the real form, against the real API (MVP_SPEC M1). */
async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto('/contacts');
}

test.describe('record scope', () => {
  test('a sales rep sees only their own contacts', async ({ page }) => {
    await signIn(page, credentials.rep);

    await expect(page.getByRole('link', { name: 'Khan' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'DSouza' })).toBeVisible();
    // Owned by the other user; `own` scope must exclude them.
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Reddy' })).toHaveCount(0);
  });

  test('an owner sees every contact in the tenant', async ({ page }) => {
    await signIn(page, credentials.owner);

    for (const name of ['Sharma', 'Reddy', 'Khan', 'DSouza']) {
      await expect(page.getByRole('link', { name })).toBeVisible();
    }
  });
});

test.describe('creating and editing a contact', () => {
  test('creates a contact and shows it in the list', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const surname = `Testcase${Date.now().toString().slice(-6)}`;
    await dialog.getByLabel('First name').fill('Playwright');
    await dialog.getByLabel('Last name').fill(surname);
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: surname })).toBeVisible();
  });

  test('shows the duplicate prompt when the email matches an existing contact', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog');
    const surname = `Twin${Date.now().toString().slice(-6)}`;
    await dialog.getByLabel('Last name').fill(surname);
    // The seed's contact Fatima Khan, whom the owner may read.
    await dialog.getByLabel('Email').fill('fatima.khan@example.com');
    await dialog.getByRole('button', { name: 'Save' }).click();

    // Nothing was saved yet: the prompt is shown first, with the match and why.
    const prompt = dialog.getByTestId('duplicate-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole('link', { name: 'Fatima Khan' })).toBeVisible();
    await expect(prompt).toContainText('same email');
    await expect(page.getByRole('link', { name: surname })).toHaveCount(0);

    // "Back to edit" returns to the form with what was typed still in it.
    await prompt.getByRole('button', { name: 'Back to edit' }).click();
    await expect(dialog.getByLabel('Last name')).toHaveValue(surname);

    // The prompt informs, it does not block: saving anyway creates the contact.
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByRole('button', { name: 'Save anyway' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: surname })).toBeVisible();
  });

  test('inline edit persists across a reload', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);

    const title = `Partner ${Date.now().toString().slice(-5)}`;
    await page.getByRole('button', { name: 'Edit: Job title' }).click();
    await page.getByLabel('Job title').fill(title);
    await page.getByLabel('Job title').press('Enter');

    await expect(page.getByRole('button', { name: 'Edit: Job title' })).toContainText(title);

    // The real check: it survived the round trip, rather than only updating
    // the optimistic cache.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit: Job title' })).toContainText(title);
  });

  test('rejects a contact with no last name', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('First name').fill('NoSurname');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
  });
});

test.describe('authentication', () => {
  test('an unauthenticated visitor cannot see contacts', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/contacts');

    // The API returns 401, so the list never renders rows.
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(0);
  });

  test('the wrong password is refused', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(credentials.owner);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('an unknown address is refused in exactly the same words', async ({ page }) => {
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill('nobody-at-all@example.com');
    await page.getByLabel('Password').fill(credentials.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Identical to the wrong-password message above. A different one here
    // would turn the sign-in form into a directory of who has an account
    // (MVP_SPEC M1).
    await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toHaveText(
      'Incorrect email address or password',
    );
  });

  test('signing out ends the session', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/sign-in');

    // And the session is genuinely gone, not just the cookie dropped locally:
    // going back to the list shows nothing.
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(0);
  });
});

test.describe('CSRF defence on the cookie-authenticated routes', () => {
  test('refuses a state-changing request from another origin', async ({ page, request }) => {
    await signIn(page, credentials.owner);

    // Same session cookie, but an Origin that is not ours. Without the check
    // any page on the internet could drive the API as the signed-in user.
    const response = await request.post('/api/proxy/contacts', {
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: { lastName: 'Forged' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(403);
  });

  test('refuses a state-changing request with no Origin header', async ({ page, request }) => {
    await signIn(page, credentials.owner);

    const response = await request.post('/api/proxy/contacts', {
      headers: { 'content-type': 'application/json' },
      data: { lastName: 'Forged' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(403);
  });

  test('still allows a same-origin write from the app itself', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog');
    const surname = `Sameorigin${Date.now().toString().slice(-6)}`;
    await dialog.getByLabel('Last name').fill(surname);
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('link', { name: surname })).toBeVisible();
  });
});
