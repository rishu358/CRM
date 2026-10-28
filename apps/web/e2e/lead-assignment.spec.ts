import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Lead assignment rules, end to end (ADR-0065 10): an owner adds a rule in Settings, tries a sample
 * lead against it, and reorders the rules, all through the screen. Which person a real web form lead
 * ends up with is covered at the API (`lead-assignment.spec.ts`), where fairness under concurrency
 * can be measured.
 *
 * Serial, in one signed-in page: sign-in is rate limited per address (CLAUDE.md §5.9). It removes
 * the rules it made, so the company is left as it was.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

const unique = Date.now().toString().slice(-6);
const FIRST = `Kolkata leads ${unique}`;
const SECOND = `Catch-all ${unique}`;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
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

test.describe.serial('an owner sets up lead assignment', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
    await signIn(page, credentials.owner);
  });

  test.afterAll(async () => {
    const overview = (
      await api<{ data: { rules: { id: string; name: string; version: number }[] } }>(
        page,
        'GET',
        '/lead-assignment',
      )
    ).data;
    for (const rule of overview.rules.filter((entry) => entry.name.endsWith(unique))) {
      await api(page, 'DELETE', `/lead-assignment/rules/${rule.id}?version=${rule.version}`);
    }
    await page.close();
  });

  test('adds a rule that sends Kolkata leads to a named person', async () => {
    await page.goto('/settings/lead-assignment');
    await expect(page.getByRole('heading', { name: 'Lead assignment', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Add a rule' }).first().click();
    const editor = page.getByTestId('assignment-editor');
    await editor.getByLabel('Rule name').fill(FIRST);
    await editor.getByRole('button', { name: 'Add a condition' }).click();
    await editor.getByLabel('Field 1').selectOption({ label: 'Company' });
    await editor.getByLabel('Value 1').fill('Kolkata Gold');
    // The first person the company offers, whoever that is.
    const person = editor.getByLabel('Person');
    const first = (await person.locator('option').nth(1).getAttribute('value'))!;
    await person.selectOption(first);
    await editor.getByRole('button', { name: 'Save rule' }).click();
    await expect(editor).toBeHidden();

    const rules = page.getByTestId('assignment-rules');
    await expect(rules).toContainText(FIRST);
    await expect(rules).toContainText('Company is Kolkata Gold');
  });

  test('adds a catch-all, and the order can be changed from the keyboard buttons', async () => {
    await page.getByRole('button', { name: 'Add a rule' }).first().click();
    const editor = page.getByTestId('assignment-editor');
    await editor.getByLabel('Rule name').fill(SECOND);
    await editor.getByLabel('Then').selectOption('default_owner');
    await editor.getByRole('button', { name: 'Save rule' }).click();
    await expect(editor).toBeHidden();

    const names = async () =>
      page
        .getByTestId('assignment-rules')
        .locator('li')
        .evaluateAll((items) => items.map((item) => item.textContent ?? ''));
    const before = await names();
    const firstIndex = before.findIndex((text) => text.includes(FIRST));
    const secondIndex = before.findIndex((text) => text.includes(SECOND));
    expect(firstIndex).toBeLessThan(secondIndex);

    await page.getByRole('button', { name: `Move ${SECOND} up` }).click();
    await expect
      .poll(async () => {
        const after = await names();
        return (
          after.findIndex((text) => text.includes(SECOND)) <
          after.findIndex((text) => text.includes(FIRST))
        );
      })
      .toBe(true);
  });

  test('tries a sample lead, and says who would get it without moving anyone’s turn', async () => {
    await page.getByLabel('Add a field to the sample').selectOption({ label: 'Company' });
    await page.getByLabel('Company', { exact: true }).fill('Kolkata Gold');
    await page.getByRole('button', { name: 'Who would get it?' }).click();
    await expect(page.getByTestId('assignment-test-result')).toContainText('would get it');

    // Nothing about trying it was saved: the rules are exactly as they were.
    const overview = (
      await api<{ data: { rules: { name: string }[] } }>(page, 'GET', '/lead-assignment')
    ).data;
    expect(overview.rules.filter((rule) => rule.name.endsWith(unique))).toHaveLength(2);
  });

  test('a person without the grant is told so', async ({ browser }) => {
    const rep = await browser.newPage();
    try {
      await signIn(rep, credentials.rep);
      await rep.goto('/settings/lead-assignment');
      await expect(rep.getByText('You cannot manage lead assignment')).toBeVisible();
    } finally {
      await rep.close();
    }
  });
});
