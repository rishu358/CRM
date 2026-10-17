import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Critical flows for deals (MVP_SPEC §M5, CLAUDE.md §10).
 *
 * The two acceptance criteria are asserted end to end, because both are
 * properties of the whole stack rather than of any layer:
 *
 *   - dragging a deal updates the stage instantly (optimistic) and persists
 *   - moving a deal to a won stage sets closed_at and probability 100
 *
 * The seed creates a default pipeline with six stages and six deals, one of
 * them in dollars and one in a second pipeline, owned by the owner and the
 * sales rep, so the board, the conversion and the scope split are all visible
 * without the test building any data of its own. Each test that moves a deal
 * uses a different one, so the tests do not depend on each other's side effects.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

/**
 * Wide enough to show all six columns at once.
 *
 * Playwright drags with a synthetic mouse, and when the drop target is off
 * screen it scrolls the board *while the button is held*, so the pointer ends
 * up over a different card than the one that was picked up. A real user's
 * browser auto-scrolls during a native drag instead; this keeps the test about
 * the board rather than about that difference.
 */
const WIDE = { width: 2200, height: 900 } as const;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/contacts');
  await page.goto('/deals');
}

/** One signed-in page for the owner suite: sign-in is rate limited per IP (§5.9). */
function ownerSuite(title: string, body: (getPage: () => Page) => void): void {
  test.describe(title, () => {
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      page = await browser.newPage({ viewport: WIDE });
      await signIn(page, credentials.owner);
    });

    test.afterAll(async () => {
      await page.close();
    });

    test.beforeEach(async () => {
      await page.goto('/deals');
      await expect(page.getByRole('region', { name: 'New' })).toBeVisible();
    });

    body(() => page);
  });
}

function column(page: Page, stage: string): Locator {
  return page.getByRole('region', { name: stage, exact: true });
}

function card(scope: Locator | Page, name: string): Locator {
  return scope.locator('[data-deal-id]').filter({ hasText: name });
}

ownerSuite('the board', (getPage) => {
  test('shows a column per stage with totals in the tenant currency', async () => {
    const page = getPage();

    for (const stage of ['New', 'Qualified', 'Proposal', 'Negotiation', 'Won', 'Lost']) {
      await expect(column(page, stage)).toBeVisible();
    }

    // ₹8,50,000.00 — lakh grouping from the shared formatter. The stored value
    // is 85000000 paise, which must never reach the screen.
    const fresh = column(page, 'New');
    await expect(fresh).toContainText('1 deal');
    await expect(fresh).toContainText('8,50,000.00');
    await expect(fresh).not.toContainText('85000000');

    // $18,500.00 at the stored rate of 83.25 is ₹15,40,125.00: the column
    // total is the converted figure, and the card keeps its own currency.
    const proposal = column(page, 'Proposal');
    await expect(proposal.getByLabel('Proposal total')).toContainText('15,40,125.00');
    await expect(card(proposal, 'Studio lighting supply')).toContainText('$18,500.00');
  });

  test('an empty column says so, rather than showing nothing', async () => {
    const page = getPage();
    await expect(column(page, 'Lost')).toContainText('No deals in this stage');
  });

  test('searching narrows every column', async () => {
    const page = getPage();

    await page.getByLabel('Search deals').fill('Festival');
    await expect(card(page, 'Festival collection order')).toBeVisible();
    await expect(card(page, 'Showroom fit-out')).toHaveCount(0);
  });
});

ownerSuite('dragging a deal (MVP_SPEC M5 acceptance)', (getPage) => {
  test('moves the card instantly, before the server has answered, and it persists', async () => {
    const page = getPage();

    // Hold the PATCH open. If the card moves while the request is still
    // pending, the update is optimistic; if it waited for the answer it could
    // not have moved yet.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let patchSeen = false;
    await page.route('**/api/proxy/deals/*', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchSeen = true;
        await gate;
      }
      await route.continue();
    });

    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().includes('/api/proxy/deals/'),
    );
    await card(column(page, 'New'), 'Showroom fit-out').dragTo(column(page, 'Qualified'));

    await expect(card(column(page, 'Qualified'), 'Showroom fit-out')).toBeVisible();
    await expect(card(column(page, 'New'), 'Showroom fit-out')).toHaveCount(0);
    // The count follows at once as well.
    await expect(column(page, 'New')).toContainText('No deals in this stage');
    expect(patchSeen).toBe(true);

    release();
    // Only unroute once the held request has been let through.
    expect((await answered).status()).toBe(200);
    await page.unroute('**/api/proxy/deals/*');

    // And it was saved: a fresh load still has it in the new column.
    await page.reload();
    await expect(card(column(page, 'Qualified'), 'Showroom fit-out')).toBeVisible();
    await expect(card(column(page, 'New'), 'Showroom fit-out')).toHaveCount(0);
  });

  test('a move to a won stage closes the deal at 100%', async () => {
    const page = getPage();

    await card(column(page, 'Qualified'), 'Festival collection order').dragTo(column(page, 'Won'));
    await expect(card(column(page, 'Won'), 'Festival collection order')).toBeVisible();

    // The record page shows what the server wrote, not what the board guessed.
    await card(column(page, 'Won'), 'Festival collection order')
      .getByRole('link', { name: 'Festival collection order' })
      .click();
    await page.waitForURL('**/deals/*');
    await expect(page.getByRole('button', { name: /Edit: Probability/ })).toContainText('100');
    await expect(page.getByText('Closed', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Stage')).toHaveValue(/.+/);
    await expect(page.getByLabel('Stage').locator('option:checked')).toHaveText('Won');
  });

  test('a move to a lost stage asks for a reason, and cancelling changes nothing', async () => {
    const page = getPage();

    await card(column(page, 'Negotiation'), 'Boutique opening stock').dragTo(column(page, 'Lost'));

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Boutique opening stock');

    // No reason, no move.
    await dialog.getByRole('button', { name: 'Mark as lost' }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(card(column(page, 'Negotiation'), 'Boutique opening stock')).toBeVisible();

    // With a reason it goes through and the reason is kept.
    await card(column(page, 'Negotiation'), 'Boutique opening stock').dragTo(column(page, 'Lost'));
    await page.getByRole('dialog').getByLabel('Lost reason').fill('Chose a competitor');
    await page.getByRole('dialog').getByRole('button', { name: 'Mark as lost' }).click();

    await expect(card(column(page, 'Lost'), 'Boutique opening stock')).toBeVisible();
    await expect(card(column(page, 'Lost'), 'Boutique opening stock')).toContainText(
      'Chose a competitor',
    );
  });

  test('puts the card back and says so when the server refuses the move', async () => {
    const page = getPage();

    await page.route('**/api/proxy/deals/*', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'VERSION_CONFLICT',
              message: 'This deal was changed by someone else. Reload and try again.',
              details: [],
              requestId: 'e2e',
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await card(column(page, 'Won'), 'Anniversary gifting').dragTo(column(page, 'New'));

    await expect(
      page.getByRole('alert').filter({ hasText: 'Someone else changed this deal first' }),
    ).toBeVisible();
    // Rolled back: the optimistic move is undone, not left on screen.
    await expect(card(column(page, 'Won'), 'Anniversary gifting')).toBeVisible();
    await expect(card(column(page, 'New'), 'Anniversary gifting')).toHaveCount(0);

    await page.unroute('**/api/proxy/deals/*');
  });

  test('the stage menu on a card moves it without dragging', async () => {
    const page = getPage();

    const target = card(column(page, 'Proposal'), 'Studio lighting supply');
    await target
      .getByLabel('Move Studio lighting supply to')
      .selectOption({ label: 'Negotiation' });

    await expect(card(column(page, 'Negotiation'), 'Studio lighting supply')).toBeVisible();
    await expect(card(column(page, 'Proposal'), 'Studio lighting supply')).toHaveCount(0);
  });
});

ownerSuite('the list view and the record page', (getPage) => {
  test('lists the pipeline with amounts in their own currency and sorts by a header', async () => {
    const page = getPage();

    await page.getByRole('button', { name: 'List', exact: true }).click();
    const row = page.getByRole('row').filter({ hasText: 'Anniversary gifting' });
    await expect(row).toContainText('4,00,000.00');

    await page.getByRole('button', { name: /Deal name/ }).click();
    await expect(page.getByRole('columnheader', { name: /Deal name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    const names = await page.getByRole('cell').locator('a').allInnerTexts();
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  test('edits a deal in place and keeps the edit after a reload', async () => {
    const page = getPage();

    await page.getByLabel('Pipeline').selectOption({ label: 'Wholesale' });
    await card(column(page, 'Enquiry'), 'Export sample run')
      .getByRole('link', { name: 'Export sample run' })
      .click();
    await page.waitForURL('**/deals/*');

    await page.getByRole('button', { name: 'Edit: Deal name' }).click();
    await page.getByLabel('Deal name').fill('Export sample run (revised)');
    await page.getByLabel('Deal name').press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Export sample run');

    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit: Deal name' })).toContainText('(revised)');
  });

  test('creates a deal in the chosen pipeline and shows it in the first stage', async () => {
    const page = getPage();

    await page.getByRole('button', { name: 'New deal' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Deal name').fill('E2E walk-in order');
    await dialog.getByLabel('Amount').fill('1500.75');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog).toBeHidden();
    const created = card(column(page, 'New'), 'E2E walk-in order');
    await expect(created).toBeVisible();
    await expect(created).toContainText('1,500.75');
  });
});

test.describe('record scope', () => {
  test.use({ viewport: WIDE });

  test('a sales rep sees only their own deals on the board', async ({ page }) => {
    await signIn(page, credentials.rep);

    await expect(card(page, 'Studio lighting supply')).toBeVisible();
    await expect(card(page, 'Boutique opening stock')).toBeVisible();
    // Owned by the workspace owner; `own` scope must exclude them, from the
    // cards and from the column counts alike.
    await expect(card(page, 'Showroom fit-out')).toHaveCount(0);
    await expect(card(page, 'Anniversary gifting')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Won' })).toContainText('No deals in this stage');
  });
});
