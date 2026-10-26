import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Critical flows for leads (MVP_SPEC §M4, CLAUDE.md §10): record scope on the
 * list, the duplicate prompt on create, and conversion — including the
 * acceptance criterion that converting a lead whose email matches an existing
 * contact offers "link to existing" instead of creating a duplicate.
 *
 * Deliberately end to end: the scope rule is enforced in SQL, the duplicate
 * match by pg_trgm and the permission engine, the conversion in one database
 * transaction, and all of it is only worth anything if the browser shows it.
 *
 * They share one seeded tenant and run in order, so each converts a different
 * lead from the seed (Kulkarni, Sharma) and none depends on another's changes.
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
  test('a sales rep sees only their own leads', async ({ page }) => {
    await signIn(page, credentials.rep);
    await page.goto('/leads');

    await expect(page.getByRole('link', { name: 'Qureshi' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Pillai' })).toBeVisible();
    // Owned by the other user; `own` scope must exclude them.
    await expect(page.getByRole('link', { name: 'Kulkarni' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(0);
  });

  test('an owner sees every lead in the tenant', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/leads');

    for (const name of ['Kulkarni', 'Sharma', 'Qureshi', 'Pillai']) {
      await expect(page.getByRole('link', { name })).toBeVisible();
    }
  });
});

test.describe('creating a lead', () => {
  test('saves straight away when nothing matches', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/leads');

    await page.getByRole('button', { name: 'New lead' }).click();
    const dialog = page.getByRole('dialog');
    const surname = `Fresh${Date.now().toString().slice(-6)}`;
    await dialog.getByLabel('Last name').fill(surname);
    await dialog.getByLabel('Email').fill(`${surname.toLowerCase()}@nobody-has-this.example`);
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: surname })).toBeVisible();
  });

  test('shows the duplicate prompt when the email matches an existing contact', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await page.goto('/leads');

    await page.getByRole('button', { name: 'New lead' }).click();
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

    // The prompt informs, it does not block: saving anyway creates the lead.
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.getByRole('button', { name: 'Save anyway' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: surname })).toBeVisible();
  });
});

test.describe('converting a lead', () => {
  test('creates a contact, an account and a deal, and the lead becomes read-only', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await page.goto('/leads');
    await page.getByRole('link', { name: 'Kulkarni' }).click();
    await page.waitForURL(/\/leads\/[0-9a-f-]+$/);

    await page.getByRole('button', { name: 'Convert lead' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // Nothing in this tenant matches Neha Kulkarni, so the defaults are "create".
    await expect(dialog.getByRole('radio', { name: /Create a new contact/ })).toBeChecked();
    await expect(
      dialog.getByRole('radio', { name: /Create a new account for Kulkarni Silks/ }),
    ).toBeChecked();
    await expect(dialog.getByText('You chose a new record although a match exists')).toHaveCount(0);

    await dialog.getByLabel('Also create a deal').check();
    await dialog.getByRole('button', { name: 'Convert', exact: true }).click();

    const done = dialog.getByTestId('conversion-done');
    await expect(done).toBeVisible();
    await expect(done.getByRole('link', { name: 'Contact' })).toBeVisible();
    await expect(done.getByRole('link', { name: 'Account' })).toBeVisible();
    await expect(done.getByRole('link', { name: 'Deal' })).toBeVisible();
    await expect(done).toContainText('created');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // The lead keeps the history, links to what it became, and can no longer
    // be edited or converted again.
    await expect(page.getByText('Converted', { exact: true }).first()).toBeVisible();
    const links = page.getByTestId('converted-links');
    await expect(links.getByRole('link', { name: 'Contact' })).toBeVisible();
    await expect(links.getByRole('link', { name: 'Account' })).toBeVisible();
    await expect(links.getByRole('link', { name: 'Deal' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Convert lead' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit: Last name' })).toBeDisabled();

    // And the records exist where a person would look for them.
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: 'Kulkarni' })).toBeVisible();
    await page.goto('/accounts');
    await expect(page.getByRole('link', { name: 'Kulkarni Silks' })).toBeVisible();
    await page.goto('/deals');
    await page.getByRole('button', { name: 'List' }).click();
    await expect(page.getByRole('link', { name: /Kulkarni Silks — opportunity/ })).toBeVisible();
  });

  test('offers "link to existing" instead of creating a duplicate contact', async ({ page }) => {
    // The M4 acceptance criterion. The seed's lead Anjali Sharma has the same
    // email as the seed's contact Anjali Sharma.
    await signIn(page, credentials.owner);
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(1);

    await page.goto('/leads');
    await page.getByRole('link', { name: 'Sharma' }).click();
    await page.waitForURL(/\/leads\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'Convert lead' }).click();
    const dialog = page.getByRole('dialog');

    // Offered, and pre-selected: pressing Convert without thinking attaches the
    // lead to the contact that exists rather than minting a second one.
    const link = dialog.getByRole('radio', { name: /Link to existing contact: Anjali Sharma/ });
    await expect(link).toBeVisible();
    await expect(link).toBeChecked();
    await expect(dialog.getByRole('radio', { name: /Create a new contact/ })).not.toBeChecked();
    await expect(dialog).toContainText('same email');

    // Choosing "create" anyway is a deliberate act, and says what it means.
    await dialog.getByRole('radio', { name: /Create a new contact/ }).check();
    await expect(dialog.getByText('You chose a new record although a match exists')).toBeVisible();
    await link.check();
    await expect(dialog.getByText('You chose a new record although a match exists')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Convert', exact: true }).click();

    const done = dialog.getByTestId('conversion-done');
    await expect(done).toBeVisible();
    await expect(done).toContainText('linked to an existing record');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Still exactly one Sharma contact: no duplicate was made.
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(1);
  });
});
