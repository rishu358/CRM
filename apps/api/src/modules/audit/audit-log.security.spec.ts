import { AUDIT_DEFAULT_WINDOW_MS, newId } from '@crm/core';
import type { Tx } from '@crm/db';
import { typedPool, type TypedPool } from '@crm/db/testing';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';
import { CLOCK_CORRECTION_ALLOWANCE_MS, resolveWindow } from './audit-log.service.js';

/**
 * The audit viewer (MVP_SPEC M11, CLAUDE.md §5 and §10).
 *
 * The four mandatory per-module suites, plus the three this feature adds:
 *
 *   a. an administrator of one tenant cannot see another tenant's rows
 *   b. a non-administrator cannot reach the viewer at all
 *   c. **a field hidden from a role does not appear in the diffs shown to it**
 *
 * (c) is the one this module exists to get right. MVP_SPEC M3 names audit diffs
 * explicitly, and it is the read path where a leak is least likely to be
 * noticed: the field is stripped from the record everywhere, and the value
 * quietly survives in the history of the change that set it.
 */
let harness: ApiHarness;
let rawSuperuser: pg.Pool;
let superuser: TypedPool;

let tenantA: string;
let tenantB: string;
let rolesA: ReadonlyMap<string, string>;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let adminB: { token: string; userId: string };

async function userWithRole(tenantId: string, roleId: string) {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

/** Write an audit row directly, as a service would have inside its transaction. */
async function writeAudit(options: {
  tenantId: string;
  actorId?: string | null;
  action?: string;
  objectType?: string;
  recordId?: string | null;
  changes?: Record<string, unknown> | null;
}): Promise<string> {
  const id = newId();
  await superuser.query(
    `insert into audit_logs (id, tenant_id, actor_id, action, object_type, record_id, changes)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      options.tenantId,
      options.actorId ?? null,
      options.action ?? 'update',
      options.objectType ?? 'contact',
      options.recordId ?? newId(),
      options.changes === undefined ? null : JSON.stringify(options.changes),
    ],
  );
  return id;
}

const list = (token: string | undefined, query = '') =>
  request(harness, { method: 'GET', url: `/api/v1/audit-logs${query}`, token });

const idsOf = (response: { body: Record<string, unknown> }): string[] =>
  (response.body['data'] as { id: string }[]).map((row) => row.id);

const entryById = (
  response: { body: Record<string, unknown> },
  id: string,
): Record<string, unknown> | undefined =>
  (response.body['data'] as Record<string, unknown>[]).find((row) => row['id'] === id);

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls);
  rawSuperuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  superuser = typedPool(rawSuperuser);

  tenantA = (await harness.fixtures.createTenant({ name: 'Audit A' })).tenantId;
  rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Audit B' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await userWithRole(tenantA, rolesA.get('Admin')!);
  repA = await userWithRole(tenantA, rolesA.get('Sales Rep')!);
  adminB = await userWithRole(tenantB, rolesB.get('Admin')!);
});

afterAll(async () => {
  await rawSuperuser.end();
  await harness.close();
});

describe('authentication (CLAUDE.md §10d)', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await list(undefined);
    expect(response.status).toBe(401);
  });
});

describe('the capability is a row, not a role (CLAUDE.md §5.3)', () => {
  it('lets an Admin read the log', async () => {
    const response = await list(adminA.token);
    expect(response.status).toBe(200);
  });

  it('lets the Owner read the log', async () => {
    const owner = await userWithRole(tenantA, rolesA.get('Owner')!);
    expect((await list(owner.token)).status).toBe(200);
  });

  it('refuses a Sales Rep: no audit_log grant at all', async () => {
    const response = await list(repA.token);
    expect(response.status).toBe(403);
    expect((response.body['error'] as { code: string }).code).toBe('FORBIDDEN');
  });

  it('refuses a Manager and a Read-only role', async () => {
    const manager = await userWithRole(tenantA, rolesA.get('Manager')!);
    const readOnly = await userWithRole(tenantA, rolesA.get('Read-only')!);
    expect((await list(manager.token)).status).toBe(403);
    expect((await list(readOnly.token)).status).toBe(403);
  });

  it('refuses a role granted audit_log at a narrower scope than `all`', async () => {
    // `own` and `team` have no meaning on a log; a half-working scope is worse
    // than a refusal that says so.
    const roleId = await harness.fixtures.createRole(tenantA, `Scoped auditor ${newId()}`);
    await harness.fixtures.grant(tenantA, roleId, 'audit_log', 'read', 'own');
    const scoped = await userWithRole(tenantA, roleId);

    const response = await list(scoped.token);
    expect(response.status).toBe(403);
  });
});

describe('tenant isolation (CLAUDE.md §10a)', () => {
  it("an administrator cannot see another tenant's audit rows", async () => {
    const mine = await writeAudit({ tenantId: tenantA, actorId: adminA.userId });
    const theirs = await writeAudit({ tenantId: tenantB, actorId: adminB.userId });

    const response = await list(adminA.token, '?limit=100');
    expect(response.status).toBe(200);
    expect(idsOf(response)).toContain(mine);
    expect(idsOf(response)).not.toContain(theirs);

    const fromB = await list(adminB.token, '?limit=100');
    expect(idsOf(fromB)).toContain(theirs);
    expect(idsOf(fromB)).not.toContain(mine);
  });

  it('cannot be reached by naming the other tenant in a header', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/audit-logs',
      token: adminA.token,
      tenantId: tenantB,
    });
    expect([401, 403]).toContain(response.status);
  });
});

describe('field-level permissions on diffs (MVP_SPEC M3, CLAUDE.md §5.4)', () => {
  it('omits a hidden standard field and its values, and says how many were withheld', async () => {
    const auditorRole = await harness.fixtures.createRole(tenantA, `Blind auditor ${newId()}`);
    await harness.fixtures.grantAll(tenantA, auditorRole, 'contact', 'all');
    await harness.fixtures.grant(tenantA, auditorRole, 'audit_log', 'read', 'all');
    await harness.fixtures.setFieldPermission(tenantA, auditorRole, 'contact', 'email', 'hidden');
    const auditor = await userWithRole(tenantA, auditorRole);

    const rowId = await writeAudit({
      tenantId: tenantA,
      objectType: 'contact',
      changes: {
        lastName: { old: 'Rao', new: 'Rao-Patel' },
        email: { old: 'secret.old@example.com', new: 'secret.new@example.com' },
      },
    });

    const response = await list(auditor.token, '?limit=100&objectType=contact');
    const entry = entryById(response, rowId);

    expect(entry).toBeDefined();
    expect(Object.keys(entry!['changes'] as object)).toEqual(['lastName']);
    expect(entry!['withheldFields']).toBe(1);
    // The decisive assertion: the value is nowhere in the response body at all.
    expect(JSON.stringify(response.body)).not.toContain('secret.old@example.com');
    expect(JSON.stringify(response.body)).not.toContain('secret.new@example.com');
  });

  it('shows the same row in full to a reader who may read the field', async () => {
    const rowId = await writeAudit({
      tenantId: tenantA,
      objectType: 'contact',
      changes: { email: { old: 'visible.old@example.com', new: 'visible.new@example.com' } },
    });

    const response = await list(adminA.token, '?limit=100&objectType=contact');
    const entry = entryById(response, rowId);

    expect(entry).toBeDefined();
    expect(entry!['changes']).toEqual({
      email: { old: 'visible.old@example.com', new: 'visible.new@example.com' },
    });
    expect(entry!['withheldFields']).toBe(0);
  });

  it('omits a hidden custom field from inside the customFields blob', async () => {
    const auditorRole = await harness.fixtures.createRole(tenantA, `Custom auditor ${newId()}`);
    await harness.fixtures.grantAll(tenantA, auditorRole, 'contact', 'all');
    await harness.fixtures.grant(tenantA, auditorRole, 'audit_log', 'read', 'all');
    await harness.fixtures.setFieldPermission(
      tenantA,
      auditorRole,
      'contact',
      'pan_number',
      'hidden',
    );
    const auditor = await userWithRole(tenantA, auditorRole);

    const rowId = await writeAudit({
      tenantId: tenantA,
      objectType: 'contact',
      changes: {
        customFields: {
          old: { segment: 'SMB', pan_number: 'HIDDEN1234F' },
          new: { segment: 'Enterprise', pan_number: 'HIDDEN9999Z' },
        },
      },
    });

    const response = await list(auditor.token, '?limit=100&objectType=contact');
    const entry = entryById(response, rowId);

    expect(Object.keys(entry!['changes'] as object)).toEqual(['customFields.segment']);
    expect(JSON.stringify(response.body)).not.toContain('HIDDEN1234F');
    expect(JSON.stringify(response.body)).not.toContain('HIDDEN9999Z');
  });

  it('hides rows about an object type the reader has no grant on', async () => {
    // Reading history must not give back access the role was not granted.
    const auditorRole = await harness.fixtures.createRole(tenantA, `Contacts auditor ${newId()}`);
    await harness.fixtures.grantAll(tenantA, auditorRole, 'contact', 'all');
    await harness.fixtures.grant(tenantA, auditorRole, 'audit_log', 'read', 'all');
    const auditor = await userWithRole(tenantA, auditorRole);

    const dealRow = await writeAudit({
      tenantId: tenantA,
      objectType: 'deal',
      changes: { name: { old: 'Q3 renewal', new: 'Q4 renewal' } },
    });
    const contactRow = await writeAudit({ tenantId: tenantA, objectType: 'contact' });

    const response = await list(auditor.token, '?limit=100');
    expect(idsOf(response)).toContain(contactRow);
    expect(idsOf(response)).not.toContain(dealRow);
    expect(JSON.stringify(response.body)).not.toContain('Q4 renewal');
  });
});

describe('filters', () => {
  it('filters by actor, object type, action and record', async () => {
    const recordId = newId();
    const wanted = await writeAudit({
      tenantId: tenantA,
      actorId: adminA.userId,
      action: 'delete',
      objectType: 'contact',
      recordId,
    });
    const other = await writeAudit({
      tenantId: tenantA,
      actorId: repA.userId,
      action: 'create',
      objectType: 'lead',
    });

    const byActor = await list(adminA.token, `?limit=100&actorId=${adminA.userId}`);
    expect(idsOf(byActor)).toContain(wanted);
    expect(idsOf(byActor)).not.toContain(other);

    const byAction = await list(adminA.token, '?limit=100&action=delete&objectType=contact');
    expect(idsOf(byAction)).toContain(wanted);

    const byRecord = await list(adminA.token, `?limit=100&objectType=contact&recordId=${recordId}`);
    expect(idsOf(byRecord)).toEqual([wanted]);
  });

  it('defaults to a bounded window and honours an explicit one', async () => {
    const old = newId();
    await superuser.query(
      `insert into audit_logs (id, tenant_id, action, object_type, record_id, occurred_at)
       values ($1, $2, 'update', 'contact', $3, now() - interval '200 days')`,
      [old, tenantA, newId()],
    );

    const defaulted = await list(adminA.token, '?limit=100');
    expect(idsOf(defaulted)).not.toContain(old);

    const widened = await list(
      adminA.token,
      `?limit=100&from=${new Date(Date.now() - 365 * 86_400_000).toISOString()}`,
    );
    expect(idsOf(widened)).toContain(old);
  });

  it("ends the default window at the database's clock, not this process's", async () => {
    // `occurred_at` is stamped by Postgres, and the window used to end at this
    // process's own `new Date()`. When the two disagree the newest rows fall
    // outside the window — in an audit log, the last thing that happened missing
    // from the view whose job is to show it.
    //
    // A real skew cannot be produced from inside a test: the API and the database
    // share this machine's clock, so `new Date()` is never behind a stamp.
    // (An integration test written that way passes against the broken code, which
    // was tried first and is why this is a unit-level check.) So the window is
    // resolved against a stand-in transaction whose clock is an hour ahead, and
    // the bound must follow *it*.
    const databaseClock = new Date(Date.now() + 60 * 60 * 1000);
    const tx = {
      execute: () => Promise.resolve({ rows: [{ now: databaseClock.toISOString() }] }),
    } as unknown as Tx;

    const window = await resolveWindow(tx, { limit: 50 });

    // The database's clock plus the allowance for it stepping backwards — and
    // nothing to do with this process's clock, which is an hour behind here.
    expect(window.to.getTime()).toBe(databaseClock.getTime() + CLOCK_CORRECTION_ALLOWANCE_MS);
    // And the lower edge is derived from that bound, so the window keeps its width.
    expect(window.to.getTime() - window.from.getTime()).toBe(AUDIT_DEFAULT_WINDOW_MS);
  });

  it('uses an explicit upper bound exactly as given, without asking the database', async () => {
    let asked = false;
    const tx = {
      execute: () => {
        asked = true;
        return Promise.resolve({ rows: [{ now: new Date().toISOString() }] });
      },
    } as unknown as Tx;

    const to = '2026-03-01T00:00:00.000Z';
    const window = await resolveWindow(tx, { limit: 50, to });

    expect(window.to.toISOString()).toBe(to);
    expect(asked).toBe(false);
  });

  it('still shows a row stamped ahead of the database clock, as a backward clock step leaves it', async () => {
    // The Docker VM's clock runs slightly ahead and then steps back by up to about
    // 1.2 s (ADR-0036). A row written just before a step is stamped *ahead of the
    // database's own clock* by the time the next request reads it, and a window
    // ending at "the database's now" excludes it — a freshly written audit row
    // missing from the one view that exists to show it. This is that state, made
    // on demand: a row stamped two seconds ahead of the clock the viewer reads.
    const ahead = newId();
    await superuser.query(
      `insert into audit_logs (id, tenant_id, action, object_type, record_id, occurred_at)
       values ($1, $2, 'update', 'contact', $3, clock_timestamp() + interval '2 seconds')`,
      [ahead, tenantA, newId()],
    );

    const response = await list(adminA.token, '?limit=100');

    expect(response.status).toBe(200);
    expect(idsOf(response)).toContain(ahead);
  });

  it("keeps the archive's clock allowance equal to the viewer's", () => {
    // The worker may not import the API (ADR-0001), so the figure is written in
    // both places. Two windows that differ would make the exported file and the
    // screen disagree about which rows are recent, so the copy is checked here.
    const source = readFileSync(
      new URL('../../../../worker/src/data-rights/archive-handler.ts', import.meta.url),
      'utf8',
    );
    const match = /export const CLOCK_CORRECTION_ALLOWANCE_MS = ([\d_]+);/.exec(source);
    expect(match, 'the worker no longer declares CLOCK_CORRECTION_ALLOWANCE_MS').not.toBeNull();
    expect(Number((match?.[1] ?? '').replaceAll('_', ''))).toBe(CLOCK_CORRECTION_ALLOWANCE_MS);
  });

  it('rejects an unknown action or object type at the boundary', async () => {
    expect((await list(adminA.token, '?action=drop_tables')).status).toBe(422);
    expect((await list(adminA.token, '?objectType=pg_catalog')).status).toBe(422);
  });

  it('rejects a window that ends before it starts', async () => {
    const response = await list(adminA.token, '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z');
    expect(response.status).toBe(422);
  });
});

describe('pagination (ADR-0012)', () => {
  it('pages by keyset without repeating or dropping a row', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Audit paging' })).tenantId;
    const roles = await harness.provision(tenant);
    const admin = await userWithRole(tenant, roles.get('Admin')!);

    // The ids are kept: asserting on *these* rows, not on a count, is what lets a
    // failure say which ones went missing rather than "expected 6 to be at least 7".
    const written: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      written.push(await writeAudit({ tenantId: tenant, objectType: 'contact' }));
    }

    const seen: string[] = [];
    const pages: { status: number; count: number; hasMore: boolean }[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response: { status: number; body: Record<string, unknown> } = await list(
        admin.token,
        `?limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const ids = idsOf(response);
      const meta = response.body['meta'] as { nextCursor: string | null; hasMore: boolean };
      pages.push({ status: response.status, count: ids.length, hasMore: meta.hasMore });
      seen.push(...ids);
      if (!meta.hasMore) break;
      cursor = meta.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);

    const missing = written.filter((id) => !seen.includes(id));
    if (missing.length > 0) {
      // Everything needed to see why, gathered at the moment it happens: what the
      // database holds for this tenant, what time it thinks it is, and what each
      // page returned.
      const stored = await superuser.query(
        `select id, action, object_type, occurred_at::text as occurred_at
         from audit_logs where tenant_id = $1 order by id`,
        [tenant],
      );
      const clock = await superuser.query('select clock_timestamp()::text as now');
      throw new Error(
        `${missing.length} of ${written.length} written audit rows were not returned.
` +
          `missing: ${missing.join(', ')}
` +
          `pages: ${JSON.stringify(pages)}
` +
          `database clock now: ${JSON.stringify(clock.rows[0])}
` +
          `stored for the tenant: ${JSON.stringify(stored.rows)}`,
      );
    }
  });

  it('rejects a malformed cursor rather than failing in the database', async () => {
    expect((await list(adminA.token, '?cursor=not-a-cursor')).status).toBe(422);
  });
});
