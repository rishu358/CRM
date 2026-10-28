import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Tags on records (MVP_SPEC M4, ADR-0063).
 *
 * The rules are enforced in the API and the database; what only a browser can show is that a person can
 * actually use them: add a tag to a record by typing, see it come back after a reload, find the record
 * again from a list by that tag, and let an administrator rename and delete the tag.
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

/** Create a contact through the same proxy the app uses; a write needs the browser's own origin. */
async function createContact(page: Page, lastName: string): Promise<string> {
  const response = await page.request.post('/api/proxy/contacts', {
    headers: { origin: new URL(page.url()).origin },
    data: { lastName },
  });
  expect(response.ok(), `creating ${lastName}`).toBe(true);
  const body = (await response.json()) as { data: { id: string } };
  return body.data.id;
}

test.describe('tags', () => {
  test('adds a tag by typing, keeps it after a reload, finds the record by it, renames and deletes it', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const stamp = Date.now().toString().slice(-6);
    const surname = `Tagged${stamp}`;
    const other = `Untagged${stamp}`;
    const tag = `Wholesale ${stamp}`;
    const renamed = `Bulk buyer ${stamp}`;

    const id = await createContact(page, surname);
    await createContact(page, other);

    // ---- on the record -------------------------------------------------------------------------
    await page.goto(`/contacts/${id}`);
    const editor = page.getByTestId('tag-editor');
    await expect(editor.getByTestId('tag-empty')).toBeVisible();

    await editor.getByTestId('tag-input').fill(tag);
    // A name nobody has yet is offered as "Create", reachable with the keyboard.
    await expect(page.getByRole('option', { name: `Create tag "${tag}"` })).toBeVisible();
    await editor.getByTestId('tag-input').press('Enter');
    await expect(editor.getByRole('list', { name: 'Tags' })).toContainText(tag);

    await page.reload();
    await expect(page.getByTestId('tag-editor').getByRole('list', { name: 'Tags' })).toContainText(
      tag,
    );

    // ---- in the list, and filtered by it -------------------------------------------------------
    await page.goto('/contacts');
    await page.getByTestId('filters-button').click();
    const filters = page.getByTestId('filter-dialog');
    await filters.getByRole('button', { name: 'Add a condition' }).click();
    await filters.getByLabel('Field', { exact: true }).selectOption({ label: 'Tags' });
    await filters.getByLabel('Condition', { exact: true }).selectOption({ label: 'has any of' });
    await filters.getByTestId('tag-value-picker').getByLabel(tag).check();
    await page.getByTestId('filters-apply').click();

    await expect(page.getByRole('link', { name: surname })).toBeVisible();
    await expect(page.getByRole('link', { name: other })).toHaveCount(0);
    await expect(page.getByRole('row', { name: new RegExp(surname) })).toContainText(tag);

    // "Has none of" is the other half of the same list.
    await page.getByTestId('filters-button').click();
    await page.getByTestId('filter-dialog').getByLabel('Condition', { exact: true }).selectOption({
      label: 'has none of',
    });
    await page.getByTestId('filters-apply').click();
    await expect(page.getByRole('link', { name: surname })).toHaveCount(0);
    await expect(page.getByRole('link', { name: other })).toBeVisible();

    // ---- in settings: rename, then delete ------------------------------------------------------
    await page.goto('/settings/tags');
    const row = page.getByRole('row', { name: new RegExp(tag) });
    await expect(row).toContainText('1 contact');
    await row.getByRole('button', { name: `Edit: ${tag}` }).click();
    const edit = page.getByTestId('tag-edit-dialog');
    await edit.getByLabel('Name').fill(renamed);
    await edit.getByLabel('Colour').selectOption({ label: 'Teal' });
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('row', { name: new RegExp(renamed) })).toBeVisible();

    await page.goto(`/contacts/${id}`);
    await expect(page.getByTestId('tag-editor').getByRole('list', { name: 'Tags' })).toContainText(
      renamed,
    );

    await page.goto('/settings/tags');
    await page
      .getByRole('row', { name: new RegExp(renamed) })
      .getByRole('button', { name: `Delete: ${renamed}` })
      .click();
    await expect(page.getByTestId('tag-delete-dialog')).toContainText('1 record');
    await page.getByTestId('tag-delete-confirm').click();
    await expect(page.getByRole('row', { name: new RegExp(renamed) })).toHaveCount(0);

    await page.goto(`/contacts/${id}`);
    await expect(page.getByTestId('tag-editor').getByTestId('tag-empty')).toBeVisible();
  });

  test('removes a tag with the cross on its chip', async ({ page }) => {
    await signIn(page, credentials.owner);
    const stamp = Date.now().toString().slice(-6);
    const id = await createContact(page, `Cross${stamp}`);
    await page.goto(`/contacts/${id}`);

    const editor = page.getByTestId('tag-editor');
    await editor.getByTestId('tag-input').fill(`temp-${stamp}`);
    await editor.getByTestId('tag-input').press('Enter');
    await expect(editor.getByRole('list', { name: 'Tags' })).toContainText(`temp-${stamp}`);

    await editor.getByRole('button', { name: `Remove the tag temp-${stamp}` }).click();
    await expect(editor.getByTestId('tag-empty')).toBeVisible();
  });

  test('a sales rep can tag their own record and is told, in words, that they cannot manage tags', async ({
    page,
  }) => {
    await signIn(page, credentials.rep);
    const stamp = Date.now().toString().slice(-6);
    const id = await createContact(page, `RepTag${stamp}`);
    await page.goto(`/contacts/${id}`);
    const editor = page.getByTestId('tag-editor');
    await editor.getByTestId('tag-input').fill(`rep-${stamp}`);
    await editor.getByTestId('tag-input').press('Enter');
    await expect(editor.getByRole('list', { name: 'Tags' })).toContainText(`rep-${stamp}`);

    await page.goto('/settings/tags');
    await expect(page.getByText('You cannot manage tags')).toBeVisible();
  });
});
