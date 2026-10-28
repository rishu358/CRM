import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * A website lead form, end to end (ADR-0065).
 *
 * Through the browser because the claim crosses every layer: the administrator builds a form and is
 * shown its link once; a stranger with no session opens that link, fills the form in and sends it;
 * the lead appears in the company's CRM, made from the web form and given an owner; and a form that
 * is switched off, or that is framed from a site nobody allowed, does not work.
 *
 * Serial, in one signed-in page: sign-in is rate limited per address (CLAUDE.md §5.9). The stranger
 * is a second browser context with no cookies at all.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; rep: string; password: string };

const unique = Date.now().toString().slice(-6);
const FORM_NAME = `Homepage enquiry ${unique}`;
const VISITOR = `Visitor ${unique}`;
const VISITOR_EMAIL = `visitor.${unique}@example.com`;
const ALLOWED_SITE = 'https://shop.example.com';

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

interface FormRow {
  id: string;
  name: string;
  version: number;
  status: string;
}

test.describe.serial('an owner builds a web form and a visitor uses it', () => {
  let owner: Page;
  let link = '';
  let key = '';
  let formId = '';

  test.beforeAll(async ({ browser }) => {
    owner = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await signIn(owner, credentials.owner);
  });

  test.afterAll(async () => {
    // Leave the company as it was: the form and the leads it made.
    const forms = (await api<{ data: FormRow[] }>(owner, 'GET', '/lead-forms')).data;
    for (const form of forms.filter((entry) => entry.name === FORM_NAME)) {
      await api(owner, 'DELETE', `/lead-forms/${form.id}?version=${form.version}`);
    }
    const leads = (
      await api<{ data: { id: string; version: number; lastName: string }[] }>(
        owner,
        'GET',
        `/leads?limit=100&q=${encodeURIComponent(VISITOR)}`,
      )
    ).data;
    for (const lead of leads.filter((entry) => entry.lastName === VISITOR)) {
      await api(owner, 'DELETE', `/leads/${lead.id}?version=${lead.version}`);
    }
    await owner.close();
  });

  test('builds the form and is shown its link once', async () => {
    await owner.goto('/settings/web-forms');
    await expect(owner.getByRole('heading', { name: 'Web forms', level: 1 })).toBeVisible();
    await owner.getByRole('button', { name: 'New web form' }).first().click();

    await owner.getByLabel('Form name').fill(FORM_NAME);
    await owner
      .getByLabel('Consent wording', { exact: true })
      .fill('I agree that this company may contact me about my enquiry.');
    await owner.getByLabel('Message after sending').fill('Thank you, we will call you back.');
    await owner.getByLabel('Your websites that may show this form').fill(ALLOWED_SITE);

    // The preview shows what a visitor will get, and sends nothing.
    const preview = owner.getByTestId('web-form-preview');
    await expect(preview.getByText(FORM_NAME)).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Send' })).toBeDisabled();

    await owner.getByRole('button', { name: 'Create form' }).click();
    const issued = owner.getByTestId('web-form-issued');
    await expect(issued).toBeVisible();

    link = await issued.getByTestId('web-form-link').inputValue();
    const snippet = await issued.getByTestId('web-form-snippet').inputValue();
    expect(link).toMatch(/\/f\/lfk_[A-Za-z0-9_-]{43}$/);
    expect(snippet).toContain('<iframe');
    key = link.slice(link.lastIndexOf('/') + 1);

    await issued.getByRole('button', { name: 'I have copied it' }).click();
    await expect(issued).toBeHidden();

    // The key is never shown again: not on the list, and not in anything the API returns.
    await expect(owner.getByText(key)).toHaveCount(0);
    const forms = (await api<{ data: FormRow[] }>(owner, 'GET', '/lead-forms')).data;
    formId = forms.find((form) => form.name === FORM_NAME)!.id;
    expect(JSON.stringify(forms)).not.toContain(key);
  });

  test('a stranger with no session opens the link, sends the form, and sees the message', async ({
    browser,
  }) => {
    const stranger = await browser.newContext();
    const visitor = await stranger.newPage();
    try {
      const opened = await visitor.goto(link);
      expect(opened?.status()).toBe(200);
      expect(visitor.url()).toContain('/f/lfk_');
      await expect(visitor.getByRole('heading', { name: FORM_NAME })).toBeVisible();

      // Nothing of the app is on the page: no navigation, no sign-in redirect, no cookie was set.
      expect(await stranger.cookies()).toEqual([]);
      const headers = opened?.headers() ?? {};
      expect(headers['cache-control']).toContain('no-store');
      // Nobody listed this form's own address as a site that may frame it, only the shop.
      expect(headers['content-security-policy']).toContain(`frame-ancestors ${ALLOWED_SITE}`);
      expect(headers['x-frame-options']).toBeUndefined();

      await visitor.getByLabel('Last name (required)').fill(VISITOR);
      await visitor.getByLabel('Email').fill(VISITOR_EMAIL);

      // Without the consent box the form does not go.
      await visitor.getByRole('button', { name: 'Send' }).click();
      await expect(visitor.getByText('Please tick the box to continue')).toBeVisible();

      await visitor.getByLabel(/I agree that this company may contact me/).check();
      // A page sent within three seconds of being drawn is turned away, so a person is given a
      // moment, as a real one takes.
      await visitor.waitForTimeout(3500);
      await visitor.getByRole('button', { name: 'Send' }).click();
      await expect(visitor.getByTestId('public-form-done')).toHaveText(
        'Thank you, we will call you back.',
      );
      expect(await stranger.cookies()).toEqual([]);
    } finally {
      await stranger.close();
    }
  });

  test('the lead is in the CRM, from the web form, with an owner', async () => {
    const found = (
      await api<{
        data: {
          id: string;
          lastName: string;
          email: string;
          source: string;
          ownerId: string | null;
        }[];
      }>(owner, 'GET', `/leads?limit=100&q=${encodeURIComponent(VISITOR)}`)
    ).data.find((lead) => lead.lastName === VISITOR);

    expect(found).toBeDefined();
    expect(found!.email).toBe(VISITOR_EMAIL);
    expect(found!.source).toBe('web_form');
    expect(found!.ownerId).not.toBeNull();

    await owner.goto(`/leads/${found!.id}`);
    await expect(owner.getByText(VISITOR).first()).toBeVisible();

    await owner.goto('/settings/web-forms');
    await expect(owner.getByTestId('web-form-list').getByText(FORM_NAME)).toBeVisible();
    await expect(owner.getByTestId('web-form-list')).toContainText('1 in all');
  });

  test('a form that is switched off answers like one that does not exist', async ({ browser }) => {
    const form = (await api<{ data: FormRow[] }>(owner, 'GET', '/lead-forms')).data.find(
      (entry) => entry.id === formId,
    )!;
    await api(owner, 'PATCH', `/lead-forms/${formId}`, {
      status: 'disabled',
      version: form.version,
    });

    const stranger = await browser.newContext();
    const visitor = await stranger.newPage();
    try {
      await visitor.goto(link);
      await expect(
        visitor.getByRole('heading', { name: 'This form is not available' }),
      ).toBeVisible();

      const wrong = await stranger.newPage();
      await wrong.goto(`/f/lfk_${'Q'.repeat(43)}`);
      await expect(
        wrong.getByRole('heading', { name: 'This form is not available' }),
      ).toBeVisible();
      // The page tells nobody which of the two it was, and nobody may frame either.
      const disabledHeaders = (await visitor.request.get(link)).headers();
      const wrongHeaders = (await wrong.request.get(`/f/lfk_${'Q'.repeat(43)}`)).headers();
      expect(disabledHeaders['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(wrongHeaders['content-security-policy']).toContain("frame-ancestors 'none'");
    } finally {
      await stranger.close();
    }
  });

  test('the rest of the app still cannot be framed, and still needs a session', async ({
    browser,
    request,
  }) => {
    const dashboard = await request.get('/dashboard', { maxRedirects: 0 });
    expect(dashboard.status()).toBe(307);

    const stranger = await browser.newContext();
    const page = await stranger.newPage();
    try {
      const signInPage = await page.goto('/sign-in');
      const headers = signInPage?.headers() ?? {};
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    } finally {
      await stranger.close();
    }
  });
});
