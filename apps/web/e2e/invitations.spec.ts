import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Team invitations, end to end (MVP_SPEC M2).
 *
 * Through the browser, because what is being checked is produced by the whole
 * chain: the form, the credential proxy, the API, RLS, and — for a brand-new
 * account — the Next route that turns a session token into an httpOnly cookie.
 *
 * The seeded invitation's token is read from the seed's output, the same way
 * the demo passwords are. It is printed because it cannot be recovered: the
 * row holds only its SHA-256, exactly as in production.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as {
  owner: string;
  rep: string;
  mfaUser: string;
  password: string;
  invitedEmail: string;
  inviteToken: string;
};

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/contacts');
}

test.describe('inviting', () => {
  test('an owner invites somebody, sees them pending, and revokes the invitation', async ({
    page,
  }) => {
    await signIn(page, credentials.owner, credentials.password);
    await page.goto('/settings/team');

    const invitee = `playwright-${Date.now().toString(36)}@example.com`;
    await page.getByLabel('Email address').fill(invitee);
    await page.getByLabel('Role').selectOption({ label: 'Sales Rep' });
    await page.getByRole('button', { name: 'Send invitation' }).click();

    await expect(page.getByRole('status')).toContainText('Invitation sent');
    const row = page.getByRole('listitem').filter({ hasText: invitee });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Sales Rep');

    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('status')).toContainText('revoked');
    await expect(page.getByRole('listitem').filter({ hasText: invitee })).toHaveCount(0);
  });

  test('a sales rep is told they do not have access, and sees no form', async ({ page }) => {
    await signIn(page, credentials.rep, credentials.password);
    await page.goto('/settings/team');

    await expect(page.getByText('You do not have access to the team settings')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send invitation' })).toHaveCount(0);
  });
});

test.describe('accepting', () => {
  test('refuses a link with no token, and one that is not a real invitation', async ({ page }) => {
    await page.goto('/accept-invite');
    await expect(page.getByText('This link is incomplete')).toBeVisible();

    await page.goto(
      '/accept-invite?token=00000000-0000-7000-8000-000000000000.notarealsecretbutlongenoughtopassthecontract',
    );
    await expect(page.getByText('This invitation link did not work')).toBeVisible();
  });

  test('tells somebody signed in as the wrong person, without consuming the link', async ({
    page,
  }) => {
    await signIn(page, credentials.owner, credentials.password);

    await page.goto(`/accept-invite?token=${encodeURIComponent(credentials.inviteToken)}`);
    await expect(page.getByText('This invitation is for somebody else')).toBeVisible();
    await expect(page.getByText(credentials.invitedEmail)).toBeVisible();

    // Signing out from here leaves the invitation exactly as it was, which the
    // next test proves by using it.
    await page.getByRole('button', { name: 'Sign out' }).click();
  });

  test('creates the account, joins the workspace and lands in the app', async ({ page }) => {
    await page.goto(`/accept-invite?token=${encodeURIComponent(credentials.inviteToken)}`);

    await expect(page.getByRole('heading', { name: /Join Demo Jewellers/ })).toBeVisible();
    // The address is the invitation's, and cannot be edited into somebody
    // else's (ADR-0018).
    await expect(page.getByLabel('Email address')).toHaveValue(credentials.invitedEmail);
    await expect(page.getByLabel('Email address')).toHaveAttribute('readonly', '');

    await page.getByLabel('Your name').fill('Playwright Invitee');
    await page.getByLabel('Choose a password').fill('a-perfectly-fine-passphrase');
    await page.getByRole('button', { name: /Join Demo Jewellers/ }).click();

    await page.waitForURL('**/contacts');

    // A Sales Rep: `own` scope, so the seeded contacts belong to other people
    // and none of them is visible.
    await expect(page.getByRole('link', { name: 'Sharma' })).toHaveCount(0);

    // The session token never reached page script, exactly as at sign-in.
    const visible = await page.evaluate(() => globalThis.document.cookie);
    expect(visible).not.toContain('crm_session');

    // And they were invited as a rep, so the team screen refuses them.
    await page.goto('/settings/team');
    await expect(page.getByText('You do not have access to the team settings')).toBeVisible();
  });

  test('the link is single-use', async ({ page }) => {
    // Spent by the test above. Playwright runs this file serially.
    await page.goto(`/accept-invite?token=${encodeURIComponent(credentials.inviteToken)}`);
    await expect(page.getByText('This invitation link did not work')).toBeVisible();
  });
});
