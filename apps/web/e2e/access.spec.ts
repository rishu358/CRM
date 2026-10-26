import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Users, roles and the access explainer (MVP_SPEC M3, ADR-0033), end to end.
 *
 * The properties here are produced by the whole chain — browser, proxy, API,
 * `can()`, RLS — and are about what a person is *shown*: the consequence of a
 * change **before** it is saved, the reason a person can or cannot see a record,
 * and that somebody without the right has no way in. Each test that changes
 * something puts it back, because the other specs in this suite share the seeded
 * tenant and rely on the rep seeing exactly their own contacts.
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
  await page.goto('/contacts');
}

test.describe('seeing the consequence before saving', () => {
  test('previews who is affected and by how much, then saves exactly that', async ({
    page,
    browser,
  }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/access/roles');
    await page.getByRole('link', { name: 'Sales Rep', exact: true }).click();
    await page.waitForURL('**/settings/access/roles/*');

    const panel = page.getByTestId('effect-preview');
    // Nothing proposed yet: the panel says how to see a consequence, and Save is off.
    await expect(panel).toHaveAttribute('data-status', 'idle');
    await expect(page.getByTestId('role-save')).toBeDisabled();

    try {
      await page.getByLabel('Contacts: View').selectOption({ label: 'None' });

      // The consequence, in words, before anything is saved.
      await expect(panel).toHaveAttribute('data-status', 'ready');
      const sentence = panel.getByTestId('effect-sentence').first();
      await expect(sentence).toContainText(/can no longer see up to 2 contacts/);
      await expect(panel.getByTestId('effect-summary-row').first()).toHaveAttribute(
        'data-direction',
        'revoked',
      );
      // Itemised per person, so the sentence can be checked rather than believed.
      await panel.getByTestId('effect-person').first().locator('summary').click();
      await expect(panel.getByTestId('effect-person').first()).toContainText('Contacts · View');

      // Nothing has happened yet: the rep still sees their contacts.
      const repBefore = await (await browser.newContext()).newPage();
      await signIn(repBefore, credentials.rep);
      await expect(repBefore.getByRole('link', { name: 'Khan' })).toBeVisible();
      await repBefore.context().close();

      // Save is labelled with its cost, and applies it.
      await expect(page.getByTestId('role-save')).toContainText(/Save — affects \d+ people?/);
      await page.getByTestId('role-save').click();
      await expect(page.getByTestId('role-saved')).toContainText(/Saved\./);

      // The next request the rep makes is judged by the new rule.
      const rep = await (await browser.newContext()).newPage();
      await signIn(rep, credentials.rep).catch(() => undefined);
      await rep.goto('/contacts');
      await expect(rep.getByText('You do not have access to contacts')).toBeVisible();
      await rep.context().close();
    } finally {
      // Put it back through the API, whatever happened above. The proxy refuses
      // unsafe methods that do not carry the page's own Origin (CSRF), exactly as
      // it would a forged one, so this says who it is.
      const origin = new URL(page.url()).origin;
      const roles = (await (await page.request.get('/api/proxy/roles')).json()) as {
        data: { id: string; name: string }[];
      };
      const id = roles.data.find((candidate) => candidate.name === 'Sales Rep')!.id;
      const detail = (await (await page.request.get(`/api/proxy/roles/${id}`)).json()) as {
        data: { digest: string; grants: { objectType: string; action: string; scope: string }[] };
      };
      const stillNarrowed = !detail.data.grants.some(
        (grant) => grant.objectType === 'contact' && grant.action === 'read',
      );
      if (stillNarrowed) {
        const restore = await page.request.patch(`/api/proxy/roles/${id}/permissions`, {
          headers: { origin },
          data: {
            grants: [{ objectType: 'contact', action: 'read', scope: 'own' }],
            expectedDigest: detail.data.digest,
          },
        });
        // A restore that silently failed would corrupt every spec after this one.
        expect(restore.ok(), 'the Sales Rep role must be put back').toBe(true);
      }
    }
  });

  test('refuses to save a change that would leave nobody able to manage access', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/access/roles');
    await page.getByRole('link', { name: 'Owner', exact: true }).click();
    await page.waitForURL('**/settings/access/roles/*');

    // Other administrators exist in the seeded tenant only if somebody else holds
    // Owner or Admin; the seed has one owner, so removing the role-management
    // grants from Owner must be flagged and the save held back.
    await page.getByLabel('Roles: Edit').selectOption({ label: 'None' });

    const panel = page.getByTestId('effect-preview');
    await expect(panel).toHaveAttribute('data-status', 'ready');
    await expect(page.getByTestId('effect-lockout')).toBeVisible();
    await expect(page.getByTestId('role-save')).toBeDisabled();
  });
});

test.describe('who can see this, and why', () => {
  test('explains each person with the reason, and a field on request', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.getByRole('link', { name: 'Sharma' }).click();
    await page.getByTestId('who-can-see').click();

    const dialog = page.getByTestId('who-can-see-dialog');
    await expect(dialog.getByTestId('who-can-see-summary')).toContainText(
      /\d+ of \d+ people can open this/,
    );

    // The owner role reaches every contact: said as a reason, not just a tick.
    const can = dialog.getByTestId('who-can-list');
    await expect(can).toContainText('Priya Nair');
    await expect(can.getByTestId('who-can-reason').first()).toContainText(/can see every contact/);

    // A rep who is not the owner cannot, and is told why in the rep's own terms.
    const cannot = dialog.getByTestId('who-cannot-list');
    await expect(cannot).toContainText(/only sees contacts they own/);
    for (const person of await cannot.getByTestId('who-can-person').all()) {
      await expect(person).toHaveAttribute('data-allowed', 'false');
    }

    // Ask about one field: who sees the phone number.
    await dialog.getByTestId('who-can-see-field').selectOption({ label: 'Phone' });
    await expect(can.getByTestId('who-can-person').first()).toContainText('Can see it');
  });

  test('can hand the record to somebody else, and back', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.getByRole('link', { name: 'Khan' }).click();
    await page.waitForURL('**/contacts/*');
    const url = page.url();

    const moveTo = async (name: RegExp | string) => {
      await page.goto(url);
      await page.getByTestId('who-can-see').click();
      await page.getByRole('button', { name: 'Change owner…' }).click();
      const reassign = page.getByTestId('reassign-dialog');
      const option = reassign.locator('option', { hasText: name }).first();
      await reassign
        .getByLabel('New owner')
        .selectOption((await option.getAttribute('value')) ?? '');
      // The count is the real reassignment, rolled back.
      await expect(reassign.getByTestId('reassign-preview')).toContainText('1 will move');
      await page.getByTestId('reassign-confirm').click();
      await expect(page.getByTestId('reassign-done')).toContainText('1 record moved');
      await page.keyboard.press('Escape');
    };

    await moveTo('Priya Nair');
    // The rep no longer owns it, so the explanation says the owner now does.
    await page.goto(url);
    await page.getByTestId('who-can-see').click();
    await expect(page.getByTestId('who-can-see-dialog')).toContainText('Owned by Priya Nair');
    await page.keyboard.press('Escape');

    // Back to the seeded rep — by name, not by role: there is more than one Sales
    // Rep, and "the first option that says Sales Rep" is somebody else.
    await moveTo('Rahul Mehta');
    await page.goto(url);
    await page.getByTestId('who-can-see').click();
    await expect(page.getByTestId('who-can-see-dialog')).toContainText('Owned by Rahul Mehta');
  });
});

test.describe('people without the right have no way in', () => {
  test('a sales rep is not shown the screens, and the API refuses them anyway', async ({
    page,
  }) => {
    await signIn(page, credentials.rep);

    // Not in the navigation…
    await expect(page.getByRole('link', { name: 'People & access' })).toHaveCount(0);

    // …and not on a record page.
    await page.getByRole('link', { name: 'Khan' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('who-can-see')).toHaveCount(0);

    // Typing the address is no way round it: the screen explains the refusal,
    // and the API is what refused.
    await page.goto('/settings/access/people');
    await expect(page.getByText('Only administrators can manage access')).toBeVisible();
    const response = await page.request.get('/api/proxy/members');
    expect(response.status()).toBe(403);
    const explain = await page.request.get('/api/proxy/access/catalogue');
    expect(explain.status()).toBe(403);
  });

  test('an administrator sees them', async ({ page }) => {
    await signIn(page, credentials.owner);
    await expect(page.getByRole('link', { name: 'People & access' })).toBeVisible();
  });
});

test.describe('the other screens', () => {
  test('lists people with their roles, and what they can reach', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/access/people');
    await expect(page.getByTestId('person-row')).toHaveCount(3);

    await page.getByRole('link', { name: 'What can they reach?' }).first().click();
    await page.waitForURL('**/settings/access/explorer?member=*');
    const rows = page.getByTestId('reach-row');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId('reach-subject')).toContainText('in the role');
  });

  test('creates a team and puts somebody on it', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/access/teams');
    const name = `North ${Date.now().toString(36)}`;
    await page.getByTestId('new-team').click();
    const form = page.getByTestId('team-form');
    await form.getByLabel('Team name').fill(name);
    await form.getByRole('checkbox').first().check();
    await form.getByRole('button', { name: 'Save team' }).click();

    const card = page.getByTestId('team-card').filter({ hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toContainText('1 person');

    // Tidy up: a leftover team would change what the next run's managers reach.
    await card.getByRole('button', { name: `Delete the team ${name}` }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
    await expect(page.getByTestId('team-card').filter({ hasText: name })).toHaveCount(0);
  });

  test('creates a role from a copy and lands in its editor', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/settings/access/roles');
    await page.getByTestId('new-role').click();
    const form = page.getByTestId('new-role-form');
    const name = `Support ${Date.now().toString(36)}`;
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Start from').selectOption({ label: 'Read-only' });
    await form.getByRole('button', { name: 'Create role' }).click();
    await page.waitForURL('**/settings/access/roles/*');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
    // Copied from Read-only: reads everything, writes nothing.
    await expect(page.getByLabel('Contacts: View')).toHaveValue('all');
    await expect(page.getByLabel('Contacts: Edit')).toHaveValue('');
  });
});
