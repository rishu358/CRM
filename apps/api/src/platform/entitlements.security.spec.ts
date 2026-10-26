import { newId, ConflictError, NotFoundError, ValidationError } from '@crm/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ExportsModule } from '../modules/exports/exports.module.js';
import { request, startApiHarness, type ApiHarness } from '../testing/harness.js';
import { EntitlementsOperator } from './entitlements-operator.service.js';

/**
 * Entitlements (ADR-0047, ADR-0010): the features a workspace has, enforced by the API.
 *
 * What must hold: switching a feature off for one workspace refuses it there (402) and nowhere else;
 * a person who may not do a thing is told 403 before they learn anything about the plan; a plan the
 * catalogue does not know includes nothing; a single-tenant installation has everything; and no
 * request path can change any of it.
 */
let multi: ApiHarness;
let single: ApiHarness;
let superuser: pg.Pool;
let operator: EntitlementsOperator;

interface Workspace {
  readonly tenantId: string;
  readonly slug: string;
  readonly admin: string;
  readonly readOnly: string;
}

const unique = (): string => newId().replaceAll('-', '').slice(-10);

async function workspace(harness: ApiHarness, label: string): Promise<Workspace> {
  const slug = `ent-${label}-${unique()}`;
  const { tenantId } = await harness.fixtures.createTenant({ name: `Entitled ${label}`, slug });
  const roles = await harness.provision(tenantId);
  const adminUser = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  const readOnlyUser = await harness.fixtures.createUser(tenantId, roles.get('Read-only')!);
  return {
    tenantId,
    slug,
    admin: await harness.signIn(adminUser.userId, tenantId),
    readOnly: await harness.signIn(readOnlyUser.userId, tenantId),
  };
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  multi = await startApiHarness(urls);
  single = await startApiHarness(urls, { DEPLOYMENT_MODE: 'single_tenant' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  operator = multi.app.get(EntitlementsOperator, { strict: false });
}, 240_000);

afterAll(async () => {
  await superuser.end();
  await multi.close();
  await single.close();
});

const exportFor = (harness: ApiHarness, token: string, headers?: Record<string, string>) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/exports',
    token,
    headers,
    body: { objectType: 'contact' },
  });

const importFor = (harness: ApiHarness, token: string) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/imports',
    token,
    body: { objectType: 'contact', fileName: 'people.csv', sizeBytes: 100 },
  });

const errorCode = (response: { body: Record<string, unknown> }): string | undefined =>
  (response.body['error'] as { code?: string } | undefined)?.code;

describe('a workspace on a plan', () => {
  it('has the features the plan includes, so nothing changed for anyone', async () => {
    const a = await workspace(multi, 'plain');
    expect((await exportFor(multi, a.admin)).status).toBe(202);
    expect((await importFor(multi, a.admin)).status).toBe(201);
  });

  it('loses a feature the operator withdraws, there and nowhere else', async () => {
    const a = await workspace(multi, 'withdrawn');
    const b = await workspace(multi, 'bystander');

    await operator.setOverride(a.slug, 'exports', false, 'contract suspended pending payment');

    const refused = await exportFor(multi, a.admin);
    expect(refused.status).toBe(402);
    expect(errorCode(refused)).toBe('ENTITLEMENT_REQUIRED');
    expect(JSON.stringify(refused.body)).toContain('exports');
    // Only the feature named, only the workspace named.
    expect((await importFor(multi, a.admin)).status).toBe(201);
    expect((await exportFor(multi, b.admin)).status).toBe(202);

    await operator.clearOverride(a.slug, 'exports');
    expect((await exportFor(multi, a.admin)).status).toBe(202);
  });

  it('refuses imports the same way', async () => {
    const a = await workspace(multi, 'noimports');
    await operator.setOverride(a.slug, 'imports', false, 'not part of their contract');
    const refused = await importFor(multi, a.admin);
    expect(refused.status).toBe(402);
    expect(errorCode(refused)).toBe('ENTITLEMENT_REQUIRED');
  });

  it('tells a person who may not export so (403) before it says anything about the plan', async () => {
    const a = await workspace(multi, 'permission-first');
    await operator.setOverride(a.slug, 'exports', false, 'testing the order of the checks');
    const response = await exportFor(multi, a.readOnly);
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('FORBIDDEN');
  });

  it('refuses a repeated request too, once the feature is withdrawn', async () => {
    const a = await workspace(multi, 'replay');
    const headers = { 'idempotency-key': `replay-${unique()}` };
    expect((await exportFor(multi, a.admin, headers)).status).toBe(202);

    await operator.setOverride(a.slug, 'exports', false, 'withdrawn after the first request');
    expect((await exportFor(multi, a.admin, headers)).status).toBe(402);
  });
});

describe('a plan the catalogue does not know', () => {
  it('includes nothing, and an override can still grant a feature', async () => {
    const a = await workspace(multi, 'mystery');
    await superuser.query(`update tenants set plan = 'platinum' where id = $1`, [a.tenantId]);

    expect((await exportFor(multi, a.admin)).status).toBe(402);
    expect((await importFor(multi, a.admin)).status).toBe(402);

    await operator.setOverride(a.slug, 'exports', true, 'pilot ahead of a plan existing for it');
    expect((await exportFor(multi, a.admin)).status).toBe(202);
    expect((await importFor(multi, a.admin)).status).toBe(402);
  });
});

describe('a single-tenant installation', () => {
  it('has every feature, whatever the plan says', async () => {
    const a = await workspace(single, 'owned');
    await superuser.query(`update tenants set plan = 'platinum' where id = $1`, [a.tenantId]);
    expect((await exportFor(single, a.admin)).status).toBe(202);
    expect((await importFor(single, a.admin)).status).toBe(201);
  });

  it('has every feature even if an override somehow exists', async () => {
    const a = await workspace(single, 'owned-override');
    await superuser.query(
      `insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
       values ($1, $2, 'exports', false, 'written behind the API')`,
      [newId(), a.tenantId],
    );
    expect((await exportFor(single, a.admin)).status).toBe(202);
  });

  it('refuses an exception, which would silently do nothing', async () => {
    const a = await workspace(single, 'no-exceptions');
    const singleOperator = single.app.get(EntitlementsOperator, { strict: false });
    await expect(
      singleOperator.setOverride(a.slug, 'exports', false, 'pointless'),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('the operator', () => {
  it('moves a workspace to a plan the catalogue knows, and refuses one it does not', async () => {
    const a = await workspace(multi, 'plans');
    const moved = await operator.setPlan(a.slug, 'pro');
    expect(moved.plan).toBe('pro');
    expect(moved.planKnown).toBe(true);

    await expect(operator.setPlan(a.slug, 'platinum')).rejects.toBeInstanceOf(ValidationError);
    expect((await operator.show(a.slug)).plan).toBe('pro');
  });

  it('must name a real workspace, a real feature, and give a reason', async () => {
    const a = await workspace(multi, 'strict');
    await expect(operator.show(`nowhere-${unique()}`)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      operator.setOverride(a.slug, 'time_travel', true, 'why not'),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(operator.setOverride(a.slug, 'exports', false, '   ')).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(operator.clearOverride(a.slug, 'exports')).rejects.toBeInstanceOf(NotFoundError);
    expect((await operator.show(a.slug)).overrides).toEqual([]);
  });

  it('replaces an earlier decision rather than adding a second, and shows why', async () => {
    const a = await workspace(multi, 'replace');
    await operator.setOverride(a.slug, 'exports', false, 'first reason');
    const shown = await operator.setOverride(a.slug, 'exports', true, 'second reason');
    expect(shown.overrides).toEqual([
      { feature: 'exports', enabled: true, reason: 'second reason' },
    ]);
    expect(shown.effective.exports).toBe(true);
  });
});

describe('who can change any of this', () => {
  it('is not something a business module can reach', () => {
    // The class is deliberately not exported by the platform module, so no controller or service can
    // take it as a dependency: a flaw in a request path cannot grant a workspace a feature.
    expect(() =>
      multi.app.select(ExportsModule).get(EntitlementsOperator, { strict: true }),
    ).toThrow();
  });

  it('is not an HTTP route', async () => {
    const a = await workspace(multi, 'no-route');
    for (const [method, url] of [
      ['GET', '/api/v1/entitlements'],
      ['DELETE', '/api/v1/entitlements'],
      ['PATCH', `/api/v1/tenants/${a.tenantId}`],
      ['POST', `/api/v1/tenants/${a.tenantId}/entitlements`],
    ] as const) {
      const response = await request(multi, { method, url, token: a.admin, body: {} });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    // And nothing changed behind the 4xx.
    expect((await operator.show(a.slug)).overrides).toEqual([]);
  });
});
