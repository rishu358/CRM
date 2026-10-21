import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The authentication screens, end to end (MVP_SPEC M1).
 *
 * These go through the browser because what is being checked is produced by
 * the whole chain: the form, the Next route that turns a token into an
 * httpOnly cookie, the API, and the session layer underneath. Asserting on
 * any one of them alone would prove none of it.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; mfaUser: string; password: string };

/**
 * `getByRole('alert')` alone is ambiguous: Next renders a permanently mounted
 * route announcer with `role="alert"`, so every page has one. Scoping to the
 * form error we actually rendered keeps the assertion about our UI.
 */
const formAlert = (page: Page) => page.getByRole('alert').filter({ hasText: /\S/ }).first();

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('sign-in', () => {
  test('signs in with email and password and lands in the app', async ({ page }) => {
    await signIn(page, credentials.owner, credentials.password);
    await page.waitForURL('**/contacts');
    await expect(page.getByRole('link', { name: 'Sharma' })).toBeVisible();
  });

  test('the session token is never readable by page script', async ({ page }) => {
    await signIn(page, credentials.owner, credentials.password);
    await page.waitForURL('**/contacts');

    // httpOnly means document.cookie cannot see it, which is what stops an
    // XSS flaw from walking off with the session (CLAUDE.md §5.9).
    const visible = await page.evaluate(() => globalThis.document.cookie);
    expect(visible).not.toContain('crm_session');

    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: { ...globalThis.localStorage },
        session: { ...globalThis.sessionStorage },
      }),
    );
    expect(stored).not.toContain('crm_session');
  });
});

test.describe('sign-up', () => {
  test('acknowledges without saying whether the address is already taken', async ({ page }) => {
    await page.goto('/sign-up');
    await page.getByLabel('Your name').fill('Playwright Person');
    // An address that definitely has an account already.
    await page.getByLabel('Email address').fill(credentials.owner);
    await page.getByLabel('Password').fill('a-perfectly-fine-passphrase');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText('Check your email')).toBeVisible();
  });

  test('refuses a weak password before anything is sent', async ({ page }) => {
    await page.goto('/sign-up');
    await page.getByLabel('Your name').fill('Playwright Person');
    await page.getByLabel('Email address').fill(`new-${Date.now().toString()}@example.com`);
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Caught by the same policy the API applies, shared through
    // @crm/core/auth, so the form and the server cannot disagree.
    await expect(formAlert(page)).toContainText('Use at least 12 characters');
    await expect(page.getByText('Check your email')).toHaveCount(0);
  });
});

test.describe('password reset', () => {
  test('answers identically for a known and an unknown address', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email address').fill(credentials.owner);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    // Wait for the confirmation before reading anything. Reading the heading
    // straight after the click raced the request: whichever submission had not
    // come back yet showed the form's own heading, and the test reported "the two
    // answers differ" when it had only looked too early.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const known = await page.getByRole('heading').last().textContent();

    await page.goto('/forgot-password');
    await page.getByLabel('Email address').fill('nobody-here@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();
    // The same page for an address that does not exist. If it were not, this wait
    // is what would fail — which is the enumeration leak the test is here to catch.
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    const unknown = await page.getByRole('heading').last().textContent();

    expect(known).toBe(unknown);
  });

  test('rejects a reset link with no token', async ({ page }) => {
    await page.goto('/reset-password');
    await expect(page.getByText('This link is incomplete. Request a new one.')).toBeVisible();
  });
});

test.describe('security settings', () => {
  test('lists this device and offers to sign the others out', async ({ page, context }) => {
    await signIn(page, credentials.rep, credentials.password);
    await page.waitForURL('**/contacts');

    // A second device for the same person, so there is something to revoke.
    const other = await context.browser()!.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage, credentials.rep, credentials.password);
    await otherPage.waitForURL('**/contacts');

    await page.goto('/settings/security');
    await expect(page.getByText('This device')).toBeVisible();

    await page.getByRole('button', { name: 'Sign out other devices' }).click();
    await expect(page.getByRole('status')).toContainText('Signed out of');

    // The other browser really is signed out, not just missing from a list.
    await otherPage.goto('/contacts');
    await expect(otherPage.getByRole('link', { name: 'Khan' })).toHaveCount(0);
    await other.close();

    // And this one still works.
    await page.goto('/contacts');
    await expect(page.getByRole('link', { name: 'Khan' })).toBeVisible();
  });

  /**
   * Uses its own seeded account, never the one the other tests sign in as.
   *
   * Enrolling a second factor changes how that account signs in. If this test
   * fails after enrolling and before turning it back off, every later sign-in
   * as that user meets an unexpected challenge — one broken test becomes a
   * broken suite.
   */
  test('sets up two-factor authentication and then requires it at sign-in', async ({ page }) => {
    await signIn(page, credentials.mfaUser, credentials.password);
    await page.waitForURL('**/contacts');
    await page.goto('/settings/security');

    await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
    await expect(page.getByText('Save your backup codes')).toBeVisible();

    const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
    expect(secret.length).toBeGreaterThan(0);

    // Generate a live code with the same implementation the API verifies with.
    const { createOTP } = await import('@better-auth/utils/otp');
    await page
      .getByLabel('Authentication code')
      .fill(await createOTP(secret, { digits: 6, period: 30 }).totp());
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByRole('button', { name: 'Turn off' })).toBeVisible();

    // Sign out and back in: the password alone is no longer enough.
    // `exact`, because "Sign out other devices" is also on this screen.
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.waitForURL('**/sign-in');

    await signIn(page, credentials.mfaUser, credentials.password);
    await expect(
      page.getByText('Enter the six-digit code from your authenticator app.'),
    ).toBeVisible();

    await page
      .getByLabel('Authentication code')
      .fill(await createOTP(secret, { digits: 6, period: 30 }).totp());
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForURL('**/contacts');

    // Put it back, so this test leaves the seeded tenant as it found it.
    await page.goto('/settings/security');
    await page.getByRole('button', { name: 'Turn off' }).click();
    await page.getByLabel('Enter your password to confirm').fill(credentials.password);
    await page.getByRole('button', { name: 'Turn off' }).click();
    await expect(
      page.getByRole('button', { name: 'Set up two-factor authentication' }),
    ).toBeVisible();
  });
});
