import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Customization, end to end (MVP_SPEC M9, ADR-0039).
 *
 * Through the browser because the claim crosses every layer: the administrator's
 * screen, the API that makes a key from a name and refuses what must never change,
 * and the record pages and dialogs that have to draw a field the moment it exists.
 *
 * Serial, and it ends by switching every field it made back off: a required custom
 * field left on would turn every later suite's "new contact" into a validation error.
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

const unique = Date.now().toString().slice(-6);
const TEXT_FIELD = `Preferred time ${unique}`;
const PICKLIST_FIELD = `Region ${unique}`;

/** The list row for a field on the administrator's screen. */
const row = (page: Page, label: string) =>
  page.getByTestId('custom-fields-list').getByRole('listitem').filter({ hasText: label });

async function openFields(page: Page): Promise<void> {
  await page.goto('/settings/fields');
  await expect(page.getByRole('heading', { name: 'Customization', level: 1 })).toBeVisible();
  await expect(page.getByTestId('custom-fields-list')).toBeVisible();
}

async function openFirstContact(page: Page): Promise<void> {
  await page.goto('/contacts');
  await page.getByRole('link', { name: 'Sharma' }).first().click();
  await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
}

test.describe.serial('an administrator customises contacts', () => {
  test('adds a text field, and it is listed', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFields(page);

    await page.getByRole('button', { name: 'Add a field' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a field' });
    await dialog.getByLabel('Name').fill(TEXT_FIELD);
    await dialog.getByLabel('Section').fill('Preferences');
    await dialog.getByLabel('Help text').fill('When they like to be called');
    await dialog.getByRole('button', { name: 'Add field' }).click();
    await expect(dialog).toBeHidden();

    const added = row(page, TEXT_FIELD);
    await expect(added).toBeVisible();
    await expect(added).toContainText('Text');
    await expect(added).toContainText('Section: Preferences');
    await expect(added).toContainText('When they like to be called');
  });

  test('adds a picklist, with options typed as names', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFields(page);

    await page.getByRole('button', { name: 'Add a field' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a field' });
    await dialog.getByLabel('Name').fill(PICKLIST_FIELD);
    await dialog.getByLabel('Type').selectOption({ label: 'Pick one from a list' });
    await dialog.getByRole('textbox', { name: 'Option 1', exact: true }).fill('North');
    await dialog.getByRole('textbox', { name: 'Option 2', exact: true }).fill('South');
    await dialog.getByRole('button', { name: 'Add an option' }).click();
    await dialog.getByRole('textbox', { name: 'Option 3', exact: true }).fill('East');
    await dialog.getByRole('button', { name: 'Add field' }).click();
    await expect(dialog).toBeHidden();

    await expect(row(page, PICKLIST_FIELD)).toContainText('3 of 3 options offered');
  });

  test('refuses a picklist with no options, and says why beside the form', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFields(page);

    await page.getByRole('button', { name: 'Add a field' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a field' });
    await dialog.getByLabel('Name').fill(`Empty list ${unique}`);
    await dialog.getByLabel('Type').selectOption({ label: 'Pick one from a list' });
    await dialog.getByRole('button', { name: 'Add field' }).click();

    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(row(page, `Empty list ${unique}`)).toHaveCount(0);
  });

  test('both appear on a contact, and an edit in place persists', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFirstContact(page);

    const card = page.getByTestId('custom-fields-card');
    await expect(card.getByRole('heading', { name: 'More details' })).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Preferences' })).toBeVisible();
    await expect(card).toContainText(TEXT_FIELD);
    await expect(card).toContainText(PICKLIST_FIELD);

    await card.getByRole('button', { name: `Edit ${PICKLIST_FIELD}` }).click();
    await card.getByLabel(PICKLIST_FIELD).selectOption({ label: 'South' });
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('South', { exact: true })).toBeVisible();

    await card.getByRole('button', { name: `Edit ${TEXT_FIELD}` }).click();
    await card.getByLabel(TEXT_FIELD).fill('Mornings');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.getByText('Mornings')).toBeVisible();

    await page.reload();
    const after = page.getByTestId('custom-fields-card');
    await expect(after.getByText('South', { exact: true })).toBeVisible();
    await expect(after.getByText('Mornings')).toBeVisible();
  });

  test('a required field stops a new contact until it is filled in', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFields(page);
    await row(page, PICKLIST_FIELD)
      .getByRole('button', { name: `Edit ${PICKLIST_FIELD}` })
      .click();
    const edit = page.getByRole('dialog', { name: `Edit ${PICKLIST_FIELD}` });
    // The type is shown and cannot be changed.
    await expect(edit.getByLabel('Type')).toBeDisabled();
    await edit.getByLabel('Required').check();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    await expect(row(page, PICKLIST_FIELD)).toContainText('Required');

    await page.goto('/contacts');
    await page.getByRole('button', { name: 'New contact' }).click();
    const dialog = page.getByRole('dialog', { name: 'New contact' });
    await dialog.getByLabel('Last name').fill(`Required ${unique}`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('This is required')).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(new RegExp(`^${PICKLIST_FIELD}`)).selectOption({ label: 'North' });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: `Required ${unique}` })).toBeVisible();
  });

  test('an option can be retired but not removed, and a record that holds it keeps it', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await openFields(page);
    await row(page, PICKLIST_FIELD)
      .getByRole('button', { name: `Edit ${PICKLIST_FIELD}` })
      .click();
    const edit = page.getByRole('dialog', { name: `Edit ${PICKLIST_FIELD}` });

    // Options that exist have no remove button; only a new one does.
    await expect(edit.getByRole('button', { name: 'Remove option 2' })).toHaveCount(0);
    await edit.getByRole('button', { name: 'Add an option' }).click();
    await expect(edit.getByRole('button', { name: 'Remove option 4' })).toBeVisible();
    await edit.getByRole('button', { name: 'Remove option 4' }).click();

    // Retire "South" (option 2, which the first contact holds).
    await edit.getByRole('checkbox', { name: 'Offered' }).nth(1).uncheck();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    await expect(row(page, PICKLIST_FIELD)).toContainText('2 of 3 options offered');

    await openFirstContact(page);
    const card = page.getByTestId('custom-fields-card');
    await expect(card.getByText('South', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: `Edit ${PICKLIST_FIELD}` }).click();
    await expect(card.getByRole('option', { name: 'South (no longer offered)' })).toBeAttached();
    await expect(card.getByRole('option', { name: 'East' })).toBeAttached();
  });

  test('orders fields, and the order shows on the record', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFields(page);
    await row(page, PICKLIST_FIELD)
      .getByRole('button', { name: `Move ${PICKLIST_FIELD} up` })
      .click();
    await expect(
      page.getByTestId('custom-fields-list').getByRole('listitem').first(),
    ).toContainText(PICKLIST_FIELD);

    await page.reload();
    await expect(
      page.getByTestId('custom-fields-list').getByRole('listitem').first(),
    ).toContainText(PICKLIST_FIELD);
  });

  test('a custom field can be a column on the contacts list', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/contacts');
    await expect(page.getByRole('columnheader', { name: PICKLIST_FIELD })).toHaveCount(0);

    await page.getByRole('button', { name: 'Fields' }).click();
    await page.getByRole('checkbox', { name: PICKLIST_FIELD }).check();
    await expect(page.getByRole('columnheader', { name: PICKLIST_FIELD })).toBeVisible();
  });

  test('switching a field off hides it, keeps the data, and switching on brings it back', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await openFields(page);

    await row(page, TEXT_FIELD)
      .getByRole('button', { name: `Switch off ${TEXT_FIELD}` })
      .click();
    const confirm = page.getByRole('dialog', { name: `Switch off ${TEXT_FIELD}?` });
    await expect(confirm).toContainText('Nothing is deleted');
    await confirm.getByRole('button', { name: 'Switch off' }).click();
    await expect(confirm).toBeHidden();
    await expect(row(page, TEXT_FIELD)).toContainText('Switched off');

    await openFirstContact(page);
    await expect(page.getByTestId('custom-fields-card')).not.toContainText(TEXT_FIELD);

    await openFields(page);
    await row(page, TEXT_FIELD)
      .getByRole('button', { name: `Switch on ${TEXT_FIELD}` })
      .click();
    await expect(row(page, TEXT_FIELD)).not.toContainText('Switched off');

    await openFirstContact(page);
    const card = page.getByTestId('custom-fields-card');
    await expect(card).toContainText(TEXT_FIELD);
    await expect(card.getByText('Mornings')).toBeVisible();
  });

  test('nothing on the screen can delete a field', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFields(page);
    await expect(page.getByRole('button', { name: /delete|remove field/i })).toHaveCount(0);
  });

  test('on a phone, nothing scrolls sideways', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await context.newPage();
    await signIn(page, credentials.owner);
    await openFields(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test('cleans up: both fields are switched off so later suites are not affected', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await openFields(page);
    for (const label of [TEXT_FIELD, PICKLIST_FIELD]) {
      await row(page, label)
        .getByRole('button', { name: `Switch off ${label}` })
        .click();
      const confirm = page.getByRole('dialog', { name: `Switch off ${label}?` });
      await confirm.getByRole('button', { name: 'Switch off' }).click();
      await expect(confirm).toBeHidden();
      await expect(row(page, label)).toContainText('Switched off');
    }
  });
});

test.describe('a rep', () => {
  test('is not offered the screen, and is refused it', async ({ page }) => {
    await signIn(page, credentials.rep);
    await expect(page.getByRole('link', { name: 'Customization' })).toHaveCount(0);

    await page.goto('/settings/fields');
    await expect(
      page.getByRole('heading', { name: 'Only administrators customize the company' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add a field' }).first()).toBeDisabled();
  });
});
