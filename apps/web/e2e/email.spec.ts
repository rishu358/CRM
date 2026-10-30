import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Email sent from a record (ADR-0073).
 *
 * The rules are enforced in the API and the database; what only a browser can show is that a person can
 * use them: open a contact, write to it, watch the email go from Queued to Sent, read it back, and have
 * a colleague who can see the contact find the same email there. The worker really sends it (to the
 * console provider in this stack), so "Sent" here means the whole path ran.
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

/** Create a contact through the same proxy the app uses, as whoever is signed in. */
async function createContact(
  page: Page,
  data: { lastName: string; email?: string },
): Promise<{ id: string; version: number }> {
  const response = await page.request.post('/api/proxy/contacts', {
    headers: { origin: new URL(page.url()).origin },
    data,
  });
  expect(response.ok(), `creating ${data.lastName}`).toBe(true);
  const body = (await response.json()) as { data: { id: string; version: number } };
  return body.data;
}

/**
 * Remove a contact again, as somebody who may (the owner). Other specs count what the sales rep owns
 * ("the two they own"), so a contact left behind in the rep's name would change their answer.
 */
async function deleteContact(page: Page, contact: { id: string; version: number }): Promise<void> {
  const response = await page.request.delete(
    `/api/proxy/contacts/${contact.id}?version=${String(contact.version)}`,
    { headers: { origin: new URL(page.url()).origin } },
  );
  expect(response.ok(), 'removing the contact the spec made').toBe(true);
}

test.describe('email', () => {
  test('a rep writes to a contact, watches it go out, and a colleague sees it on the contact', async ({
    page,
  }) => {
    await signIn(page, credentials.rep);
    const stamp = Date.now().toString().slice(-6);
    const address = `e2e-${stamp}@customer.example`;
    const subject = `Your quote ${stamp}`;
    const contact = await createContact(page, { lastName: `Mailed${stamp}`, email: address });
    const id = contact.id;

    await page.goto(`/contacts/${id}`);
    const panel = page.getByTestId('email-panel');
    await expect(panel.getByText('No emails yet')).toBeVisible();

    await panel.getByRole('button', { name: 'Send the first email' }).click();
    const dialog = page.getByTestId('send-email-dialog');
    // The address is the record's, shown and never typed.
    await expect(dialog.getByTestId('send-email-to')).toContainText(address);
    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel('Message').fill('Hello,\n\nThe quote is ready.');
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog).toBeHidden();

    // It appears at once, and the worker moves it on.
    const row = panel.getByTestId('email-row').filter({ hasText: subject });
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'sent', { timeout: 60_000 });
    await expect(row.getByText('Sent', { exact: true })).toBeVisible();

    await row.getByRole('button', { name: 'Show message' }).click();
    await expect(row).toContainText('The quote is ready.');

    // The whole team sees it: the owner, who can see every contact, finds the same email.
    await page.context().clearCookies();
    await signIn(page, credentials.owner);
    await page.goto(`/contacts/${id}`);
    const seen = page
      .getByTestId('email-panel')
      .getByTestId('email-row')
      .filter({ hasText: subject });
    await expect(seen).toBeVisible();
    await expect(seen).toContainText(address);

    // The contact was the rep's, so it is removed by the owner before the next spec counts the rep's own.
    await deleteContact(page, contact);
  });

  test('says there is nothing to send to when a contact has no address', async ({ page }) => {
    await signIn(page, credentials.owner);
    const { id } = await createContact(page, {
      lastName: `Nomail${Date.now().toString().slice(-6)}`,
    });

    await page.goto(`/contacts/${id}`);
    await page.getByTestId('email-send').click();
    const dialog = page.getByTestId('send-email-dialog');
    await expect(dialog.getByText('No email address to send to')).toBeVisible();
    await expect(dialog.getByLabel('Subject')).toHaveCount(0);
  });

  test('an administrator sets the sender name, and the next email is written as that name', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const stamp = Date.now().toString().slice(-6);
    const name = `Sharma Traders ${stamp}`;

    await page.goto('/settings/email');
    await expect(page.getByTestId('email-sending-address')).toBeVisible();
    await page.getByLabel('Sender name').fill(name);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('email-settings-saved')).toBeVisible();

    const { id } = await createContact(page, {
      lastName: `Named${stamp}`,
      email: `named-${stamp}@customer.example`,
    });
    await page.goto(`/contacts/${id}`);
    await page.getByTestId('email-send').click();
    await expect(page.getByTestId('send-email-dialog')).toContainText(`Sent as ${name}`);
  });

  test('keeps the sender settings to an administrator', async ({ page }) => {
    await signIn(page, credentials.rep);
    await page.goto('/settings/email');
    await expect(page.getByText('You do not have access to email settings')).toBeVisible();
    await expect(page.getByLabel('Sender name')).toHaveCount(0);
  });
});
