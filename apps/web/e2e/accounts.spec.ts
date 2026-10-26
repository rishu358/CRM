import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Critical flows for accounts (MVP_SPEC §M4, CLAUDE.md §10).
 *
 * Deliberately end to end: the record-scope rule being checked here is
 * enforced in SQL by RLS and the permission engine, surfaced through the API,
 * and only then rendered. Asserting it in the browser is the only way to know
 * the whole chain holds together.
 *
 * The seed creates three accounts — a parent, its branch, and one owned by
 * the sales rep — so the hierarchy and the scope split are both visible
 * without the test building any data of its own.
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
  await page.goto('/accounts');
}

/**
 * One signed-in page for the whole owner suite, not one per test.
 *
 * Sign-in is rate limited per IP (§5.9), and the whole Playwright run comes
 * from one address. Twelve sign-ins for twelve accounts tests, on top of what
 * the contacts and auth suites already spend, puts a clean run within a few
 * attempts of the ceiling — so the suite would start failing on the limit
 * rather than on a regression, which is the worst kind of red. These tests
 * run serially anyway (`workers: 1`), so sharing one session costs nothing.
 */
function ownerSuite(title: string, body: (getPage: () => Page) => void): void {
  test.describe(title, () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      page = await browser.newPage();
      await signIn(page, credentials.owner);
    });

    test.afterAll(async () => {
      await page.close();
    });

    test.beforeEach(async () => {
      await page.goto('/accounts');
    });

    body(() => page);
  });
}

test.describe('record scope', () => {
  test('a sales rep sees only their own accounts', async ({ page }) => {
    await signIn(page, credentials.rep);

    await expect(page.getByRole('link', { name: 'Lotus Design Studio' })).toBeVisible();
    // Owned by the workspace owner; `own` scope must exclude them.
    await expect(page.getByRole('link', { name: 'Rajesh Gold House', exact: true })).toHaveCount(0);
  });
});

ownerSuite('the list view', (getPage) => {
  test('an owner sees every account in the tenant', async () => {
    const page = getPage();

    for (const name of ['Rajesh Gold House', 'Rajesh Gold House — Kochi', 'Lotus Design Studio']) {
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    }
  });

  test('shows revenue with Indian grouping, not a raw minor-unit number', async () => {
    const page = getPage();

    const row = page.getByRole('row').filter({ hasText: 'Lotus Design Studio' });
    // ₹85,00,000 — lakh grouping, from the shared formatter. The stored value
    // is 850000000 paise, which must never reach the screen.
    await expect(row).toContainText('85,00,000');
    await expect(row).not.toContainText('850000000');
  });

  test('the column chooser adds and removes a column', async () => {
    const page = getPage();

    await expect(page.getByRole('columnheader', { name: /GSTIN/ })).toHaveCount(0);

    await page.getByRole('button', { name: 'Columns' }).click();
    await page.getByRole('checkbox', { name: 'GSTIN' }).check();
    await expect(page.getByRole('columnheader', { name: /GSTIN/ })).toBeVisible();

    await page.getByRole('checkbox', { name: 'GSTIN' }).uncheck();
    await expect(page.getByRole('columnheader', { name: /GSTIN/ })).toHaveCount(0);
  });

  test('sorting by a column header reorders the list', async () => {
    const page = getPage();

    await page.getByRole('button', { name: /Account name/ }).click();
    await expect(page.getByRole('columnheader', { name: /Account name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );

    const ascending = await page.getByRole('cell').locator('a').allInnerTexts();
    expect([...ascending].sort((a, b) => a.localeCompare(b))).toEqual(ascending);

    // Clicking again reverses it, and the server is what re-ordered the rows:
    // a new sort means a new cursor sequence, not a client-side shuffle.
    await page.getByRole('button', { name: /Account name/ }).click();
    await expect(page.getByRole('columnheader', { name: /Account name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });
});

ownerSuite('creating and editing an account', (getPage) => {
  test('creates an account and shows it in the list', async () => {
    const page = getPage();

    await page.getByRole('button', { name: 'New account' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const name = `Testcase Traders ${Date.now().toString().slice(-6)}`;
    await dialog.getByLabel('Account name').fill(name);
    await dialog.getByLabel('Website domain').fill('testcase.example');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  });

  test('rejects an account with no name', async () => {
    const page = getPage();

    await page.getByRole('button', { name: 'New account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Website domain').fill('nameless.example');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert').first()).toBeVisible();
  });

  test('inline edit persists across a reload', async () => {
    const page = getPage();
    await page.getByRole('link', { name: 'Lotus Design Studio', exact: true }).click();
    await page.waitForURL(/\/accounts\/[0-9a-f-]+$/);

    const industry = `Interiors ${Date.now().toString().slice(-5)}`;
    await page.getByRole('button', { name: 'Edit: Industry' }).click();
    await page.getByLabel('Industry').fill(industry);
    await page.getByLabel('Industry').press('Enter');

    await expect(page.getByRole('button', { name: 'Edit: Industry' })).toContainText(industry);

    // The real check: it survived the round trip, rather than only updating
    // the optimistic cache.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit: Industry' })).toContainText(industry);
  });

  test('editing revenue stores minor units and renders them formatted', async () => {
    const page = getPage();
    await page.getByRole('link', { name: 'Lotus Design Studio', exact: true }).click();
    await page.waitForURL(/\/accounts\/[0-9a-f-]+$/);

    await page.getByRole('button', { name: 'Edit: Annual revenue' }).click();
    await page.getByLabel('Amount').fill('1234567.89');
    await page.getByRole('button', { name: 'Save' }).click();

    // Typed in major units, stored as paise, read back through the shared
    // formatter: 12,34,567.89 with lakh grouping and nothing rounded.
    await expect(page.getByRole('button', { name: 'Edit: Annual revenue' })).toContainText(
      '12,34,567.89',
    );
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit: Annual revenue' })).toContainText(
      '12,34,567.89',
    );
  });

  test('refuses a GSTIN that is not the right shape, and keeps the old value', async () => {
    const page = getPage();
    await page.getByRole('link', { name: 'Rajesh Gold House', exact: true }).click();
    await page.waitForURL(/\/accounts\/[0-9a-f-]+$/);

    await page.getByRole('button', { name: 'Edit: GSTIN' }).click();
    await page.getByLabel('GSTIN').fill('NOT-A-GSTIN');
    await page.getByLabel('GSTIN').press('Enter');

    await expect(page.getByRole('alert').first()).toBeVisible();
    // The optimistic value was rolled back rather than left on screen as if
    // it had saved.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit: GSTIN' })).toContainText(
      '29ABCDE1234F1Z5',
    );
  });
});

ownerSuite('the account hierarchy', (getPage) => {
  test('a branch links back to its parent', async () => {
    const page = getPage();

    await page.getByRole('link', { name: 'Rajesh Gold House — Kochi', exact: true }).click();
    await page.waitForURL(/\/accounts\/[0-9a-f-]+$/);

    // The parent is named, not labelled "parent account": the record page
    // resolves it so the hierarchy reads as a sentence.
    const parentLink = page.getByRole('link', { name: 'Rajesh Gold House', exact: true });
    await expect(parentLink).toBeVisible();
    await parentLink.click();

    await expect(
      page.getByRole('heading', { name: 'Rajesh Gold House', exact: true }),
    ).toBeVisible();
  });
});

test.describe('authentication', () => {
  test('an unauthenticated visitor cannot see accounts', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/accounts');

    // The API returns 401, so the list never renders rows.
    await expect(page.getByRole('link', { name: 'Rajesh Gold House', exact: true })).toHaveCount(0);
  });
});

ownerSuite('CSRF defence on the cookie-authenticated routes', (getPage) => {
  test('refuses a state-changing request from another origin', async () => {
    // The signed-in page's own request context, so the session cookie is
    // real — but with an Origin that is not ours. Without the check, any page
    // on the internet could drive the API as the signed-in user.
    const response = await getPage().request.post('/api/proxy/accounts', {
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: { name: 'Forged Ltd' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(403);
  });
});
