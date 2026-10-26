import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * What a bulk call does and reports (ADR-0056), for each action, both kinds of target, the cap,
 * the dry run and the retry memory. The permission rules are in `bulk.security.spec.ts`.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };
let rep: { token: string; userId: string };

interface Result {
  objectType: string;
  action: string;
  dryRun: boolean;
  matched: number;
  changed: number;
  changedIds: string[];
  skipped: { id: string; reason: string; message?: string }[];
  nextCursor: string | null;
  replayed: boolean;
}

const bulk = (body: unknown, options: { token?: string; key?: string } = {}) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/bulk-actions',
    token: options.token ?? admin.token,
    body,
    ...(options.key === undefined ? {} : { headers: { 'idempotency-key': options.key } }),
  });

const run = async (body: unknown, options: { token?: string; key?: string } = {}) =>
  dataOf<Result>(await bulk(body, options), 200);

const get = async (path: string) =>
  dataOf<Record<string, unknown>>(
    await request(harness, { method: 'GET', url: `/api/v1/${path}`, token: admin.token }),
  );

async function makeContacts(count: number, prefix: string, ownerId = admin.userId) {
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    created.push(
      await harness.fixtures.createContact(tenantId, {
        ownerId,
        lastName: `${prefix}${String(index).padStart(3, '0')}`,
      }),
    );
  }
  return created;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const roles = await harness.provision(tenantId);

  const adminUser = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: adminUser.userId, token: await harness.signIn(adminUser.userId, tenantId) };
  const repUser = await harness.fixtures.createUser(tenantId, roles.get('Sales Rep')!);
  rep = { userId: repUser.userId, token: await harness.signIn(repUser.userId, tenantId) };

  await harness.fixtures.createCustomField(tenantId, 'contact', 'region', 'text', 'Region');
});

afterAll(async () => {
  await harness.close();
});

describe('request shape', () => {
  it('refuses an unknown action, an unknown key, an empty target and more than the cap', async () => {
    const some = [crypto.randomUUID()];
    const cases: unknown[] = [
      { objectType: 'contact', action: 'explode', target: { kind: 'ids', ids: some } },
      { objectType: 'contact', action: 'delete', extra: true, target: { kind: 'ids', ids: some } },
      { objectType: 'contact', action: 'delete', target: { kind: 'ids', ids: [] } },
      {
        objectType: 'contact',
        action: 'delete',
        target: { kind: 'ids', ids: Array.from({ length: 201 }, () => crypto.randomUUID()) },
      },
      { objectType: 'activity', action: 'delete', target: { kind: 'ids', ids: some } },
      { objectType: 'contact', action: 'edit', changes: {}, target: { kind: 'ids', ids: some } },
      { objectType: 'contact', action: 'tag_add', tags: [], target: { kind: 'ids', ids: some } },
      {
        objectType: 'contact',
        action: 'tag_add',
        tags: ['a', 'b', 'c', 'd', 'e', 'f'],
        target: { kind: 'ids', ids: some },
      },
      {
        objectType: 'contact',
        action: 'tag_add',
        tags: ['Vip', 'vip'],
        target: { kind: 'ids', ids: some },
      },
    ];
    for (const body of cases) {
      const response = await bulk(body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(422);
    }
  });

  it('refuses a malformed Idempotency-Key', async () => {
    const response = await bulk(
      {
        objectType: 'contact',
        action: 'delete',
        target: { kind: 'ids', ids: [crypto.randomUUID()] },
      },
      { key: 'has spaces' },
    );
    expect(response.status).toBe(422);
  });
});

describe('edit', () => {
  it('changes the named fields on every record, moves each version, audits and announces each', async () => {
    const [a, b, c] = await makeContacts(3, 'Edit');
    const before = (await harness.fixtures.auditEntries(tenantId, 'contact')).length;

    const result = await run({
      objectType: 'contact',
      action: 'edit',
      changes: { title: 'Director', lead_source: 'referral', region: 'North' },
      target: { kind: 'ids', ids: [a, b, c] },
    });
    expect(result).toMatchObject({ matched: 3, changed: 3, skipped: [], replayed: false });

    for (const id of [a, b, c]) {
      const contact = await get(`contacts/${id}`);
      expect(contact['title']).toBe('Director');
      expect(contact['leadSource']).toBe('referral');
      expect(contact['customFields']).toMatchObject({ region: 'North' });
      expect(contact['version']).toBe(2);
    }

    const audit = await harness.fixtures.auditEntries(tenantId, 'contact');
    expect(audit.length - before).toBe(3);
    const events = await harness.fixtures.outboxEvents(tenantId, 'contact.updated.v1');
    expect(events.map((event) => event.recordId)).toEqual(expect.arrayContaining([a, b, c]));
  });

  it('is a 422 for the whole request when a value is wrong, and touches nothing', async () => {
    const [a] = await makeContacts(1, 'Bad');
    const response = await bulk({
      objectType: 'contact',
      action: 'edit',
      changes: { account_id: 'not-an-id' },
      target: { kind: 'ids', ids: [a] },
    });
    expect(response.status).toBe(422);
    expect((await get(`contacts/${a}`))['version']).toBe(1);
  });

  it('clears a field with null', async () => {
    const [a] = await makeContacts(1, 'Clear');
    await run({
      objectType: 'contact',
      action: 'edit',
      changes: { title: 'Temp' },
      target: { kind: 'ids', ids: [a] },
    });
    await run({
      objectType: 'contact',
      action: 'edit',
      changes: { title: null },
      target: { kind: 'ids', ids: [a] },
    });
    expect((await get(`contacts/${a}`))['title'] ?? null).toBeNull();
  });

  it('reports a record that breaks a rule as invalid and still changes the rest', async () => {
    const open = await harness.fixtures.createLead(tenantId, { ownerId: admin.userId });
    const converted = await harness.fixtures.createLead(tenantId, {
      ownerId: admin.userId,
      status: 'converted',
      convertedAt: new Date(),
    });
    const result = await run({
      objectType: 'lead',
      action: 'edit',
      changes: { source: 'trade-show' },
      target: { kind: 'ids', ids: [open, converted] },
    });
    expect(result.changedIds).toEqual([open]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ id: converted, reason: 'invalid' });
    expect(result.skipped[0]?.message).toBeTruthy();
    expect((await get(`leads/${open}`))['source']).toBe('trade-show');
  });

  it('edits accounts and deals through their own rules', async () => {
    const account = await harness.fixtures.createAccount(tenantId, { ownerId: admin.userId });
    const [pipeline] = await harness.fixtures.pipelinesFor(tenantId);
    const stage = pipeline!.stages.find((s) => s.stageType === 'open')!;
    const deal = await harness.fixtures.createDeal(tenantId, {
      ownerId: admin.userId,
      pipelineId: pipeline!.id,
      stageId: stage.id,
    });

    const a = await run({
      objectType: 'account',
      action: 'edit',
      changes: { industry: 'Jewellery' },
      target: { kind: 'ids', ids: [account] },
    });
    expect(a.changed).toBe(1);
    expect((await get(`accounts/${account}`))['industry']).toBe('Jewellery');

    const d = await run({
      objectType: 'deal',
      action: 'edit',
      changes: { expected_close_date: '2027-03-31' },
      target: { kind: 'ids', ids: [deal] },
    });
    expect(d.changed).toBe(1);
    expect((await get(`deals/${deal}`))['expectedCloseDate']).toBe('2027-03-31');
  });
});

describe('delete', () => {
  it('soft-deletes, audits and announces each record, and the Recycle Bin lists them', async () => {
    const [a, b] = await makeContacts(2, 'Del');
    const result = await run({
      objectType: 'contact',
      action: 'delete',
      target: { kind: 'ids', ids: [a, b] },
    });
    expect(result.changed).toBe(2);

    for (const id of [a, b]) {
      expect(
        (
          await request(harness, {
            method: 'GET',
            url: `/api/v1/contacts/${id}`,
            token: admin.token,
          })
        ).status,
      ).toBe(404);
    }
    const events = await harness.fixtures.outboxEvents(tenantId, 'contact.deleted.v1');
    expect(events.map((event) => event.recordId)).toEqual(expect.arrayContaining([a, b]));
    const audit = await harness.fixtures.auditEntries(tenantId, 'contact');
    expect(audit.filter((entry) => entry.action === 'delete').map((e) => e.recordId)).toEqual(
      expect.arrayContaining([a, b]),
    );

    const bin = dataOf<{ id: string }[]>(
      await request(harness, {
        method: 'GET',
        url: '/api/v1/recycle-bin?objectType=contact',
        token: admin.token,
      }),
    );
    expect(bin.map((entry) => entry.id)).toEqual(expect.arrayContaining([a, b]));
  });

  it('reports an id that is already deleted as not found', async () => {
    const [a] = await makeContacts(1, 'Twice');
    const body = { objectType: 'contact', action: 'delete', target: { kind: 'ids', ids: [a] } };
    expect((await run(body)).changed).toBe(1);
    const again = await run(body);
    expect(again.changed).toBe(0);
    expect(again.skipped).toEqual([{ id: a, reason: 'not_found' }]);
  });
});

describe('assign', () => {
  it('moves records to the new owner, and says which were already theirs', async () => {
    const [a, b] = await makeContacts(2, 'Own');
    const already = await harness.fixtures.createContact(tenantId, {
      ownerId: rep.userId,
      lastName: 'AlreadyRep',
    });
    const result = await run({
      objectType: 'contact',
      action: 'assign',
      ownerId: rep.userId,
      target: { kind: 'ids', ids: [a, b, already] },
    });
    expect(new Set(result.changedIds)).toEqual(new Set([a, b]));
    expect(result.skipped).toEqual([{ id: already, reason: 'no_change' }]);
    expect((await get(`contacts/${a}`))['ownerId']).toBe(rep.userId);
    expect((await get(`contacts/${a}`))['version']).toBe(2);

    const audit = await harness.fixtures.auditEntries(tenantId, 'contact');
    expect(audit.some((entry) => entry.recordId === a && entry.action === 'update')).toBe(true);
  });

  it('refuses an owner who is not a member of the workspace', async () => {
    const [a] = await makeContacts(1, 'Stranger');
    const response = await bulk({
      objectType: 'contact',
      action: 'assign',
      ownerId: crypto.randomUUID(),
      target: { kind: 'ids', ids: [a] },
    });
    expect(response.status).toBe(422);
  });
});

describe('tags', () => {
  it('creates a tag on first use, reuses it whatever the case, and says when nothing changed', async () => {
    const [a, b] = await makeContacts(2, 'Tag');
    const first = await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['VIP'],
      target: { kind: 'ids', ids: [a, b] },
    });
    expect(first.changed).toBe(2);
    const tagsAfterFirst = await harness.fixtures.tagCount(tenantId);

    const again = await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['vip'],
      target: { kind: 'ids', ids: [a, b] },
    });
    expect(again.changed).toBe(0);
    expect(again.skipped.map((s) => s.reason)).toEqual(['no_change', 'no_change']);
    expect(await harness.fixtures.tagCount(tenantId)).toBe(tagsAfterFirst);
    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', a)).toEqual(['VIP']);

    const listed = dataOf<{ name: string }[]>(
      await request(harness, { method: 'GET', url: '/api/v1/tags', token: admin.token }),
    );
    expect(listed.map((tag) => tag.name)).toContain('VIP');
  });

  it('removes a tag from the records that have it', async () => {
    const [a, b] = await makeContacts(2, 'Untag');
    await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Cold', 'Warm'],
      target: { kind: 'ids', ids: [a, b] },
    });
    const removed = await run({
      objectType: 'contact',
      action: 'tag_remove',
      tags: ['cold'],
      target: { kind: 'ids', ids: [a] },
    });
    expect(removed.changedIds).toEqual([a]);
    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', a)).toEqual(['Warm']);
    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', b)).toEqual(['Cold', 'Warm']);

    // Removing a tag that does not exist is "nothing to do", not an error and not a new tag.
    const count = await harness.fixtures.tagCount(tenantId);
    const ghost = await run({
      objectType: 'contact',
      action: 'tag_remove',
      tags: ['Never existed'],
      target: { kind: 'ids', ids: [a] },
    });
    expect(ghost.skipped).toEqual([{ id: a, reason: 'no_change' }]);
    expect(await harness.fixtures.tagCount(tenantId)).toBe(count);
  });

  it('audits and announces a tag change on the record, like any other edit', async () => {
    const [a] = await makeContacts(1, 'Audited');
    await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Audit me'],
      target: { kind: 'ids', ids: [a] },
    });
    const audit = (await harness.fixtures.auditEntries(tenantId, 'contact')).find(
      (entry) => entry.recordId === a,
    );
    expect(audit?.changes).toEqual({ tags: { new: ['Audit me'] } });
    const events = await harness.fixtures.outboxEvents(tenantId, 'contact.updated.v1');
    expect(events.find((event) => event.recordId === a)?.payload).toEqual({
      changedFields: ['tags'],
    });
    const creation = await harness.fixtures.outboxEvents(tenantId, 'tag.created.v1');
    expect(creation.length).toBeGreaterThan(0);
  });
});

describe('filter targets, the cap and the cursor', () => {
  it('acts on what the conditions match, and only that', async () => {
    const matching = await makeContacts(3, 'Zeta');
    const other = await makeContacts(2, 'Omega');
    const result = await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Zeta group'],
      target: {
        kind: 'filter',
        filter: { conditions: [{ field: 'last_name', operator: 'starts_with', value: 'Zeta' }] },
      },
    });
    expect(new Set(result.changedIds)).toEqual(new Set(matching));
    expect(result.nextCursor).toBeNull();
    for (const id of other) {
      expect(await harness.fixtures.recordTagNames(tenantId, 'contact', id)).toEqual([]);
    }
  });

  it('works on a custom field', async () => {
    const [a, b] = await makeContacts(2, 'Region');
    await run({
      objectType: 'contact',
      action: 'edit',
      changes: { region: 'Far East' },
      target: { kind: 'ids', ids: [a] },
    });
    const result = await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Far east'],
      target: {
        kind: 'filter',
        filter: { conditions: [{ field: 'region', operator: 'eq', value: 'Far East' }] },
      },
    });
    expect(result.changedIds).toEqual([a]);
    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', b)).toEqual([]);
  });

  it('handles at most 200 per call and hands back a cursor for the rest', async () => {
    await makeContacts(205, 'Many');
    const body = (after?: string) => ({
      objectType: 'contact',
      action: 'delete',
      target: {
        kind: 'filter',
        filter: { conditions: [{ field: 'last_name', operator: 'starts_with', value: 'Many' }] },
        ...(after === undefined ? {} : { after }),
      },
    });

    const dry = await run({ ...body(), dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, matched: 200, changed: 200 });
    expect(dry.nextCursor).not.toBeNull();

    const first = await run(body());
    expect(first.changed).toBe(200);
    expect(first.nextCursor).not.toBeNull();
    const second = await run(body(first.nextCursor!));
    expect(second.changed).toBe(5);
    expect(second.nextCursor).toBeNull();
  }, 120_000);

  it('refuses a filter on a field that does not exist', async () => {
    const response = await bulk({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['x'],
      target: {
        kind: 'filter',
        filter: { conditions: [{ field: 'no_such_field', operator: 'eq', value: 'x' }] },
      },
    });
    expect(response.status).toBe(422);
  });
});

describe('dry run', () => {
  it('reports what would happen and changes, audits and announces nothing', async () => {
    const [a, b] = await makeContacts(2, 'Dry');
    const missing = crypto.randomUUID();
    const auditBefore = (await harness.fixtures.auditEntries(tenantId, 'contact')).length;
    const tagsBefore = await harness.fixtures.tagCount(tenantId);

    const result = await run({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Dry run tag'],
      dryRun: true,
      target: { kind: 'ids', ids: [a, b, missing] },
    });
    expect(result).toMatchObject({ dryRun: true, matched: 3, changed: 2 });
    expect(result.skipped).toEqual([{ id: missing, reason: 'not_found' }]);

    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', a)).toEqual([]);
    expect(await harness.fixtures.tagCount(tenantId)).toBe(tagsBefore);
    expect((await harness.fixtures.auditEntries(tenantId, 'contact')).length).toBe(auditBefore);

    const del = await run({
      objectType: 'contact',
      action: 'delete',
      dryRun: true,
      target: { kind: 'ids', ids: [a] },
    });
    expect(del.changed).toBe(1);
    expect((await get(`contacts/${a}`))['id']).toBe(a);
  });
});

describe('Idempotency-Key', () => {
  const key = 'retry-after-timeout-1';

  it('replays the stored answer instead of doing the work again', async () => {
    const [a] = await makeContacts(1, 'Idem');
    const body = {
      objectType: 'contact',
      action: 'edit',
      changes: { title: 'First' },
      target: { kind: 'ids', ids: [a] },
    };

    const first = await run(body, { key });
    expect(first).toMatchObject({ changed: 1, replayed: false });

    // Somebody else edits the record in between; the retry must not overwrite them.
    const current = await get(`contacts/${a}`);
    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${a}`,
      token: admin.token,
      body: { title: 'Second', version: current['version'] },
    });

    const retry = await run(body, { key });
    expect(retry).toMatchObject({ changed: 1, replayed: true, changedIds: [a] });
    expect((await get(`contacts/${a}`))['title']).toBe('Second');
  });

  it('refuses the same key for a different request', async () => {
    const [a] = await makeContacts(1, 'Idem2');
    const body = (title: string) => ({
      objectType: 'contact',
      action: 'edit',
      changes: { title },
      target: { kind: 'ids', ids: [a] },
    });
    await run(body('One'), { key: 'reuse-key-1' });
    const other = await bulk(body('Two'), { key: 'reuse-key-1' });
    expect(other.status).toBe(409);
    expect((await get(`contacts/${a}`))['title']).toBe('One');
  });

  it('is per person: the same key from somebody else is a separate operation', async () => {
    const owned = await harness.fixtures.createContact(tenantId, {
      ownerId: rep.userId,
      lastName: 'RepOwned',
    });
    const mine = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'AdminOwned',
    });
    const body = (id: string) => ({
      objectType: 'contact',
      action: 'edit',
      changes: { title: 'Shared key' },
      target: { kind: 'ids', ids: [id] },
    });
    const a = await run(body(mine), { key: 'shared-key' });
    const r = await run(body(owned), { key: 'shared-key', token: rep.token });
    expect(a.replayed).toBe(false);
    expect(r.replayed).toBe(false);
    expect(r.changedIds).toEqual([owned]);
  });

  it('does not remember a dry run, and forgets keys after the retention window', async () => {
    const [a] = await makeContacts(1, 'Idem3');
    const body = (dryRun: boolean) => ({
      objectType: 'contact',
      action: 'tag_add',
      tags: ['Keyed'],
      dryRun,
      target: { kind: 'ids', ids: [a] },
    });
    await run(body(true), { key: 'dry-key' });
    expect(await harness.fixtures.bulkOperationKeys(tenantId, admin.userId)).not.toContain(
      'dry-key',
    );

    await run(body(false), { key: 'old-key' });
    expect(await harness.fixtures.bulkOperationKeys(tenantId, admin.userId)).toContain('old-key');
    await harness.fixtures.ageBulkOperations(tenantId, 25);
    await run(body(false), { key: 'new-key' });
    const keys = await harness.fixtures.bulkOperationKeys(tenantId, admin.userId);
    expect(keys).toContain('new-key');
    expect(keys).not.toContain('old-key');
  });

  it('lets two simultaneous retries through only once', async () => {
    const [a, b, c] = await makeContacts(3, 'Race');
    const body = {
      objectType: 'contact',
      action: 'assign',
      ownerId: rep.userId,
      target: { kind: 'ids', ids: [a, b, c] },
    };
    const [one, two] = await Promise.all([
      run(body, { key: 'race-key' }),
      run(body, { key: 'race-key' }),
    ]);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(one.changed).toBe(3);
    expect(two.changed).toBe(3);
    expect((await get(`contacts/${a}`))['version']).toBe(2);
  });
});
