import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * The command palette, end to end (MVP_SPEC M7, CLAUDE.md §10).
 *
 * Two things are being checked here that no unit test can reach.
 *
 * The first is **that it works without a mouse at all**. MVP_SPEC §10 calls
 * the product keyboard-first, and a palette is the one screen where that is
 * not a nicety: somebody reaches for `Ctrl` + `K` precisely because their
 * hands are already on the keys. So the tests below open it, type, move and
 * choose using nothing but key presses, and the one that matters most never
 * calls `click` once.
 *
 * The second is that **what a rep sees is what the API let through**. The
 * seed gives the owner and the rep different records on purpose, so the same
 * query typed by two people has to come back different — through the browser,
 * the credential proxy, the permission engine and RLS, which is the only
 * place all of them are tested together.
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

  // Wait for the list, which is fetched in the browser — so a row on screen
  // is proof the bundle has hydrated. Every test here presses a key before
  // touching anything, and `Ctrl` + `K` is handled by a listener that does
  // not exist until then: without this the first press lands on a server-
  // rendered page and goes nowhere, which looks exactly like a broken
  // shortcut and is not one.
  await expect(page.getByText(/contacts loaded/)).toBeVisible();
}

/** The palette, once it is on screen. */
function palette(page: Page) {
  return page.getByRole('dialog', { name: 'Search and commands' });
}

test.describe('opening and closing', () => {
  test('opens on Ctrl+K and closes on Escape, keyboard only', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();

    // The caret is in the box already — a palette you have to click into is
    // not a keyboard shortcut, it is a button with extra steps.
    await expect(page.getByTestId('palette-input')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();

    // Focus goes back where it came from rather than to the top of the page.
    await expect(page.getByTestId('palette-trigger')).toBeFocused();
  });

  test('opens on / when the caret is not already in a field', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('/');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');

    // …and does not, when it is. Typing a slash into a search box has to
    // produce a slash.
    const search = page.getByLabel('Search contacts');
    await search.click();
    await search.press('/');
    await expect(palette(page)).toBeHidden();
    await expect(search).toHaveValue('/');
  });
});

test.describe('searching', () => {
  test('finds a seeded contact and opens it, without a mouse', async ({ page }) => {
    await signIn(page, credentials.owner);

    // From here to the record page, nothing but keys.
    //
    // "Reddy" rather than "Sharma": the seed deliberately gives one person
    // both a contact and a lead, so searching that name lands on whichever
    // ranks higher and the test would be asserting the ranking rather than
    // the navigation.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Reddy');

    const options = palette(page).getByTestId('palette-option');
    await expect(options.first()).toContainText('Reddy', { timeout: 10_000 });
    await page.keyboard.press('Enter');

    await page.waitForURL(/\/contacts\/[0-9a-f-]+$/);
    await expect(page.getByText('vikram.reddy@example.com')).toBeVisible();
  });

  test('reaches more than one kind of record from one query', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('Rajesh');

    const options = palette(page).getByTestId('palette-option');
    await expect(options.first()).toBeVisible({ timeout: 10_000 });
    // "Rajesh Gold House" is an account; the seed also hangs contacts and
    // deals off it, so the same word reaches more than one table.
    await expect(palette(page)).toContainText('Account');
  });

  test('moves with the arrow keys and says which row is current', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('Rajesh');

    const input = page.getByTestId('palette-input');
    const options = palette(page).getByTestId('palette-option');
    await expect(options.first()).toBeVisible({ timeout: 10_000 });

    // The ARIA combobox contract: focus stays in the input and
    // `aria-activedescendant` names the highlighted option, which is what a
    // screen reader reads out as the arrows move.
    const first = await input.getAttribute('aria-activedescendant');
    expect(first).not.toBeNull();
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    const second = await input.getAttribute('aria-activedescendant');
    expect(second).not.toBe(first);
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toBeFocused();

    // Up from the second row returns to the first; up again wraps to the end,
    // so a keyboard user can reach the bottom of the list in one press.
    await page.keyboard.press('ArrowUp');
    expect(await input.getAttribute('aria-activedescendant')).toBe(first);
    await page.keyboard.press('ArrowUp');
    await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  });

  test('says so when nothing matches, instead of showing an empty box', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('zzzqqqxxx');

    await expect(palette(page).getByRole('status')).toContainText('Nothing matches', {
      timeout: 10_000,
    });
  });

  test('waits for a second character before searching', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('a');

    await expect(palette(page).getByRole('status')).toContainText('Keep typing');
  });
});

test.describe('quick actions', () => {
  test('runs "New deal" from the keyboard and opens the form', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('New deal');

    const options = palette(page).getByTestId('palette-option');
    await expect(options.first()).toContainText('New deal');
    await page.keyboard.press('Enter');

    // The action is not just navigation: it carries an intent that the deals
    // screen picks up when it mounts (MVP_SPEC M7).
    await page.waitForURL('**/deals');
    await expect(page.getByRole('dialog', { name: 'New deal' })).toBeVisible();
  });

  test('offers "Go to settings" and goes there', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await page.keyboard.type('settings');

    await expect(palette(page).getByTestId('palette-option').first()).toContainText('settings');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/settings/**');
  });

  test('lists the commands before anything has been typed', async ({ page }) => {
    await signIn(page, credentials.owner);

    await page.keyboard.press('Control+k');
    await expect(palette(page).getByTestId('palette-option').first()).toBeVisible();
    await expect(palette(page)).toContainText('New deal');
    await expect(palette(page)).toContainText('Go to My Day');
  });
});

test.describe('what each person is allowed to find', () => {
  test('a rep does not find a colleague records through the palette', async ({ page }) => {
    // The seed gives "Rajesh Gold House" and its people to the owner, and a
    // different account to the rep. Same query, two people, two answers —
    // decided by the API, not by anything in the browser (ADR-0028).
    await signIn(page, credentials.owner);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Rajesh');
    await expect(palette(page).getByTestId('palette-option').first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(palette(page)).toContainText('Rajesh Gold House');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL('**/sign-in');

    await signIn(page, credentials.rep);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Rajesh');
    await expect(palette(page).getByRole('status')).toContainText('Nothing matches', {
      timeout: 10_000,
    });

    // The rep's own account is still reachable, so this is scope working
    // rather than search being broken for them.
    await page.getByTestId('palette-input').fill('Lotus');
    await expect(palette(page)).toContainText('Lotus Design Studio', { timeout: 10_000 });
  });
});
