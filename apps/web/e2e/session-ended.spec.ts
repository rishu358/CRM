import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * A person whose session the server no longer honours ends on the sign-in screen (ADR-0055).
 *
 * Before this, the app frame was drawn for anybody and every card on the dashboard said "Could not
 * load this". The cases here are the two ways to get there: arriving with a cookie the server does
 * not know (a full page load), and having a session revoked while the app is open.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

const SESSION_COOKIE = 'crm_session';

/** The notice, scoped to our own `role="status"` element: Next also mounts a route announcer. */
const endedNotice = (page: Page) =>
  page
    .getByRole('status')
    .filter({ hasText: 'Your session has ended. Sign in again to continue.' });

async function holdUnknownCookie(page: Page, baseURL: string | undefined): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      // Well-formed (long enough to be tried against the database) and not any session's token.
      value: 'stale'.repeat(10),
      url: baseURL ?? 'http://localhost:3000',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

async function fillSignIn(page: Page, email: string): Promise<void> {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('arriving with a login the server does not know', () => {
  test('a stale cookie on a full page load ends on sign-in, and the cookie is cleared', async ({
    page,
    baseURL,
  }) => {
    await holdUnknownCookie(page, baseURL);
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/sign-in\?reason=session-ended&returnTo=%2Fdashboard$/);
    await expect(endedNotice(page)).toBeVisible();
    // The screen the owner saw: the frame with every card failing. It must not appear at all.
    await expect(page.getByText('Could not load this')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);

    // httpOnly, so only the server could have removed it.
    const left = (await page.context().cookies()).filter((c) => c.name === SESSION_COOKIE);
    expect(left).toHaveLength(0);
  });

  test('a visitor with no cookie ends on sign-in too, without being told a session ended', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/contacts');

    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fcontacts$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(endedNotice(page)).toHaveCount(0);
  });

  test('the front door sends a visitor with no cookie to sign in, not to a broken dashboard', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/');

    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test('after signing in the person lands where they were going', async ({ page, baseURL }) => {
    await holdUnknownCookie(page, baseURL);
    await page.goto('/my-day');
    await expect(page).toHaveURL(/\/sign-in\?reason=session-ended&returnTo=%2Fmy-day$/);

    await fillSignIn(page, credentials.rep);
    await page.waitForURL('**/my-day');
  });

  test('a return address that leaves this site is ignored', async ({ page, baseURL }) => {
    await page.context().clearCookies();
    // Spelt the way a phishing link would: protocol-relative, so a naive check on "starts with /"
    // would pass it.
    await page.goto('/sign-in?returnTo=%2F%2Fevil.example%2Fphish');
    await fillSignIn(page, credentials.rep);

    await page.waitForURL('**/dashboard');
    expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? page.url()).origin);
  });

  test('a wrong password is still a message on the form, not a trip to sign-in', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/sign-in');
    await page.getByLabel('Email address').fill(credentials.rep);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('alert').filter({ hasText: /\S/ }).first()).toHaveText(
      'Incorrect email address or password',
    );
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(endedNotice(page)).toHaveCount(0);
  });
});

test.describe('signing out on purpose', () => {
  test('does not announce that a session ended', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/sign-in');
    await fillSignIn(page, credentials.rep);
    await page.waitForURL('**/dashboard');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    // Exactly `/sign-in`: the cards still on screen are refused as the session ends, and that
    // must not turn the person's own choice into "your session has ended".
    await page.waitForURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(endedNotice(page)).toHaveCount(0);
  });
});

test.describe('a session revoked while the app is open', () => {
  test('ends on sign-in with the reason, instead of cards that cannot load', async ({
    page,
    browser,
  }) => {
    await page.context().clearCookies();
    await page.goto('/sign-in');
    await fillSignIn(page, credentials.rep);
    await page.waitForURL('**/dashboard');
    await page.goto('/my-day');
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    // The same person on another device signs every other device out: the real product path that
    // revokes a session on the server while this browser still holds its cookie.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto('/sign-in');
    await fillSignIn(otherPage, credentials.rep);
    await otherPage.waitForURL('**/dashboard');
    await otherPage.goto('/settings/security');
    await otherPage.getByRole('button', { name: 'Sign out other devices' }).click();
    await expect(otherPage.getByRole('status')).toContainText('Signed out of');
    await other.close();

    // Back on the first device, the next thing it asks the server is refused, and the person is
    // taken to sign in and told why.
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Deals' })
      .click();

    await expect(page).toHaveURL(/\/sign-in\?reason=session-ended&returnTo=%2Fdeals$/);
    await expect(endedNotice(page)).toBeVisible();
    await expect(page.getByText('Could not load this')).toHaveCount(0);
    expect((await page.context().cookies()).filter((c) => c.name === SESSION_COOKIE)).toHaveLength(
      0,
    );
  });
});
