import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Activities and My Day, end to end (MVP_SPEC M6, CLAUDE.md §10).
 *
 * Deliberately through the browser: a task created on a record page has to
 * travel through the proxy, the API's permission and link checks, RLS, and
 * then come back on a *different* screen cut into the viewer's own day. Every
 * one of those layers is part of what is being asserted, and testing any of
 * them alone would prove none of it.
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

/** A due time later today, as the browser's own clock sees it. */
function laterToday(): string {
  const when = new Date();
  when.setHours(23, 30, 0, 0);
  // `datetime-local` wants wall-clock with no zone, so build it from local
  // parts rather than from an ISO string, which would be UTC.
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T23:30`;
}

test.describe('creating a task from a record page', () => {
  test('logs a task against a contact and shows it in the panel', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);

    const subject = `Ring back ${Date.now().toString().slice(-6)}`;

    await page.getByRole('button', { name: 'New activity' }).click();
    const dialog = page.getByRole('dialog', { name: 'New activity' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel('Due').fill(laterToday());
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByText(subject)).toBeVisible();

    // The real check: it survived the round trip, rather than only landing in
    // the optimistic cache.
    await page.reload();
    await expect(page.getByText(subject)).toBeVisible();
  });

  test('ticking a task off persists', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);

    const subject = `Send catalogue ${Date.now().toString().slice(-6)}`;
    await page.getByRole('button', { name: 'New activity' }).click();
    const dialog = page.getByRole('dialog', { name: 'New activity' });
    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    const checkbox = page.getByRole('checkbox', { name: `Mark ${subject} as done` });
    await checkbox.check();

    await page.reload();
    await expect(page.getByRole('checkbox', { name: `Mark ${subject} as done` })).toBeChecked();
  });
});

test.describe('My Day', () => {
  test('shows a task due today, and completing it clears the list', async ({ page }) => {
    await signIn(page, credentials.owner);

    const subject = `Call the supplier ${Date.now().toString().slice(-6)}`;

    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'New activity' }).click();
    const dialog = page.getByRole('dialog', { name: 'New activity' });
    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel('Due').fill(laterToday());
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('link', { name: 'My Day' }).click();
    await page.waitForURL('**/my-day');

    // Due at 23:30 local, so it belongs to *this* viewer's today — the whole
    // point of cutting the buckets in the viewer's time zone.
    const dueToday = page.locator('section, div').filter({ hasText: 'Due today' }).first();
    await expect(dueToday).toBeVisible();
    await expect(page.getByText(subject)).toBeVisible();

    // `click`, not `check`: a completed task leaves My Day altogether, so the
    // checkbox is gone by the time Playwright would verify it is ticked.
    // Disappearing from the list *is* the behaviour being asserted.
    await page.getByRole('checkbox', { name: `Mark ${subject} as done` }).click();
    await expect(page.getByText(subject)).toHaveCount(0);

    await page.reload();
    await expect(page.getByText(subject)).toHaveCount(0);
  });

  test('lists the records this person has just opened', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);

    await page.goto('/my-day');
    const recent = page.getByText('Recently viewed');
    await expect(recent).toBeVisible();
    // `.first()`: the same contact may also be named by a task's own link.
    await expect(page.getByRole('link', { name: 'Sharma' }).first()).toBeVisible();
  });

  test('a rep sees their own day, not a colleague’s task', async ({ page }) => {
    await signIn(page, credentials.owner);

    const subject = `Owner only ${Date.now().toString().slice(-6)}`;
    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
    await page.getByRole('button', { name: 'New activity' }).click();
    const dialog = page.getByRole('dialog', { name: 'New activity' });
    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel('Due').fill(laterToday());
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in');

    await signIn(page, credentials.rep);
    await page.goto('/my-day');
    await expect(page.getByText(subject)).toHaveCount(0);
  });
});
