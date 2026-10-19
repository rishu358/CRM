import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Audit viewer, Recycle Bin and data rights, end to end (MVP_SPEC M4, M11).
 *
 * These three screens cross every layer, and what is being checked is not that
 * the markup renders — the component tests cover that — but that the *rules*
 * survive the whole stack:
 *
 *   - a rep without the audit capability gets the no-permission state, because
 *     the API refused the request;
 *   - a record deleted in the app appears in the Bin and comes back from it,
 *     which means the restore wrote, the event relayed and the list re-fetched;
 *   - an erasure asked for in the browser actually reaches the worker, the
 *     narrow erasure role and the audit log.
 *
 * Needs the API, the worker and MinIO running (see `.env.example`).
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/contacts');
}

/** A surname no other run shares, so a test finds exactly its own record. */
const unique = (): string => `Zz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const SLOW = { timeout: 60_000 };

test.describe('the audit viewer', () => {
  test('shows an administrator the log, and tells a rep they cannot read it', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/audit-log');

    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    // Signing in is itself audited, so there is always at least one row.
    await expect(page.getByText('login').first()).toBeVisible(SLOW);

    await signIn(page, credentials.rep);
    await page.goto('/settings/audit-log');
    await expect(
      page.getByText('You do not have access to the audit log'),
    ).toBeVisible(SLOW);
  });

  test('filters by object type without losing the page', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/audit-log');

    await page.getByLabel('Object').selectOption('contact');
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    // Either rows about contacts, or an honest empty state — never an error.
    await expect(page.getByText('Could not load the audit log')).toBeHidden();
  });
});

test.describe('the recycle bin', () => {
  test('a deleted contact appears in the bin and can be restored', async ({ page }) => {
    const surname = unique();

    await signIn(page, credentials.owner);
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    await page.getByLabel('Last name').fill(surname);
    await page.getByRole('button', { name: 'Create contact' }).click();

    await page.getByRole('link', { name: surname }).click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete contact' }).click();
    await page.waitForURL('**/contacts');

    await page.goto('/settings/recycle-bin');
    await expect(page.getByRole('heading', { name: 'Recycle bin' })).toBeVisible();
    const row = page.getByRole('listitem').filter({ hasText: surname });
    await expect(row).toBeVisible(SLOW);

    await row.getByRole('button', { name: 'Restore' }).click();
    await expect(row).toBeHidden(SLOW);

    // Back in the list it was deleted from.
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: surname })).toBeVisible(SLOW);
  });
});

test.describe('data rights', () => {
  test('the Owner can produce a workspace archive and a rep cannot', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/data-rights');

    await expect(page.getByRole('heading', { name: 'Export this workspace' })).toBeVisible();
    await page
      .getByRole('heading', { name: 'Export this workspace' })
      .locator('..')
      .locator('..')
      .getByRole('button', { name: 'Create archive' })
      .click();

    // The worker produces it in the background; the page polls until the link
    // is offered.
    await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible(SLOW);

    await signIn(page, credentials.rep);
    await page.goto('/settings/data-rights');
    await expect(page.getByText('Only the Owner can export the workspace')).toBeVisible(SLOW);
  });

  test('erasing a person asks twice, then redacts their audit diffs', async ({ page }) => {
    const surname = unique();

    await signIn(page, credentials.owner);
    await page.goto('/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    await page.getByLabel('Last name').fill(surname);
    await page.getByLabel('Email').fill(`${surname.toLowerCase()}@example.com`);
    await page.getByRole('button', { name: 'Create contact' }).click();

    await page.getByRole('link', { name: surname }).click();
    const recordId = page.url().split('/').pop() ?? '';
    expect(recordId).not.toBe('');

    await page.goto('/settings/data-rights');
    const erase = page
      .getByRole('heading', { name: 'Erase a person' })
      .locator('..')
      .locator('..');
    await erase.getByLabel('Record ID').fill(recordId);
    await erase.getByLabel('Reason (optional)').fill('E2E: data subject request');

    // Asked twice, deliberately: the first click only arms the confirmation.
    await erase.getByRole('button', { name: 'Erase this person' }).click();
    await expect(page.getByText('This cannot be undone.')).toBeVisible();
    await erase.getByRole('button', { name: 'Yes, erase permanently' }).click();

    // The request shows in the workspace's compliance record and completes.
    await expect(erase.getByText('completed')).toBeVisible(SLOW);

    // And the audit log now shows the redacted values rather than the address.
    await page.goto('/settings/audit-log');
    await page.getByLabel('Object').selectOption('contact');
    await expect(page.getByText(`${surname.toLowerCase()}@example.com`)).toBeHidden(SLOW);
  });
});
