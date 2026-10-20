import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Record attachments, end to end (MVP_SPEC §6.1, CLAUDE.md §5.12 §10, ADR-0035).
 *
 * Through the browser because the property being checked crosses every layer
 * at once: the file goes from the page **straight to object storage** on a
 * presigned URL, the worker reads its first bytes and decides what it is, and
 * only then does it appear on the record. Break any link — the signature, the
 * CORS rule, the worker, the permission check — and a flow here fails.
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

async function openFirstContact(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Sharma' }).first().click();
  await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
}

const tag = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Upload takes a round trip through the store and then the worker's byte check. */
const SLOW = { timeout: 60_000 };

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n');

function attach(page: Page, name: string, buffer: Buffer, mimeType: string) {
  return page.getByLabel('Add file', { exact: true }).setInputFiles({ name, mimeType, buffer });
}

test.describe('attachments on a record page', () => {
  test('uploads a file, lists it once it has passed the byte check, and downloads it', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await openFirstContact(page);

    const name = `proposal-${tag()}.pdf`;
    await attach(page, name, PDF, 'application/pdf');

    // Not listed until the worker has looked at the bytes, so this waits for it.
    await expect(page.getByText(name)).toBeVisible(SLOW);

    // It survived the round trip rather than only landing in the cache.
    await page.reload();
    await expect(page.getByText(name)).toBeVisible();

    // A download is a short-lived link to the store, saved rather than rendered.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).first().click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(name);
  });

  test('removes a file', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFirstContact(page);

    const name = `old-quote-${tag()}.pdf`;
    await attach(page, name, PDF, 'application/pdf');
    await expect(page.getByText(name)).toBeVisible(SLOW);

    await page.getByRole('button', { name: `Remove ${name}` }).click();
    await expect(page.getByText(name)).toBeHidden();

    await page.reload();
    await expect(page.getByText(name)).toBeHidden();
  });

  test('refuses a type that is not on the allow-list, before anything is uploaded', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await openFirstContact(page);

    const name = `logo-${tag()}.svg`;
    // The file input's own `accept` does not stop a determined chooser; the
    // page checks again, and the API checks again after that.
    await attach(
      page,
      name,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/svg+xml',
    );

    await expect(page.getByRole('alert')).toContainText('cannot be attached');
    await expect(page.getByText(name)).toBeHidden();
  });

  test('refuses a file whose contents are not what its name says', async ({ page }) => {
    await signIn(page, credentials.owner);
    await openFirstContact(page);

    // Passes the browser and the API (a `.png` name, a declared size) and is
    // caught by the worker, which reads the bytes: this is plain text.
    const name = `photo-${tag()}.png`;
    await attach(page, name, Buffer.from('this is not an image at all'), 'image/png');

    // It never becomes a listed file, however long we wait for the worker.
    await page.waitForTimeout(5_000);
    await expect(page.getByText(name)).toBeHidden();
  });
});
