import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { AuthRepository } from '../auth/auth.repository.js';
import { AuthService } from '../auth/auth.service.js';
import { request, startApiHarness, type ApiHarness } from '../testing/harness.js';
import { runCreateWorkspace } from './create-workspace.js';

/**
 * The setup command against a real database (ADR-0046): what it creates is a complete workspace the
 * owner can sign in to, by the very code the sign-up form uses, and what it refuses, it refuses
 * without leaving a half-made account behind.
 */
let multi: ApiHarness;
let single: ApiHarness;

const PASSWORD = 'correct-horse-battery-staple';

function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

beforeAll(async () => {
  multi = await startApiHarness(inject('dbUrls'));
  single = await startApiHarness(inject('dbUrls'), { DEPLOYMENT_MODE: 'single_tenant' });
}, 240_000);

afterAll(async () => {
  await multi.close();
  await single.close();
});

async function run(
  harness: ApiHarness,
  argv: string[],
  password: string | null = PASSWORD,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCreateWorkspace({
    argv,
    auth: harness.app.get(AuthService),
    webUrl: () => harness.env.WEB_URL,
    password: () => Promise.resolve(password),
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const flags = (email: string, workspace = 'Acme Ltd') => [
  '--workspace',
  workspace,
  '--owner-email',
  email,
  '--owner-name',
  'A. Owner',
];

describe('creating a workspace from the command line', () => {
  it('makes a complete workspace whose owner can sign in and reach business data', async () => {
    const email = `${unique('owner')}@example.com`;
    const result = await run(multi, flags(email));

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Created workspace "Acme Ltd" \([0-9a-f-]{36}\)/);
    expect(result.out).toContain(`Owner: ${email}`);
    expect(result.out).toContain(`${multi.env.WEB_URL}/sign-in`);

    // Verified on creation: there is no inbox step, and no email was sent.
    expect(multi.emails.lastTo(email)).toBeUndefined();
    const signedIn = await request(multi, {
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      body: { email, password: PASSWORD },
    });
    expect(signedIn.status).toBe(200);
    const data = signedIn.body['data'] as { status: string; token: string };
    expect(data.status).toBe('signed_in');

    // A usable workspace, not just a row: the founder reaches a business endpoint, which only works
    // if roles and grants were provisioned exactly as sign-up does.
    const contacts = await request(multi, {
      method: 'GET',
      url: '/api/v1/contacts',
      token: data.token,
    });
    expect(contacts.status).toBe(200);
  });

  it('never prints the password, in success or in failure', async () => {
    const WEAK = 'Zq9-wk-x';
    const taken = `${unique('dup')}@example.com`;
    const ok = await run(multi, flags(`${unique('quiet')}@example.com`));
    const weak = await run(multi, flags(`${unique('weak')}@example.com`), WEAK);
    const first = await run(multi, flags(taken));
    const repeat = await run(multi, flags(taken));
    expect([ok.code, weak.code, first.code, repeat.code]).toEqual([0, 1, 0, 1]);
    for (const result of [ok, weak, first, repeat]) {
      expect(result.out + result.err).not.toContain(PASSWORD);
      expect(result.out + result.err).not.toContain(WEAK);
    }
  });

  it('refuses a password the sign-up form would refuse, and creates nothing', async () => {
    const email = `${unique('weak')}@example.com`;
    const workspace = unique('Weak Workspace');
    const result = await run(multi, flags(email, workspace), 'Zq9-wk-x');

    expect(result.code).toBe(1);
    expect(result.err).toContain('password');
    expect(await multi.fixtures.userExists(email)).toBe(false);
    expect(await multi.fixtures.tenantNamed(workspace)).toBe(false);
  });

  it('refuses an address that already has an account, and creates nothing', async () => {
    const email = `${unique('taken')}@example.com`;
    expect((await run(multi, flags(email))).code).toBe(0);

    const workspace = unique('Another Workspace');
    const second = await run(multi, flags(email, workspace));
    expect(second.code).toBe(1);
    expect(second.err).toContain('already exists');
    expect(await multi.fixtures.tenantNamed(workspace)).toBe(false);
  });

  it('is cancelled cleanly when the password prompt is aborted', async () => {
    const email = `${unique('abort')}@example.com`;
    const result = await run(multi, flags(email), null);
    expect(result.code).toBe(1);
    expect(result.err).toContain('Nothing was created');
    expect(await multi.fixtures.userExists(email)).toBe(false);
  });

  it('lets a multi-tenant installation create as many workspaces as it is asked for', async () => {
    const [first, second] = [unique('First'), unique('Second')];
    const one = await run(multi, flags(`${unique('a')}@example.com`, first));
    const two = await run(multi, flags(`${unique('b')}@example.com`, second));
    expect([one.code, two.code]).toEqual([0, 0]);
    expect(await multi.fixtures.tenantNamed(first)).toBe(true);
    expect(await multi.fixtures.tenantNamed(second)).toBe(true);
    const id = (out: string) => /\(([0-9a-f-]{36})\)/.exec(out)?.[1];
    expect(id(one.out)).toBeDefined();
    expect(id(one.out)).not.toBe(id(two.out));
  });
});

describe('on a single-tenant installation', () => {
  it('refuses to create a second workspace, and says how people join the first', async () => {
    // The shared test database already holds workspaces, so it is "already set up".
    expect(await single.fixtures.tenantCount()).toBeGreaterThan(0);
    const email = `${unique('second')}@example.com`;
    const workspace = unique('Second Workspace');

    const result = await run(single, flags(email, workspace));
    expect(result.code).toBe(1);
    expect(result.err).toContain('already has its workspace');
    expect(result.err).toContain('invitation');
    expect(await single.fixtures.userExists(email)).toBe(false);
    expect(await single.fixtures.tenantNamed(workspace)).toBe(false);
  });

  it('creates the one workspace while there is none', async () => {
    // An empty installation cannot be had in a database every suite shares, so the count the
    // service asks for is the one thing replaced; everything else is the real path.
    const repository = single.app.get(AuthRepository);
    const spy = vi.spyOn(repository, 'countTenants').mockResolvedValue(0);
    try {
      const email = `${unique('first')}@example.com`;
      const result = await run(single, flags(email, 'The Only Workspace'));
      expect(result.code).toBe(0);

      const signedIn = await request(single, {
        method: 'POST',
        url: '/api/v1/auth/sign-in',
        body: { email, password: PASSWORD },
      });
      expect(signedIn.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});
