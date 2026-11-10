import { expect, test } from '@playwright/test';

/**
 * The page behind the link at the foot of every email (ADR-0076), in the real web app against the real API.
 *
 * What a browser can show here is the wiring: the page opens with no session, asks only when opened, says "not
 * valid" for a link the API does not recognise, and the confirm handler never claims success it did not get.
 * Doing it for a real email is covered where the token can be made: the API spec signs one and posts it, and
 * the worker spec applies the result. No test here sends mail, and none can read a token out of one.
 */

/** Well-formed, and signed by nobody: the API answers 404 to it, as it does to any link it did not issue. */
const FORGED = `v1.0197c5a2-1b6e-7f3a-9c0d-2e4f6a8b0c1d.${'A'.repeat(43)}`;

test.describe('the unsubscribe link', () => {
  test('opens with no sign-in, and says a link the installation did not issue is not valid', async ({
    page,
  }) => {
    await page.goto(`/u/${FORGED}`);
    await expect(page).toHaveURL(new RegExp(`/u/${FORGED.replaceAll('.', '\\.')}$`));
    await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
    // Nothing to press: a link that does not work never offers to do anything.
    await expect(page.getByRole('button', { name: 'Stop emails' })).toHaveCount(0);
  });

  test('says the same for something that is not a token at all', async ({ page }) => {
    await page.goto('/u/hello');
    await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
  });

  test('sends a post for a link that does not work back to the question, never on to "done"', async ({
    request,
  }) => {
    const response = await request.post(`/u/${FORGED}/confirm`, { maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()['location']).toBe(`/u/${FORGED}`);
    expect(response.headers()['cache-control']).toBe('no-store');
  });

  test('does not unsubscribe anyone just because the address is opened', async ({ request }) => {
    // A mail scanner opens every link in a message: a GET of the confirm address is not a thing.
    const response = await request.get(`/u/${FORGED}/confirm`, { maxRedirects: 0 });
    expect(response.status()).toBe(405);
  });

  test('is never kept by a search engine or sent on in a referrer', async ({ page }) => {
    await page.goto(`/u/${FORGED}`);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  });
});
