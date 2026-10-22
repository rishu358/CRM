import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * What the web tier refuses and what it tells the browser (CLAUDE.md §5, ADR-0040).
 *
 * Through a real production build, because a header set in code that Next never sends,
 * or a proxy rule a router rewrites before it runs, is a property of the whole stack.
 */
const credentials = JSON.parse(
  readFileSync(join(import.meta.dirname, '.credentials.json'), 'utf8'),
) as { owner: string; password: string };

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(credentials.owner);
  await page.getByLabel('Password').fill(credentials.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

test.describe('the credential proxy stays inside /api/v1', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  // None of these may be forwarded: the proxy attaches the session. Next resolves a
  // `%2e%2e` dot segment itself before any handler runs (a 404 for a route that is not
  // there); an encoded slash reaches the handler as one segment, and the proxy refuses it
  // with a 400 of its own. Either way the API is never asked.
  for (const path of [
    '/api/proxy/..%2Fhealth',
    '/api/proxy/%2e%2e%2Fhealth',
    '/api/proxy/%2E%2E%2Fhealth',
    '/api/proxy/contacts%2F..%2F..%2Fhealth',
    '/api/proxy/contacts/%2e%2e/%2e%2e/health',
    '/api/proxy/contacts%5C..%5Chealth',
  ]) {
    test(`does not forward ${path}`, async ({ page }) => {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect([400, 404]).toContain(response.status());
      expect(await response.text()).not.toMatch(/"status"s*:s*"ok"/);
    });
  }

  test('still serves the routes it is meant to', async ({ page }) => {
    const response = await page.request.get('/api/proxy/contacts?limit=1');
    expect(response.status()).toBe(200);
  });
});

test.describe('headers and the Content Security Policy', () => {
  test('every page carries the policy, with a nonce that is on the page and different each time', async ({
    request,
  }) => {
    const first = await request.get('/sign-in');
    const second = await request.get('/sign-in');
    const policy = first.headers()['content-security-policy'] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeDefined();
    expect(policy).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'(?:;|$)/);
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");

    // The same nonce the header names is on the page's own scripts.
    const html = await first.text();
    expect(html).toContain(`nonce="${nonce}"`);

    const otherNonce = /'nonce-([^']+)'/.exec(
      second.headers()['content-security-policy'] ?? '',
    )?.[1];
    expect(otherNonce).toBeDefined();
    expect(otherNonce).not.toBe(nonce);
  });

  test('carries the other headers a browser needs', async ({ request }) => {
    const headers = (await request.get('/sign-in')).headers();
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(headers['strict-transport-security']).not.toContain('preload');
  });

  test('the JSON handlers carry the static headers too', async ({ request }) => {
    const headers = (await request.get('/api/proxy/health')).headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
  });

  test('the browser enforces it: injected markup with no nonce does not run', async ({ page }) => {
    // What an XSS hole would give an attacker: markup in the page's own HTML that carries no
    // nonce. `page.evaluate` cannot stand in for it, because DevTools-injected script is
    // exempt from the page policy; so the markup is put into the real response, with the
    // real header, and the browser parses it like any other page.
    await page.addInitScript(() => {
      const holder = window as unknown as { __refused: string[] };
      holder.__refused = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        holder.__refused.push(event.violatedDirective);
      });
    });
    await page.route('**/sign-in', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '</body>',
        '<script>window.__bareRan = true</script>' +
          '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" onload="window.__inlineRan = true">' +
          '</body>',
      );
      await route.fulfill({ response, body });
    });
    await page.goto('/sign-in');
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    const state = await page.evaluate(() => {
      const w = window as unknown as {
        __bareRan?: boolean;
        __inlineRan?: boolean;
        __refused?: string[];
      };
      return {
        bare: w.__bareRan === true,
        inline: w.__inlineRan === true,
        refused: w.__refused ?? [],
      };
    });
    // Not only "it did not run" but "the browser said it refused": a script that fails for
    // some other reason would pass the first and not the second.
    expect(state.bare).toBe(false);
    expect(state.inline).toBe(false);
    expect(
      state.refused.filter((directive) => directive.startsWith('script-src')).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('no page the product uses is broken by it', async ({ page }) => {
    await page.addInitScript(() => {
      const violations: string[] = [];
      (window as unknown as { __violations: string[] }).__violations = violations;
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(
          `${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`,
        );
      });
    });
    const consoleViolations: string[] = [];
    page.on('console', (message) => {
      if (/content security policy/i.test(message.text())) consoleViolations.push(message.text());
    });

    await signIn(page);
    const seen: string[] = [];
    for (const path of [
      '/dashboard',
      '/my-day',
      '/contacts',
      '/leads',
      '/accounts',
      '/deals',
      '/import',
      '/settings/fields',
      '/settings/team',
      '/settings/security',
      '/settings/audit-log',
      '/setup',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      seen.push(
        ...(await page.evaluate(
          () => (window as unknown as { __violations: string[] }).__violations,
        )),
      );
    }

    // And a record page, which renders sanitised HTML and the attachment panel.
    await page.goto('/contacts');
    await page.getByRole('link', { name: 'Sharma' }).first().click();
    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
    await page.waitForLoadState('networkidle');
    seen.push(
      ...(await page.evaluate(
        () => (window as unknown as { __violations: string[] }).__violations,
      )),
    );

    expect(seen).toEqual([]);
    expect(consoleViolations).toEqual([]);
  });
});
