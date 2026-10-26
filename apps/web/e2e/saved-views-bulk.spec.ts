import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Saved views and bulk actions on the contacts list (MVP_SPEC M4, ADR-0056).
 *
 * The rules being checked are enforced in the API and the database; what only a browser can show
 * is that the person can actually get there: filter, save, come back to it, tick rows with the
 * keyboard, change many records and be told what happened.
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
  await page.goto('/contacts');
}

/** Create a contact through the same proxy the app uses; a write needs the browser's own origin. */
async function createContact(page: Page, lastName: string): Promise<void> {
  const response = await page.request.post('/api/proxy/contacts', {
    headers: { origin: new URL(page.url()).origin },
    data: { lastName },
  });
  expect(response.ok(), `creating ${lastName}`).toBe(true);
}

test.describe('saved views', () => {
  test('filters a list, saves the view, and comes back to it after a reload', async ({ page }) => {
    await signIn(page, credentials.owner);
    await expect(page.getByRole('link', { name: 'Reddy' })).toBeVisible();

    await page.getByTestId('filters-button').click();
    const filters = page.getByTestId('filter-dialog');
    await filters.getByRole('button', { name: 'Add a condition' }).click();
    await filters.getByLabel('Field', { exact: true }).selectOption({ label: 'Last name' });
    await filters.getByLabel('Condition', { exact: true }).selectOption({ label: 'starts with' });
    await filters.getByLabel('Value', { exact: true }).fill('S');
    await page.getByTestId('filters-apply').click();

    await expect(page.getByRole('link', { name: 'Sharma' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reddy' })).toHaveCount(0);

    const name = `Surnames S ${Date.now().toString().slice(-6)}`;
    await page.getByTestId('save-view').click();
    const save = page.getByTestId('save-view-dialog');
    await save.getByLabel('Name').fill(name);
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(save).toBeHidden();
    await expect(page.getByTestId('view-picker')).toContainText(name);

    // A new visit starts from "All records"; choosing the view brings the filter back.
    await page.reload();
    await expect(page.getByRole('link', { name: 'Reddy' })).toBeVisible();
    await page.getByTestId('view-picker').selectOption({ label: name });
    await expect(page.getByRole('link', { name: 'Reddy' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sharma' })).toBeVisible();

    // Delete it again, so the next run starts clean.
    await page.getByRole('button', { name: 'Manage view' }).click();
    await page.getByRole('button', { name: 'Delete view' }).click();
    await page.getByTestId('delete-view-confirm').click();
    await expect(page.getByTestId('view-picker')).not.toContainText(name);
    await expect(page.getByRole('link', { name: 'Reddy' })).toBeVisible();
  });
});

test.describe('bulk actions', () => {
  test('tags several contacts at once, then deletes them, and says what it did', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const stamp = Date.now().toString().slice(-6);
    const prefix = `Bulky${stamp}`;
    for (const suffix of ['A', 'B', 'C']) await createContact(page, `${prefix}${suffix}`);

    // Choose them by a filter on the last name, which is answered by the database at once; the
    // search box waits for the search index, which the worker fills a moment after a save.
    await page.reload();
    await page.getByTestId('filters-button').click();
    const filters = page.getByTestId('filter-dialog');
    await filters.getByRole('button', { name: 'Add a condition' }).click();
    await filters.getByLabel('Field', { exact: true }).selectOption({ label: 'Last name' });
    await filters.getByLabel('Condition', { exact: true }).selectOption({ label: 'starts with' });
    await filters.getByLabel('Value', { exact: true }).fill(prefix);
    await page.getByTestId('filters-apply').click();
    await expect(page.getByRole('link', { name: `${prefix}A` })).toBeVisible();
    await expect(page.getByRole('link', { name: `${prefix}C` })).toBeVisible();

    // Nothing is offered until something is ticked.
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Select all records on screen' }).check();
    await expect(page.getByTestId('bulk-count')).toHaveText('3 records selected');

    await page.getByTestId('bulk-bar').getByRole('button', { name: 'Tag' }).click();
    const dialog = page.getByTestId('bulk-dialog');
    await dialog.getByLabel('Tags').fill(`e2e-${stamp}`);
    await page.getByTestId('bulk-confirm').click();
    await expect(page.getByTestId('bulk-result')).toContainText('3 records changed');
    await page.getByTestId('bulk-close').click();
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);

    const tags = await page.request.get('/api/proxy/tags');
    expect(JSON.stringify(await tags.json())).toContain(`e2e-${stamp}`);

    // Delete them: the Recycle Bin keeps them, the list does not show them.
    await page.getByRole('checkbox', { name: 'Select all records on screen' }).check();
    await page.getByTestId('bulk-bar').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('dialog')).toContainText('Recycle Bin');
    await page.getByTestId('bulk-confirm').click();
    await expect(page.getByTestId('bulk-result')).toContainText('3 records changed');
    await page.getByTestId('bulk-close').click();
    await expect(page.getByRole('link', { name: `${prefix}A` })).toHaveCount(0);
  });

  test('a row can be ticked from the keyboard', async ({ page }) => {
    await signIn(page, credentials.owner);
    const box = page.getByRole('checkbox', { name: /^Select .*Reddy$/ });
    await box.focus();
    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await expect(page.getByTestId('bulk-count')).toHaveText('1 record selected');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  });

  test('a sales rep can only change their own contacts, and is told how many', async ({ page }) => {
    await signIn(page, credentials.rep);
    await expect(page.getByRole('link', { name: 'Khan' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(0);

    await page.getByRole('checkbox', { name: 'Select all records on screen' }).check();
    await page.getByTestId('bulk-bar').getByRole('button', { name: 'Tag' }).click();
    await page.getByTestId('bulk-dialog').getByLabel('Tags').fill('rep-e2e');
    await page.getByTestId('bulk-confirm').click();
    // Exactly the contacts the rep can see: the two they own.
    await expect(page.getByTestId('bulk-result')).toContainText('2 records changed');
    await page.getByTestId('bulk-close').click();
  });
});
