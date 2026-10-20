import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Audit viewer, Recycle Bin and data rights, end to end (MVP_SPEC M4, M11).
 *
 * These three screens cross every layer, and what is being checked is not that
 * the markup renders but that the *rules* survive the whole stack:
 *
 *   - a rep without the audit capability gets the no-permission state, because
 *     the API refused the request;
 *   - a deleted record appears in the Bin and comes back from it, which means
 *     the restore wrote, the event relayed and the list re-fetched;
 *   - an erasure asked for in the browser reaches the worker, the narrow
 *     erasure role and the audit log — and the audit page then shows
 *     `[erased]` where the address was.
 *
 * Needs the API, the worker and MinIO running (see `.env.example`), and the web
 * app on `next start`, not `next dev` (hydration is too slow on a loaded
 * machine for "click straight after load").
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

async function signIn(page: Page, email: string): Promise<void> {
  // A second sign-in in the same browser context would be redirected away from
  // the form by the first session, so start from none.
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/contacts');
}

/** A surname no other run shares, so a test finds exactly its own record. */
const unique = (): string => `Zz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const SLOW = { timeout: 60_000 };

/** Create a contact through the dialog, and return its id. Starts on /contacts. */
async function createContact(
  page: Page,
  surname: string,
  email?: string,
): Promise<string> {
  await page.getByRole('button', { name: 'New contact' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Last name').fill(surname);
  if (email !== undefined) await dialog.getByLabel('Email').fill(email);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('link', { name: surname }).click();
  await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
  return page.url().split('/').pop() ?? '';
}

/** The card a heading sits in. The design system's Card is the only `rounded-lg` ancestor. */
function cardWith(page: Page, heading: string): Locator {
  return page
    .getByRole('heading', { name: heading })
    .locator('xpath=ancestor::div[contains(@class, "rounded-lg")][1]');
}

test.describe('the audit viewer', () => {
  test('shows an administrator the log, and tells a rep they cannot read it', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/audit-log');

    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    // Signing in is itself audited, so there is always at least one such row.
    // Scoped to list rows: the word is also an <option> in the action filter.
    await expect(page.locator('li', { hasText: 'login' }).first()).toBeVisible(SLOW);

    await signIn(page, credentials.rep);
    await page.goto('/settings/audit-log');
    await expect(page.getByText('You do not have access to the audit log')).toBeVisible(SLOW);
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
    const id = await createContact(page, surname);

    // The contact page has no delete control yet (bulk actions are separate
    // work), so soft-delete through the same API the UI will call. From the
    // page, so the request carries the session cookie and a same-origin Origin
    // header, exactly as a click would.
    const status = await page.evaluate(
      async (contactId) =>
        (await fetch(`/api/proxy/contacts/${contactId}?version=1`, { method: 'DELETE' })).status,
      id,
    );
    expect(status).toBe(204);

    await page.goto('/settings/recycle-bin');
    await expect(page.getByRole('heading', { name: 'Recycle bin' })).toBeVisible();
    const row = page.locator('li', { hasText: surname });
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

    const card = cardWith(page, 'Export this workspace');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Create archive' }).click();

    // The worker produces it in the background; the page polls until the link
    // is offered.
    await expect(card.getByRole('button', { name: 'Download' })).toBeVisible(SLOW);

    await signIn(page, credentials.rep);
    await page.goto('/settings/data-rights');
    await cardWith(page, 'Export this workspace')
      .getByRole('button', { name: 'Create archive' })
      .click();
    // The API refused; the screen explains the refusal.
    await expect(page.getByText('Only the Owner can export the workspace')).toBeVisible(SLOW);
  });

  test('erasing a person asks twice, then redacts their audit diffs', async ({ page }) => {
    const surname = unique();
    const address = `${surname.toLowerCase()}@example.com`;

    await signIn(page, credentials.owner);
    const recordId = await createContact(page, surname, address);

    // Before: the address is in the log, because creating the contact wrote it.
    await page.goto('/settings/audit-log');
    await page.getByLabel('Object').selectOption('contact');
    await expect(page.getByText(address).first()).toBeVisible(SLOW);

    await page.goto('/settings/data-rights');
    const erase = cardWith(page, 'Erase a person');
    await erase.getByLabel('Record ID').fill(recordId);
    await erase.getByLabel('Reason (optional)').fill('E2E: data subject request');

    // Asked twice, deliberately: the first click only arms the confirmation.
    await erase.getByRole('button', { name: 'Erase this person' }).click();
    // The alert, not the card's description, which says the same thing.
    await expect(erase.getByRole('alert').filter({ hasText: 'This cannot be undone' })).toBeVisible();
    await erase.getByRole('button', { name: 'Yes, erase permanently' }).click();

    // The request shows in the workspace's compliance record and completes.
    await expect(erase.getByText('completed')).toBeVisible(SLOW);

    // After: the row is still there, with the personal value replaced.
    await page.goto('/settings/audit-log');
    await page.getByLabel('Object').selectOption('contact');
    await expect(page.getByText('[erased]').first()).toBeVisible(SLOW);
    await expect(page.getByText(address)).toHaveCount(0);
  });
});
