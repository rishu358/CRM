import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The WhatsApp chat button (Phase 2, first piece).
 *
 * The button is a plain link the person's own device opens, so what is checked
 * here is the link itself: where it points, that it opens a new tab without
 * handing the page over, and what a screen reader is told. The link is never
 * followed: the test must not depend on, or send traffic to, a third party.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; password: string };

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

const unique = (): string => Date.now().toString().slice(-7);

/** Create a record through the same-origin proxy, as the app does, and return its id. */
async function create(
  page: Page,
  collection: 'contacts' | 'accounts' | 'leads',
  body: Record<string, unknown>,
): Promise<string> {
  const response = await page.request.post(`/api/proxy/${collection}`, {
    headers: { origin: new URL(page.url()).origin, 'content-type': 'application/json' },
    data: body,
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { data: { id: string } }).data.id;
}

/** The chat link, with the attributes that make it safe. */
async function expectSafeLink(link: Locator, href: string): Promise<void> {
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', href);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
}

test.describe('WhatsApp chat button', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, credentials.owner);
  });

  test('a contact with a WhatsApp number links to it, and names who and which number', async ({
    page,
  }) => {
    const surname = `Chat${unique()}`;
    const id = await create(page, 'contacts', {
      firstName: 'Asha',
      lastName: surname,
      phone: '+14155552671',
      whatsapp: '+919876543210',
    });
    await page.goto(`/contacts/${id}`);

    const link = page.getByTestId('whatsapp-chat');
    await expectSafeLink(link, 'https://wa.me/919876543210');
    await expect(link).toHaveAttribute('data-source', 'whatsapp');
    const label = (await link.getAttribute('aria-label')) ?? '';
    expect(label).toContain(`Asha ${surname}`);
    expect(label).toContain('WhatsApp number +919876543210');
    await expect(link).toHaveAttribute('title', 'Uses the WhatsApp number +919876543210.');
    // Also reachable by its accessible name, as a screen reader user would find it.
    await expect(
      page.getByRole('link', { name: new RegExp(`Chat with Asha ${surname}`) }),
    ).toHaveCount(1);
    // Exactly one: the phone row does not get a second button.
    await expect(page.getByTestId('whatsapp-chat')).toHaveCount(1);
  });

  test('a contact with no WhatsApp number falls back to the phone and says so', async ({
    page,
  }) => {
    const surname = `Phone${unique()}`;
    const id = await create(page, 'contacts', { lastName: surname, phone: '+14155552671' });
    await page.goto(`/contacts/${id}`);

    const link = page.getByTestId('whatsapp-chat');
    await expectSafeLink(link, 'https://wa.me/14155552671');
    await expect(link).toHaveAttribute('data-source', 'phone');
    await expect(link).toHaveAttribute('aria-label', /phone number \+14155552671/);
    await expect(link).toHaveAttribute('aria-label', /no WhatsApp number is saved/);
    await expect(link).toHaveAttribute('title', /no WhatsApp number is saved/);
  });

  test('a contact with no number has no button and no hint', async ({ page }) => {
    const id = await create(page, 'contacts', { lastName: `Nonumber${unique()}` });
    await page.goto(`/contacts/${id}`);

    await expect(page.getByRole('heading', { name: /Nonumber/ })).toBeVisible();
    await expect(page.getByTestId('whatsapp-chat')).toHaveCount(0);
    await expect(page.getByTestId('whatsapp-invalid')).toHaveCount(0);
  });

  test('a number that is not valid shows a hint to fix it, not a dead button', async ({ page }) => {
    // The API refuses a badly formed number, so one can only arrive from an old
    // import or a direct database edit. Simulate that by changing what is read.
    const id = await create(page, 'contacts', {
      lastName: `Badnumber${unique()}`,
      phone: '+14155552671',
    });
    await page.route(`**/api/proxy/contacts/${id}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const json = (await response.json()) as { data: Record<string, unknown> };
      json.data.phone = '98765 43210';
      await route.fulfill({ response, json });
    });
    await page.goto(`/contacts/${id}`);

    await expect(page.getByTestId('whatsapp-invalid')).toBeVisible();
    await expect(page.getByTestId('whatsapp-invalid')).toContainText('international format');
    await expect(page.getByTestId('whatsapp-chat')).toHaveCount(0);
    await expect(page.locator('a[href*="wa.me"]')).toHaveCount(0);
  });

  test('an account links to its phone number', async ({ page }) => {
    const name = `Chat Traders ${unique()}`;
    const id = await create(page, 'accounts', { name, phone: '+912240001234' });
    await page.goto(`/accounts/${id}`);

    const link = page.getByTestId('whatsapp-chat');
    await expectSafeLink(link, 'https://wa.me/912240001234');
    await expect(link).toHaveAttribute('data-source', 'phone');
    await expect(link).toHaveAttribute('aria-label', new RegExp(`Chat with ${name}`));
  });

  test('a lead links to its phone number', async ({ page }) => {
    const surname = `Lead${unique()}`;
    const id = await create(page, 'leads', {
      firstName: 'Ravi',
      lastName: surname,
      phone: '+919123456789',
    });
    await page.goto(`/leads/${id}`);

    const link = page.getByTestId('whatsapp-chat');
    await expectSafeLink(link, 'https://wa.me/919123456789');
    await expect(link).toHaveAttribute('aria-label', new RegExp(`Chat with Ravi ${surname}`));
  });

  test('opening the record does not contact WhatsApp, and the button works from the keyboard', async ({
    page,
  }) => {
    const requestedHosts: string[] = [];
    page.on('request', (request) => requestedHosts.push(new URL(request.url()).host));

    const id = await create(page, 'contacts', {
      lastName: `Keys${unique()}`,
      whatsapp: '+919876543210',
    });
    await page.goto(`/contacts/${id}`);

    const link = page.getByTestId('whatsapp-chat');
    await link.focus();
    await expect(link).toBeFocused();
    // The focus ring is drawn: a keyboard user can see where they are.
    const outline = await link.evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outline).not.toBe('none');

    // Seen only by looking, never by following: nothing has gone to wa.me.
    expect(requestedHosts.filter((host) => host.includes('wa.me'))).toEqual([]);
  });

  test('fits a phone screen: the button is on screen and the page does not scroll sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const id = await create(page, 'contacts', {
      lastName: `Mobile${unique()}`,
      whatsapp: '+919876543210',
    });
    await page.goto(`/contacts/${id}`);

    const link = page.getByTestId('whatsapp-chat');
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? -1) >= 0).toBe(true);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
