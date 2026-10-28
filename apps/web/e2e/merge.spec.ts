import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Merging a duplicate contact (MVP_SPEC M4, ADR-0064).
 *
 * The rules are enforced in the API and the database; what only a browser can show is that the person
 * can actually do it: see the duplicate on the record page, choose which values stay, read what will
 * move, confirm, and end up on the record that stayed, while the old link says where it went.
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
async function createContact(page: Page, data: Record<string, unknown>): Promise<string> {
  const response = await page.request.post('/api/proxy/contacts', {
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  expect(response.ok(), `creating ${String(data['lastName'])}`).toBe(true);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

/**
 * Put records back in the Recycle Bin, as the owner, once a test is done with them.
 *
 * A rep cannot delete, and the records a rep creates belong to that rep alone: left in the shared
 * database they would be counted by the specs that run after this one (the bulk spec counts what the
 * rep may change). So a test that makes records as the rep removes them as the owner.
 */
async function removeAsOwner(browser: Browser, baseURL: string, ids: readonly string[]) {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await signIn(page, credentials.owner);
    const origin = new URL(page.url()).origin;
    for (const id of ids) {
      const record = await page.request.get(`/api/proxy/contacts/${id}`);
      const version = ((await record.json()) as { data: { version: number } }).data.version;
      const response = await page.request.delete(`/api/proxy/contacts/${id}?version=${version}`, {
        headers: { origin },
      });
      expect(response.ok(), `removing ${id}`).toBe(true);
    }
  } finally {
    await context.close();
  }
}

test.describe('merge', () => {
  test('finds the duplicate on the record, chooses values, reads what moves, merges, and the old link points on', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const stamp = Date.now().toString().slice(-6);
    const email = `dup-${stamp}@merge-e2e.example`;

    const keep = await createContact(page, {
      firstName: 'Asha',
      lastName: `Duplicate${stamp}`,
      email,
    });
    const away = await createContact(page, {
      firstName: 'Ashaa',
      lastName: `Duplicate${stamp}`,
      email,
      phone: '+919876543210',
    });
    // Something that belongs to the one that will be merged away: it has to arrive on the other.
    const note = await page.request.post('/api/proxy/activities', {
      headers: { origin: new URL(page.url()).origin },
      data: {
        type: 'note',
        subject: `Note on the duplicate ${stamp}`,
        links: [{ objectType: 'contact', recordId: away }],
      },
    });
    expect(note.ok()).toBe(true);

    // ---- the record page offers the duplicate --------------------------------------------------------
    await page.goto(`/contacts/${keep}`);
    const card = page.getByTestId('duplicates-card');
    await expect(card.getByRole('link', { name: new RegExp(`Duplicate${stamp}`) })).toBeVisible();
    await card.getByRole('button', { name: /^Merge with Ashaa/ }).click();

    // ---- choose values: the phone only the other has is selected for us; the first name we keep -------
    const dialog = page.getByTestId('merge-dialog');
    await expect(dialog.getByTestId('merge-fields')).toBeVisible();
    await expect(dialog.getByTestId('merge-phone-loser')).toBeChecked();
    await expect(dialog.getByTestId('merge-firstName-master')).toBeChecked();
    await dialog.getByTestId('merge-review').click();

    // ---- review: what will move, in words ------------------------------------------------------------
    const preview = dialog.getByTestId('merge-preview');
    await expect(preview).toContainText('1 note');
    await expect(preview).toContainText('Recycle Bin');
    await dialog.getByTestId('merge-confirm').click();
    await expect(dialog.getByTestId('merge-done')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).last().click();

    // ---- the kept record has the chosen value and the moved note -------------------------------------
    await page.goto(`/contacts/${keep}`);
    await expect(page.getByText('+919876543210')).toBeVisible();
    await expect(page.getByText(`Note on the duplicate ${stamp}`)).toBeVisible();

    // ---- the old link says where it went, never a bare "not found" ------------------------------------
    await page.goto(`/contacts/${away}`);
    await expect(page.getByText('This record was merged into another')).toBeVisible();
    await page.getByRole('link', { name: 'Open the merged record' }).click();
    await page.waitForURL(`**/contacts/${keep}`);
  });

  test('picks any other record to merge with, and goes back without merging', async ({ page }) => {
    await signIn(page, credentials.owner);
    const stamp = Date.now().toString().slice(-6);
    const one = await createContact(page, { lastName: `Chooser${stamp}A` });

    await page.goto(`/contacts/${one}`);
    await page.getByTestId('merge-with').click();
    const dialog = page.getByTestId('merge-dialog');
    // A seeded contact, which the search index already holds: the index of a record made a moment ago
    // is filled by the worker a little later, the same as for the search box, and a test should not
    // depend on how fast that is.
    await dialog.getByTestId('merge-search').fill('Reddy');
    await expect(dialog.getByRole('button', { name: 'Choose' }).first()).toBeVisible({
      timeout: 20_000,
    });
    await dialog.getByRole('button', { name: 'Choose' }).first().click();
    await expect(dialog.getByTestId('merge-fields')).toBeVisible();
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(dialog.getByTestId('merge-search')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // Nothing was merged.
    await page.goto(`/contacts/${one}`);
    await expect(page.getByRole('heading', { name: new RegExp(`Chooser${stamp}A`) })).toBeVisible();
  });

  test('a rep who may not delete is told so in words and nothing is merged', async ({
    page,
    browser,
    baseURL,
  }) => {
    await signIn(page, credentials.rep);
    const stamp = Date.now().toString().slice(-6);
    const email = `rep-dup-${stamp}@merge-e2e.example`;
    const keep = await createContact(page, { lastName: `RepDup${stamp}`, email });
    const other = await createContact(page, { lastName: `RepDup${stamp}`, email });

    await page.goto(`/contacts/${keep}`);
    const card = page.getByTestId('duplicates-card');
    await card.getByRole('button', { name: /^Merge with RepDup/ }).click();
    const dialog = page.getByTestId('merge-dialog');
    await dialog.getByTestId('merge-review').click();
    await expect(dialog.getByRole('alert')).toContainText('may not merge them');

    await removeAsOwner(browser, baseURL ?? 'http://localhost:3000', [keep, other]);
  });
});
