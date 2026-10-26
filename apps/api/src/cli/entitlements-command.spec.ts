import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../testing/harness.js';
import { EntitlementsOperator } from '../platform/entitlements-operator.service.js';
import { runEntitlementsCommand } from './entitlements-command.js';

/**
 * The entitlements command against a real database (ADR-0047): each subcommand changes what the API
 * does for that workspace, and every refusal says why without touching anything.
 */
let harness: ApiHarness;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
}, 240_000);

afterAll(async () => {
  await harness.close();
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runEntitlementsCommand({
    argv,
    operator: () => Promise.resolve(harness.app.get(EntitlementsOperator, { strict: false })),
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

async function newWorkspace(label: string) {
  const slug = `cmd-${label}-${Math.random().toString(36).slice(2, 10)}`;
  const { tenantId } = await harness.fixtures.createTenant({ name: `Command ${label}`, slug });
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  return { slug, token: await harness.signIn(user.userId, tenantId) };
}

const exportStatus = async (token: string): Promise<number> =>
  (
    await request(harness, {
      method: 'POST',
      url: '/api/v1/exports',
      token,
      body: { objectType: 'contact' },
    })
  ).status;

describe('the entitlements command', () => {
  it('prints help and the feature list with no application running', async () => {
    const out: string[] = [];
    const code = await runEntitlementsCommand({
      argv: ['features'],
      operator: () => Promise.reject(new Error('must not start the application')),
      print: (line) => out.push(line),
      printError: () => undefined,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('exports');
  });

  it('revokes, shows, and clears, and the API follows each step', async () => {
    const ws = await newWorkspace('flow');
    expect(await exportStatus(ws.token)).toBe(202);

    const revoked = await run([
      'revoke',
      '--workspace',
      ws.slug,
      '--feature',
      'exports',
      '--reason',
      'suspended while the invoice is open',
    ]);
    expect(revoked.code).toBe(0);
    expect(revoked.out).toContain('off exports');
    expect(revoked.out).toContain('suspended while the invoice is open');
    expect(await exportStatus(ws.token)).toBe(402);

    const shown = await run(['show', '--workspace', ws.slug]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`(${ws.slug})`);
    expect(shown.out).toContain('plan: free');

    const cleared = await run(['clear', '--workspace', ws.slug, '--feature', 'exports']);
    expect(cleared.code).toBe(0);
    expect(cleared.out).toContain('none');
    expect(await exportStatus(ws.token)).toBe(202);
  });

  it('finds a workspace by the id tenant:create prints as well as by its slug', async () => {
    const slug = `cmd-byid-${Math.random().toString(36).slice(2, 10)}`;
    const { tenantId } = await harness.fixtures.createTenant({ name: 'Command by id', slug });
    const shown = await run(['show', '--workspace', tenantId]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`(${slug})`);
  });

  it('moves a workspace to a plan, and refuses a plan that does not exist', async () => {
    const ws = await newWorkspace('plan');
    const moved = await run(['plan', '--workspace', ws.slug, '--plan', 'enterprise']);
    expect(moved.code).toBe(0);
    expect(moved.out).toContain('plan: enterprise');

    const refused = await run(['plan', '--workspace', ws.slug, '--plan', 'platinum']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Unknown plan "platinum"');
    expect((await run(['show', '--workspace', ws.slug])).out).toContain('plan: enterprise');
  });

  it('refuses an unknown workspace and an unknown feature, changing nothing', async () => {
    const ws = await newWorkspace('refuse');
    const noWorkspace = await run(['show', '--workspace', 'nowhere-at-all']);
    expect(noWorkspace.code).toBe(1);
    expect(noWorkspace.err).toContain('Workspace not found');

    const noFeature = await run([
      'grant',
      '--workspace',
      ws.slug,
      '--feature',
      'time_travel',
      '--reason',
      'curiosity',
    ]);
    expect(noFeature.code).toBe(1);
    expect(noFeature.err).toContain('Unknown feature "time_travel"');
    expect((await run(['show', '--workspace', ws.slug])).out).toContain('none');
  });

  it('exits 2 for a command line it cannot understand, before starting anything', async () => {
    const result = await runEntitlementsCommand({
      argv: ['grant', '--workspace', 'acme'],
      operator: () => Promise.reject(new Error('must not start the application')),
      print: () => undefined,
      printError: () => undefined,
    });
    expect(result).toBe(2);
  });
});
