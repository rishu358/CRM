/**
 * Screenshot every route, so a UI change is reviewable as something other than
 * a diff (docs/design/README.md).
 *
 *   pnpm --filter @crm/web exec tsx scripts/capture-screens.mts <label>
 *
 * Needs the web app and API running and a seeded tenant. Credentials come from
 * the environment, never from the repo:
 *
 *   CRM_OWNER_EMAIL, CRM_REP_EMAIL, CRM_PASSWORD   (printed by `pnpm db:seed`)
 *   CRM_INVITE_TOKEN                                (optional; the invite screen)
 *
 * Output: docs/design/<label>/<NN>-<name>.<light|dark>.png
 *
 * The four required states are produced by intercepting the API calls the page
 * itself makes — a delayed response for loading, a 500 for error, a 403 for
 * no-permission — so they are captured deterministically instead of by luck.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

const BASE = process.env.WEB_URL ?? 'http://localhost:3000';
const label = process.argv[2] ?? 'after';
const outDir = join(import.meta.dirname, '..', '..', '..', 'docs', 'design', label);
mkdirSync(outDir, { recursive: true });

const owner = process.env.CRM_OWNER_EMAIL;
const rep = process.env.CRM_REP_EMAIL;
const password = process.env.CRM_PASSWORD;
if (owner === undefined || rep === undefined || password === undefined) {
  throw new Error('Set CRM_OWNER_EMAIL, CRM_REP_EMAIL and CRM_PASSWORD (see `pnpm db:seed`).');
}

type Scheme = 'light' | 'dark';
/** Playwright's library API waits forever by default; a hang should be an error. */
const TIMEOUT = 25_000;
const DESKTOP = { width: 1440, height: 900 } as const;

let counter = 0;
const next = () => String(++counter).padStart(2, '0');

async function shot(page: Page, name: string, scheme: Scheme, fullPage = true): Promise<void> {
  // Let layout, fonts and any entrance motion settle before the picture.
  await page.addStyleTag({ content: 'nextjs-portal{display:none !important}' }).catch(() => undefined);
  await page.addStyleTag({ content: 'nextjs-portal{display:none !important}' }).catch(() => undefined);
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(outDir, `${name}.${scheme}.png`), fullPage });
}

async function signIn(browser: Browser, email: string): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: DESKTOP });
  context.setDefaultTimeout(TIMEOUT);
  const page = await context.newPage();
  await page.goto(`${BASE}/sign-in`);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/contacts', { timeout: 30_000 });
  await page.close();
  return context;
}

async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** First link inside <main> that points into `section`, e.g. /contacts/<id>. */
async function firstRecordHref(page: Page, section: string): Promise<string | null> {
  await page.goto(`${BASE}/${section}`);
  await settled(page);
  const link = page.locator(`main a[href^="/${section}/"]`).first();
  if ((await link.count()) === 0) return null;
  return link.getAttribute('href');
}

async function captureSignedOut(browser: Browser): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: DESKTOP, colorScheme: scheme });
    context.setDefaultTimeout(TIMEOUT);
    const page = await context.newPage();
    const screens: [string, string][] = [
      ['sign-in', '/sign-in'],
      ['sign-up', '/sign-up'],
      ['forgot-password', '/forgot-password'],
      ['reset-password', '/reset-password?token=example'],
      ['verify-email', '/verify-email'],
    ];
    if (process.env.CRM_INVITE_TOKEN !== undefined) {
      screens.push(['accept-invite', `/accept-invite?token=${process.env.CRM_INVITE_TOKEN}`]);
    }
    for (const [name, path] of screens) {
      await page.goto(`${BASE}${path}`);
      await settled(page);
      await shot(page, `${next()}-auth-${name}`, scheme);
    }
    // The sign-in error state: the real form against the real API.
    await page.goto(`${BASE}/sign-in`);
    await page.getByLabel('Email address').fill('nobody@example.com');
    await page.getByLabel('Password').fill('wrong-password-1234');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('alert').first().waitFor({ timeout: 15_000 });
    await shot(page, `${next()}-auth-sign-in-error`, scheme);
    await context.close();
    counter = 0;
  }
}

async function captureApp(
  browser: Browser,
  storage: Awaited<ReturnType<BrowserContext['storageState']>>,
  scheme: Scheme,
): Promise<void> {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: scheme,
    storageState: storage,
  });
  context.setDefaultTimeout(TIMEOUT);
  const page = await context.newPage();
  const routes: [string, string][] = [
    ['my-day', '/my-day'],
    ['leads', '/leads'],
    ['contacts', '/contacts'],
    ['accounts', '/accounts'],
    ['deals-board', '/deals'],
    ['import', '/import'],
    ['settings-team', '/settings/team'],
    ['settings-security', '/settings/security'],
  ];
  for (const [name, path] of routes) {
    await page.goto(`${BASE}${path}`);
    await settled(page);
    await shot(page, `${next()}-${name}`, scheme);
  }

  // Deals as a list.
  await page.goto(`${BASE}/deals`);
  await settled(page);
  await page.getByRole('button', { name: 'List' }).click();
  await settled(page);
  await shot(page, `${next()}-deals-list`, scheme);

  // Record pages.
  for (const section of ['contacts', 'accounts', 'leads', 'deals']) {
    const href = await firstRecordHref(page, section);
    if (href === null) continue;
    await page.goto(`${BASE}${href}`);
    await settled(page);
    await shot(page, `${next()}-${section}-detail`, scheme);
  }

  // Overlays: palette and a create dialog.
  await page.goto(`${BASE}/contacts`);
  await settled(page);
  await page.waitForTimeout(2_000); // let React hydrate before sending keys
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('gold');
  await page.waitForTimeout(900);
  await shot(page, `${next()}-palette`, scheme, false);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New contact' }).click();
  await shot(page, `${next()}-new-contact-dialog`, scheme, false);
  await page.keyboard.press('Escape');

  // Narrow widths: the board is where a cramped layout shows first.
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto(`${BASE}/deals`);
  await settled(page);
  await shot(page, `${next()}-deals-board-800`, scheme);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/contacts`);
  await settled(page);
  await shot(page, `${next()}-contacts-390`, scheme);
  await page.setViewportSize(DESKTOP);

  await context.close();
}

/** The required states, produced by intercepting what the page asks the API. */
async function captureStates(
  browser: Browser,
  storage: Awaited<ReturnType<BrowserContext['storageState']>>,
  scheme: Scheme,
): Promise<void> {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: scheme,
    storageState: storage,
  });
  context.setDefaultTimeout(TIMEOUT);

  for (const [name, path, api] of [
    ['contacts', '/contacts', '**/api/proxy/**/contacts**'],
    ['deals', '/deals', '**/api/proxy/**/pipelines**'],
    ['my-day', '/my-day', '**/api/proxy/**/my-day**'],
  ] as const) {
    // Loading: the response is held back, so the skeleton is on screen.
    const loading = await context.newPage();
    await loading.route(api, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      await route.continue().catch(() => undefined);
    });
    await loading.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await loading.waitForTimeout(900);
    await shot(loading, `${next()}-state-${name}-loading`, scheme, false);
    await loading.close();

    // Error.
    const error = await context.newPage();
    await error.route(api, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL', message: 'x', requestId: 'r' } }),
      }),
    );
    await error.goto(`${BASE}${path}`);
    // Not `getByRole('alert')` alone: Next keeps an empty route announcer with
    // that role mounted, which would match at once. The query also retries a
    // failed request a few times before it gives up, so this can take seconds.
    await error.locator('main [role="alert"]').filter({ hasText: /S/ }).first().waitFor();
    await shot(error, `${next()}-state-${name}-error`, scheme, false);
    await error.close();

    // No permission.
    const forbidden = await context.newPage();
    await forbidden.route(api, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'x', requestId: 'r' } }),
      }),
    );
    await forbidden.goto(`${BASE}${path}`);
    await forbidden.waitForTimeout(1_500);
    await shot(forbidden, `${next()}-state-${name}-no-permission`, scheme, false);
    await forbidden.close();
  }

  // Empty: a search that matches nothing (the list itself is never empty in the seed).
  const empty = await context.newPage();
  await empty.goto(`${BASE}/contacts`);
  await settled(empty);
  await empty.getByRole('searchbox').fill('zzzz-no-such-contact');
  await empty.waitForTimeout(1_500);
  await shot(empty, `${next()}-state-contacts-no-results`, scheme, false);
  await empty.close();

  await context.close();
}

/**
 * The keyboard-first surfaces: the shortcut list, the `G` chip waiting for its
 * second key, a visible focus ring, the narrow-screen drawer and the collapsed
 * sidebar rail. Each is a state a static route screenshot never shows.
 */
async function captureKeyboard(
  browser: Browser,
  storage: Awaited<ReturnType<BrowserContext['storageState']>>,
  scheme: Scheme,
): Promise<void> {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: scheme,
    storageState: storage,
  });
  context.setDefaultTimeout(TIMEOUT);
  const page = await context.newPage();
  await page.goto(`${BASE}/deals`);
  await settled(page);
  await page.waitForTimeout(2_000); // let React hydrate before sending keys

  await page.keyboard.press('g');
  await page.waitForTimeout(250);
  await shot(page, `${next()}-keys-go-to-chip`, scheme, false);
  await page.waitForTimeout(1_600); // let the sequence window lapse

  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor();
  await shot(page, `${next()}-keys-shortcut-list`, scheme, false);
  await page.keyboard.press('Escape');

  // Focus ring: Tab to the first control after the skip link, and to a nav item.
  await page.goto(`${BASE}/contacts`);
  await settled(page);
  await page.waitForTimeout(1_500);
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab');
  await shot(page, `${next()}-keys-focus-ring`, scheme, false);

  // Collapsed rail on the deal board: the room it buys.
  await page.goto(`${BASE}/deals`);
  await settled(page);
  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await shot(page, `${next()}-deals-board-rail`, scheme);
  await page.getByRole('button', { name: 'Expand sidebar' }).click();

  // Narrow: the drawer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/deals`);
  await settled(page);
  await shot(page, `${next()}-deals-390`, scheme, false);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await shot(page, `${next()}-nav-drawer-390`, scheme, false);

  await context.close();
}

const browser = await chromium.launch();
try {
  if (process.env.ONLY === 'states') {
    const ownerContext = await signIn(browser, owner);
    const storage = await ownerContext.storageState();
    await ownerContext.close();
    for (const scheme of ['light', 'dark'] as const) {
      counter = 200;
      await captureStates(browser, storage, scheme);
    }
    process.exit(0);
  }
  if (process.env.ONLY === 'keyboard') {
    const ownerContext = await signIn(browser, owner);
    const storage = await ownerContext.storageState();
    await ownerContext.close();
    for (const scheme of ['light', 'dark'] as const) {
      counter = 400;
      await captureKeyboard(browser, storage, scheme);
    }
    process.exit(0);
  }
  await captureSignedOut(browser);

  const ownerContext = await signIn(browser, owner);
  const storage = await ownerContext.storageState();
  await ownerContext.close();

  for (const scheme of ['light', 'dark'] as const) {
    counter = 100;
    await captureApp(browser, storage, scheme);
    counter = 200;
    await captureStates(browser, storage, scheme);
    counter = 400;
    await captureKeyboard(browser, storage, scheme);
  }

  // A rep sees only their own records: the same list, narrower.
  const repContext = await signIn(browser, rep);
  const repPage = await repContext.newPage();
  await repPage.goto(`${BASE}/deals`);
  await settled(repPage);
  counter = 300;
  await shot(repPage, `${next()}-rep-deals-board`, 'light');
  await repContext.close();
} finally {
  await browser.close();
}
console.warn(`Screenshots written to ${outDir}`);
