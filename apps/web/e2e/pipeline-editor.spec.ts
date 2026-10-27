import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The pipeline and stage editor, end to end (MVP_SPEC M5, M9, ADR-0062).
 *
 * Through the browser because the claim crosses every layer: the administrator's screen, the API
 * that enforces the stage rules, and the deals board that has to draw the result at once. The
 * whole flow runs on a stage this file makes in the seeded Wholesale pipeline, so the stages the
 * other suites look for are never renamed or reordered, and it ends by retiring that stage and
 * deleting the deal it made (a retired stage is invisible to every other screen).
 *
 * Serial, and in one signed-in page: sign-in is rate limited per address (CLAUDE.md §5.9).
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

const WIDE = { width: 2200, height: 900 } as const;
const unique = Date.now().toString().slice(-6);
const FIRST_NAME = `Site visit ${unique}`;
const SECOND_NAME = `Site survey ${unique}`;
const DEAL_NAME = `Pipeline editor deal ${unique}`;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

const rows = (page: Page): Locator => page.getByTestId('pipeline-stages').getByTestId('stage-row');

const rowFor = (page: Page, stageName: string): Locator =>
  rows(page).filter({ has: page.getByLabel(`Name of stage ${stageName}`, { exact: true }) });

async function stageNames(page: Page): Promise<string[]> {
  return rows(page)
    .getByRole('textbox')
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
}

async function openEditor(page: Page): Promise<void> {
  await page.goto('/settings/pipelines');
  await expect(page.getByRole('heading', { name: 'Pipelines', level: 1 })).toBeVisible();
  await page.getByLabel('Pipeline', { exact: true }).selectOption({ label: 'Wholesale' });
  await expect(page.getByTestId('pipeline-stages')).toBeVisible();
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api/proxy${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return response.status === 204 ? null : await response.json();
    },
    { method, path, body },
  ) as Promise<T>;
}

test.describe.serial('an owner reshapes the Wholesale pipeline', () => {
  let page: Page;
  let dealId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: WIDE });
    await signIn(page, credentials.owner);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('adds a stage after the open ones, and says so', async () => {
    await openEditor(page);
    const before = await stageNames(page);

    await page.getByRole('button', { name: 'Add a stage' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a stage' });
    await dialog.getByLabel('Name').fill(FIRST_NAME);
    await dialog.getByLabel('Chance of winning, in percent').fill('40');
    await dialog.getByRole('button', { name: 'Add stage' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId('pipeline-notice')).toContainText(`${FIRST_NAME} was added.`);
    const after = await stageNames(page);
    // After the last open stage, before Delivered and Cancelled.
    expect(after).toHaveLength(before.length + 1);
    expect(after.indexOf(FIRST_NAME)).toBe(after.length - 3);
  });

  test('refuses a name that is already in use, with the reason beside the field', async () => {
    await openEditor(page);
    await page.getByRole('button', { name: 'Add a stage' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add a stage' });
    await dialog.getByLabel('Name').fill(FIRST_NAME.toUpperCase());
    await dialog.getByRole('button', { name: 'Add stage' }).click();
    await expect(dialog.getByRole('alert')).toContainText('already exists');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('renames in place and changes the probability, and both survive a reload', async () => {
    await openEditor(page);
    const name = page.getByLabel(`Name of stage ${FIRST_NAME}`, { exact: true });
    await name.fill(SECOND_NAME);
    await name.press('Enter');
    await expect(page.getByLabel(`Name of stage ${SECOND_NAME}`, { exact: true })).toHaveValue(
      SECOND_NAME,
    );

    const probability = page.getByLabel(`Probability of stage ${SECOND_NAME}, in percent`);
    // The edit shows at once (optimistic) and is saved a moment later; reload only once the server
    // has answered, or the reload would cancel the save this test is about.
    const saved = page.waitForResponse(
      (response) => response.request().method() === 'PATCH' && response.url().includes('/stages/'),
    );
    await probability.fill('65');
    await probability.press('Enter');
    await expect(probability).toHaveValue('65');
    expect((await saved).status()).toBe(200);

    await page.reload();
    await page.getByLabel('Pipeline', { exact: true }).selectOption({ label: 'Wholesale' });
    await expect(page.getByLabel(`Name of stage ${SECOND_NAME}`, { exact: true })).toHaveValue(
      SECOND_NAME,
    );
    await expect(page.getByLabel(`Probability of stage ${SECOND_NAME}, in percent`)).toHaveValue(
      '65',
    );
  });

  test('moves a stage up from the keyboard, and the board shows the new order', async () => {
    await openEditor(page);
    const before = await stageNames(page);

    const up = page.getByRole('button', { name: `Move ${SECOND_NAME} up` });
    await up.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => (await stageNames(page)).indexOf(SECOND_NAME))
      .toBe(before.indexOf(SECOND_NAME) - 1);

    // The Won and Lost stages cannot be moved above an open stage, and the screen says so by
    // disabling the button rather than letting the server refuse it.
    await expect(page.getByRole('button', { name: 'Move Delivered up' })).toBeDisabled();

    await page.goto('/deals');
    await page.getByLabel('Pipeline', { exact: true }).selectOption({ label: 'Wholesale' });
    await expect(page.getByRole('region', { name: SECOND_NAME, exact: true })).toBeVisible();
    const columns = await page
      .getByTestId('deals-board')
      .getByRole('region')
      .evaluateAll((regions) => regions.map((region) => region.getAttribute('aria-label')));
    expect(columns.indexOf(SECOND_NAME)).toBe(before.indexOf(SECOND_NAME) - 1);
  });

  test('retires a stage that holds a deal: says how many, moves them, and the board follows', async () => {
    // A deal in the new stage, made the way any client would.
    const pipelines = await api<{
      data: { name: string; id: string; stages: { id: string; name: string }[] }[];
    }>(page, 'GET', '/pipelines');
    const wholesale = pipelines.data.find((pipeline) => pipeline.name === 'Wholesale')!;
    const stage = wholesale.stages.find((entry) => entry.name === SECOND_NAME)!;
    const created = await api<{ data: { id: string } }>(page, 'POST', '/deals', {
      name: DEAL_NAME,
      pipelineId: wholesale.id,
      stageId: stage.id,
    });
    dealId = created.data.id;

    await openEditor(page);
    await expect(rowFor(page, SECOND_NAME).getByTestId('stage-deals')).toContainText('1 deal');

    await page.getByRole('button', { name: `Retire ${SECOND_NAME}` }).click();
    const dialog = page.getByRole('dialog', { name: `Retire ${SECOND_NAME}?` });
    await expect(dialog.getByTestId('retire-deal-count')).toContainText('1 deal is in this stage');

    // Asking for a target is not optional: the confirm button names the count.
    await dialog.getByLabel('Move the deals to').selectOption({ label: 'Enquiry' });
    await dialog.getByRole('button', { name: 'Move 1 deal and retire' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId('pipeline-notice')).toContainText(
      `${SECOND_NAME} was retired. 1 deal was moved.`,
    );
    expect(await stageNames(page)).not.toContain(SECOND_NAME);
    await expect(page.getByTestId('retired-stages')).toContainText(SECOND_NAME);

    // The board: the column is gone and the deal sits in Enquiry.
    await page.goto('/deals');
    await page.getByLabel('Pipeline', { exact: true }).selectOption({ label: 'Wholesale' });
    await expect(page.getByRole('region', { name: 'Enquiry', exact: true })).toContainText(
      DEAL_NAME,
    );
    await expect(page.getByRole('region', { name: SECOND_NAME, exact: true })).toHaveCount(0);
  });

  test('restores a retired stage, then retires it again to leave the pipeline as it was', async () => {
    await openEditor(page);
    await page.getByRole('button', { name: `Restore ${SECOND_NAME}` }).click();
    await expect(page.getByLabel(`Name of stage ${SECOND_NAME}`, { exact: true })).toBeVisible();

    // Empty now, so retiring needs no target and no deal count.
    await page.getByRole('button', { name: `Retire ${SECOND_NAME}` }).click();
    const dialog = page.getByRole('dialog', { name: `Retire ${SECOND_NAME}?` });
    await expect(dialog).toContainText('No deals are in this stage');
    await dialog.getByRole('button', { name: 'Retire stage' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('retired-stages')).toContainText(SECOND_NAME);
  });

  test('the dashboard still draws, and the suite tidies up its deal', async () => {
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByText('Could not load this')).toHaveCount(0);

    // Tidy up the deal this suite made.
    const detail = await api<{ data: { version: number } }>(page, 'GET', `/deals/${dealId}`);
    await api(page, 'DELETE', `/deals/${dealId}?version=${detail.data.version}`);
  });
});

test.describe('who may open the editor', () => {
  test('a sales rep is told this is for administrators', async ({ page }) => {
    await signIn(page, credentials.rep);
    await page.goto('/settings/pipelines');
    await expect(page.getByText('Only administrators change pipelines')).toBeVisible();
  });
});
