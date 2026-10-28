import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * What a merge does (ADR-0064): what moves, what stays, what the preview says, and how it behaves when
 * retried, raced, refused and undone. Who may merge what, and the walls between workspaces, are in
 * `merge.security.spec.ts`.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };
let pipelineId: string;
let stageId: string;

interface Counts {
  activities: number | null;
  notes: number | null;
  files: number;
  deals: number | null;
  contacts: number | null;
  childAccounts: number | null;
  leads: number | null;
  tags: number;
}

interface Result {
  objectType: string;
  masterId: string;
  loserId: string;
  dryRun: boolean;
  counts: Counts;
  fromLoser: string[];
  record: Record<string, unknown>;
  replayed: boolean;
}

const get = async (path: string, token = admin.token) =>
  request(harness, { method: 'GET', url: `/api/v1/${path}`, token });

const versionOf = async (objectType: 'contact' | 'account', id: string): Promise<number> => {
  const body = dataOf<{ version: number }>(await get(`${objectType}s/${id}`));
  return body.version;
};

async function mergeBody(
  objectType: 'contact' | 'account',
  masterId: string,
  loserId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    objectType,
    masterId,
    masterVersion: await versionOf(objectType, masterId),
    loserId,
    loserVersion: await versionOf(objectType, loserId),
    fields: {},
    ...extra,
  };
}

const post = (body: unknown, options: { token?: string; key?: string } = {}) =>
  request(harness, {
    method: 'POST',
    url: '/api/v1/merges',
    token: options.token ?? admin.token,
    body,
    ...(options.key === undefined ? {} : { headers: { 'idempotency-key': options.key } }),
  });

const contact = (lastName: string, extra: Record<string, unknown> = {}) =>
  harness.fixtures.createContact(tenantId, { ownerId: admin.userId, lastName, ...extra });
const account = (name: string, extra: Record<string, unknown> = {}) =>
  harness.fixtures.createAccount(tenantId, { ownerId: admin.userId, name, ...extra });
const deal = (name: string, extra: Record<string, unknown> = {}) =>
  harness.fixtures.createDeal(tenantId, {
    ownerId: admin.userId,
    name,
    pipelineId,
    stageId,
    ...extra,
  });

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const roles = await harness.provision(tenantId);
  const adminUser = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: adminUser.userId, token: await harness.signIn(adminUser.userId, tenantId) };
  const pipeline = (await harness.fixtures.pipelinesFor(tenantId))[0]!;
  pipelineId = pipeline.id;
  stageId = pipeline.stages[0]!.id;
  await harness.fixtures.createCustomField(tenantId, 'contact', 'region', 'text', 'Region');
}, 240_000);

afterAll(async () => {
  await harness.close();
});

describe('merging two contacts', () => {
  it('moves everything that pointed at the loser, and leaves nothing behind', async () => {
    const master = await contact('Master Sharma', { email: 'master@acme.example' });
    const loser = await contact('Loser Sharma', { email: 'loser@acme.example' });

    // Linked activities: a task only on the loser, a call on both (kept once), and a note.
    const task = await harness.fixtures.createActivity(tenantId, {
      assignedTo: admin.userId,
      type: 'task',
      subject: 'Send quote',
    });
    const call = await harness.fixtures.createActivity(tenantId, {
      assignedTo: admin.userId,
      type: 'call',
      subject: 'Intro call',
    });
    const note = await harness.fixtures.createActivity(tenantId, {
      assignedTo: admin.userId,
      type: 'note',
      subject: 'Likes gold',
    });
    await harness.fixtures.linkActivity(tenantId, task, 'contact', loser);
    await harness.fixtures.linkActivity(tenantId, call, 'contact', loser);
    await harness.fixtures.linkActivity(tenantId, call, 'contact', master);
    await harness.fixtures.linkActivity(tenantId, note, 'contact', loser);
    // Files: one live, one in the bin.
    await harness.fixtures.createAttachmentRow(tenantId, 'contact', loser);
    await harness.fixtures.createAttachmentRow(tenantId, 'contact', loser, { deleted: true });
    // Tags: one both carry, one only the loser has.
    await harness.fixtures.tagRecord(tenantId, 'contact', master, 'Shared');
    await harness.fixtures.tagRecord(tenantId, 'contact', loser, 'shared');
    await harness.fixtures.tagRecord(tenantId, 'contact', loser, 'Only loser');
    // Deals: the loser is the primary contact of one, a person on another, and on a third with the master.
    const primary = await deal('Primary deal', { primaryContactId: loser });
    const person = await deal('Person deal');
    await harness.fixtures.linkDealContact(tenantId, person, loser, 'Buyer');
    const both = await deal('Both deal');
    await harness.fixtures.linkDealContact(tenantId, both, loser, 'Buyer');
    await harness.fixtures.linkDealContact(tenantId, both, master, null);
    // A lead that became the loser.
    const lead = await harness.fixtures.createLead(tenantId, {
      ownerId: admin.userId,
      status: 'converted',
      convertedAt: new Date(),
      convertedContactId: loser,
    });

    const masterVersion = await versionOf('contact', master);
    const response = await post(await mergeBody('contact', master, loser));
    const result = dataOf<Result>(response, 200);

    expect(result).toMatchObject({
      masterId: master,
      loserId: loser,
      dryRun: false,
      replayed: false,
      fromLoser: [],
      counts: {
        activities: 2,
        notes: 1,
        files: 1,
        deals: 3,
        contacts: 0,
        childAccounts: 0,
        leads: 1,
        tags: 1,
      },
    });
    // The master keeps its own values and its id; its version moved.
    expect(result.record).toMatchObject({ id: master, lastName: 'Master Sharma' });
    expect(result.record['version']).toBeGreaterThan(masterVersion);

    // Nothing points at the loser any more, and the master holds all of it.
    expect(await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', loser)).toEqual({
      activity_links: 0,
      attachments: 0,
      record_tags: 0,
      timeline_events: 0,
      record_views: 0,
    });
    const held = await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', master);
    expect(held['activity_links']).toBe(3); // task, call (once), note
    expect(held['attachments']).toBe(2); // the one in the bin moves too
    expect(held['record_tags']).toBe(2); // Shared once, Only loser
    expect(await harness.fixtures.recordTagNames(tenantId, 'contact', master)).toEqual([
      'Only loser',
      'Shared',
    ]);

    expect((await harness.fixtures.dealRow(primary))?.primary_contact_id).toBe(master);
    expect(await harness.fixtures.dealContactRows(person)).toEqual([
      { contactId: master, role: 'Buyer' },
    ]);
    expect(await harness.fixtures.dealContactRows(both)).toEqual([
      { contactId: master, role: 'Buyer' },
    ]);
    expect((await harness.fixtures.leadRow(lead))?.converted_contact_id).toBe(master);

    // The loser is in the Recycle Bin, not gone, and remembers where it went.
    const loserRow = await harness.fixtures.rowOf('contacts', loser);
    expect(loserRow?.['deleted_at']).not.toBeNull();
    expect(await harness.fixtures.mergePointers(tenantId)).toEqual([
      expect.objectContaining({ objectType: 'contact', loserId: loser, masterId: master }),
    ]);
  });

  it('keeps one row where both people were on a deal, and the role the master lacked', async () => {
    const master = await contact('Role Master');
    const loser = await contact('Role Loser');
    const both = await deal('Roles');
    await harness.fixtures.linkDealContact(tenantId, both, master, null);
    await harness.fixtures.linkDealContact(tenantId, both, loser, 'Decision maker');

    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);

    const rows = await harness.fixtures.dealContactRows(both);
    expect(rows).toEqual([{ contactId: master, role: 'Decision maker' }]);
  });

  it('gives the master the loser’s value for exactly the fields chosen, and keeps the older creation date', async () => {
    const loser = await contact('Older', {
      firstName: 'Asha',
      phone: '+919876500001',
      title: 'Director',
      customFields: { region: 'North' },
    });
    // The master is created second, so the loser is the older record.
    const master = await contact('Newer', { firstName: 'Ash', title: 'Manager' });
    const loserCreated = (await harness.fixtures.rowOf('contacts', loser))?.['created_at'] as Date;

    const result = dataOf<Result>(
      await post(
        await mergeBody('contact', master, loser, {
          fields: { phone: 'loser', firstName: 'loser', region: 'loser', title: 'master' },
        }),
      ),
      200,
    );

    expect(result.fromLoser.sort()).toEqual(['firstName', 'phone', 'region']);
    expect(result.record).toMatchObject({
      lastName: 'Newer',
      firstName: 'Asha',
      phone: '+919876500001',
      title: 'Manager',
      customFields: expect.objectContaining({ region: 'North' }),
    });
    const masterRow = await harness.fixtures.rowOf('contacts', master);
    expect(new Date(masterRow?.['created_at'] as Date).getTime()).toBe(loserCreated.getTime());
  });

  it('carries over a consent channel only the loser recorded, and never overwrites the master’s', async () => {
    const master = await contact('Consent Master');
    const loser = await contact('Consent Loser');
    await harness.fixtures.setContactConsent(master, {
      email: { status: 'granted', source: 'form' },
    });
    await harness.fixtures.setContactConsent(loser, {
      email: { status: 'withdrawn', source: 'phone' },
      whatsapp: { status: 'granted', source: 'form' },
    });

    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);

    expect(await harness.fixtures.contactConsent(master)).toEqual({
      email: { status: 'granted', source: 'form' },
      whatsapp: { status: 'granted', source: 'form' },
    });
  });

  it('stops "remove the sample data" from deleting a real customer’s merged record', async () => {
    const sampleMaster = await contact('Sample Master');
    const realLoser = await contact('Real Loser');
    await harness.fixtures.registerSample(tenantId, 'contact', sampleMaster);

    dataOf<Result>(await post(await mergeBody('contact', sampleMaster, realLoser)), 200);

    expect(await harness.fixtures.isSample(tenantId, 'contact', sampleMaster)).toBe(false);
  });
});

describe('merging two accounts', () => {
  it('moves the contacts, deals, child accounts and converted leads of the merged-away company', async () => {
    const master = await account('Initech Retail');
    const loser = await account('Initech Retail Pvt Ltd');
    const person = await contact('At loser', { accountId: loser });
    const personAtMaster = await contact('At master', { accountId: master });
    const dealOfLoser = await deal('Account deal', { accountId: loser });
    const child = await account('Initech Branch', { parentAccountId: loser });
    const lead = await harness.fixtures.createLead(tenantId, {
      ownerId: admin.userId,
      status: 'converted',
      convertedAt: new Date(),
      convertedAccountId: loser,
    });
    const note = await harness.fixtures.createActivity(tenantId, {
      assignedTo: admin.userId,
      type: 'note',
      subject: 'Pays late',
    });
    await harness.fixtures.linkActivity(tenantId, note, 'account', loser);
    await harness.fixtures.createAttachmentRow(tenantId, 'account', loser);

    const result = dataOf<Result>(await post(await mergeBody('account', master, loser)), 200);

    expect(result.counts).toMatchObject({
      contacts: 1,
      deals: 1,
      childAccounts: 1,
      leads: 1,
      notes: 1,
      files: 1,
    });
    expect((await harness.fixtures.rowOf('contacts', person))?.['account_id']).toBe(master);
    expect((await harness.fixtures.rowOf('contacts', personAtMaster))?.['account_id']).toBe(master);
    expect((await harness.fixtures.dealRow(dealOfLoser))?.account_id).toBe(master);
    expect((await harness.fixtures.rowOf('accounts', child))?.['parent_account_id']).toBe(master);
    expect((await harness.fixtures.leadRow(lead))?.converted_account_id).toBe(master);
    expect(await harness.fixtures.polymorphicRowCounts(tenantId, 'account', loser)).toEqual({
      activity_links: 0,
      attachments: 0,
      record_tags: 0,
      timeline_events: 0,
      record_views: 0,
    });
  });

  it('refuses to merge a company into one that sits above or below it in the hierarchy, and writes nothing', async () => {
    const group = await account('Group Holdings');
    const sub = await account('Group Retail', { parentAccountId: group });
    const subsub = await account('Group Retail North', { parentAccountId: sub });

    // The one to keep (subsub) sits under the one to merge away (group).
    const response = await post(await mergeBody('account', subsub, group));
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('MERGE_BLOCKED');
    expect((await harness.fixtures.rowOf('accounts', group))?.['deleted_at']).toBeNull();
    expect((await harness.fixtures.rowOf('accounts', subsub))?.['parent_account_id']).toBe(sub);

    // The other way round is fine: the master is above the loser, so the loser's children move up.
    const merged = await post(await mergeBody('account', group, sub));
    expect(merged.status).toBe(200);
    expect((await harness.fixtures.rowOf('accounts', subsub))?.['parent_account_id']).toBe(group);
  });
});

describe('the preview', () => {
  it('reports what would move and changes nothing', async () => {
    const master = await contact('Preview Master');
    const loser = await contact('Preview Loser');
    const note = await harness.fixtures.createActivity(tenantId, {
      assignedTo: admin.userId,
      type: 'note',
      subject: 'Preview note',
    });
    await harness.fixtures.linkActivity(tenantId, note, 'contact', loser);
    await harness.fixtures.tagRecord(tenantId, 'contact', loser, 'Preview tag');
    const before = await versionOf('contact', master);

    const result = dataOf<Result>(
      await post(await mergeBody('contact', master, loser, { dryRun: true })),
      200,
    );

    expect(result.dryRun).toBe(true);
    expect(result.counts).toMatchObject({ notes: 1, tags: 1 });
    expect(await versionOf('contact', master)).toBe(before);
    expect((await harness.fixtures.rowOf('contacts', loser))?.['deleted_at']).toBeNull();
    expect(await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', loser)).toMatchObject({
      activity_links: 1,
      record_tags: 1,
    });
    expect((await harness.fixtures.mergePointers(tenantId)).map((p) => p.loserId)).not.toContain(
      loser,
    );
    // And it said no audit entry and no event: it rolled back.
    const audit = await harness.fixtures.auditEntries(tenantId, 'contact');
    expect(audit.filter((entry) => entry.recordId === loser && entry.action === 'merge')).toEqual(
      [],
    );
  });

  it('reports the same refusal a real merge would', async () => {
    const master = await contact('Refused Master');
    const loser = await contact('Refused Loser');
    await harness.fixtures.openErasureRequest(tenantId, loser);
    const body = await mergeBody('contact', master, loser);

    const preview = await post({ ...body, dryRun: true });
    const real = await post(body);
    expect(preview.status).toBe(422);
    expect(real.status).toBe(422);
    expect((preview.body['error'] as { code: string }).code).toBe('MERGE_BLOCKED');
  });
});

describe('what the person is told afterwards', () => {
  it('answers an old id with 410 and the surviving record, never a silent 404', async () => {
    const master = await contact('Survivor');
    const loser = await contact('Folded');
    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);

    const old = await get(`contacts/${loser}`);
    expect(old.status).toBe(410);
    expect(old.body['error']).toMatchObject({
      code: 'RECORD_MERGED',
      details: [{ path: 'mergedIntoId', message: master }],
    });
    // A record that never existed is still a 404.
    expect((await get(`contacts/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it('keeps answering after the Recycle Bin has purged the loser', async () => {
    const master = await contact('Kept');
    const loser = await contact('Purged');
    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);

    await harness.fixtures.hardDeleteRecord('contacts', loser);

    const old = await get(`contacts/${loser}`);
    expect(old.status).toBe(410);
    expect(old.body['error']).toMatchObject({ details: [{ message: master }] });
  });

  it('collapses a chain, so an old id is one hop from the survivor', async () => {
    const first = await contact('Chain one');
    const second = await contact('Chain two');
    const third = await contact('Chain three');
    dataOf<Result>(await post(await mergeBody('contact', second, first)), 200);
    dataOf<Result>(await post(await mergeBody('contact', third, second)), 200);

    const old = await get(`contacts/${first}`);
    expect(old.status).toBe(410);
    expect(old.body['error']).toMatchObject({ details: [{ message: third }] });
  });

  it('writes a merge audit entry for both records, an audit entry for each record that moved, and the events', async () => {
    const master = await account('Audited Master');
    const loser = await account('Audited Loser');
    const person = await contact('Audited person', { accountId: loser });
    const eventsBefore = (await harness.fixtures.outboxEventTypes(tenantId)).length;

    dataOf<Result>(await post(await mergeBody('account', master, loser)), 200);

    const accountAudit = await harness.fixtures.auditEntries(tenantId, 'account');
    const merges = accountAudit.filter((entry) => entry.action === 'merge');
    expect(merges.map((entry) => entry.recordId).sort()).toEqual([master, loser].sort());
    const loserEntry = merges.find((entry) => entry.recordId === loser)!;
    expect(loserEntry.changes).toMatchObject({
      mergedInto: { new: master },
      name: { old: 'Audited Loser' },
    });
    const masterEntry = merges.find((entry) => entry.recordId === master)!;
    expect(masterEntry.changes).toMatchObject({ mergedFrom: { new: loser } });

    const contactAudit = await harness.fixtures.auditEntries(tenantId, 'contact');
    expect(
      contactAudit.some(
        (entry) =>
          entry.recordId === person &&
          entry.action === 'update' &&
          JSON.stringify(entry.changes).includes(master),
      ),
    ).toBe(true);

    const events = await harness.fixtures.outboxEventTypes(tenantId);
    expect(events.length).toBeGreaterThan(eventsBefore);
    expect(events).toContain('account.merged.v1');
    expect(events).toContain('account.deleted.v1');
  });
});

describe('refusals', () => {
  it('refuses a stale version of either record, and changes nothing', async () => {
    const master = await contact('Stale Master');
    const loser = await contact('Stale Loser');
    const body = await mergeBody('contact', master, loser);

    for (const stale of [
      { ...body, masterVersion: body.masterVersion + 1 },
      { ...body, loserVersion: body.loserVersion + 1 },
    ]) {
      const response = await post(stale);
      expect(response.status).toBe(409);
      expect((response.body['error'] as { code: string }).code).toBe('VERSION_CONFLICT');
    }
    // Somebody edited the loser after the merge dialog opened.
    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${loser}`,
      token: admin.token,
      body: { title: 'Edited meanwhile', version: body.loserVersion },
    });
    expect((await post(body)).status).toBe(409);
    expect((await harness.fixtures.rowOf('contacts', loser))?.['deleted_at']).toBeNull();
    expect((await harness.fixtures.mergePointers(tenantId)).map((p) => p.loserId)).not.toContain(
      loser,
    );
  });

  it('refuses a record merged with itself, an unknown field, an unknown key and a missing record', async () => {
    const one = await contact('Solo');
    const other = await contact('Other');
    const body = await mergeBody('contact', one, other);

    const self = await post({ ...body, loserId: one, loserVersion: body.masterVersion });
    expect(self.status).toBe(422);

    const unknownField = await post({ ...body, fields: { nope: 'loser' } });
    expect(unknownField.status).toBe(403);
    expect((unknownField.body['error'] as { code: string }).code).toBe('FIELD_NOT_WRITABLE');
    // The owner is not a field a merge can choose: reassignment has its own rules.
    const owner = await post({ ...body, fields: { ownerId: 'loser' } });
    expect(owner.status).toBe(403);

    expect((await post({ ...body, extra: true })).status).toBe(422);
    expect((await post({ ...body, objectType: 'deal' })).status).toBe(422);
    expect((await post({ ...body, loserId: crypto.randomUUID() })).status).toBe(404);
  });

  it('refuses a merge across kinds: an account id given to a contact merge is not found', async () => {
    const person = await contact('Person');
    const company = await account('Company');
    const response = await post({
      objectType: 'contact',
      masterId: person,
      masterVersion: await versionOf('contact', person),
      loserId: company,
      loserVersion: 1,
      fields: {},
    });
    expect(response.status).toBe(404);
  });

  it('refuses a merged result that would not pass an edit, with a clear 422 and nothing written', async () => {
    const master = await contact('Valid Master', { email: 'valid@acme.example' });
    const loser = await contact('Legacy Loser');
    // An address a long-gone import wrote: not something the edit rules would accept today.
    await harness.fixtures.setContactEmailRaw(loser, 'not an email');

    const response = await post(
      await mergeBody('contact', master, loser, { fields: { email: 'loser' } }),
    );
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).toContain('email');
    expect((await harness.fixtures.rowOf('contacts', loser))?.['deleted_at']).toBeNull();
    expect((await harness.fixtures.rowOf('contacts', master))?.['email']).toBe(
      'valid@acme.example',
    );
  });

  it('refuses to merge while an erasure request is open for either contact', async () => {
    const master = await contact('Erasing Master');
    const loser = await contact('Erasing Loser');
    await harness.fixtures.openErasureRequest(tenantId, master);
    const response = await post(await mergeBody('contact', master, loser));
    expect(response.status).toBe(422);
    expect((response.body['error'] as { code: string }).code).toBe('MERGE_BLOCKED');
  });

  it('refuses a merge that would move more rows than the cap, says how many, and writes nothing', async () => {
    const master = await contact('Big Master');
    const loser = await contact('Big Loser');
    await harness.fixtures.insertSyntheticTimeline(tenantId, 'contact', loser, 5001);

    const response = await post(await mergeBody('contact', master, loser));
    expect(response.status).toBe(422);
    expect(response.body['error']).toMatchObject({
      code: 'MERGE_TOO_LARGE',
      details: [{ meta: { moved: 5001, limit: 5000 } }],
    });
    expect((await harness.fixtures.rowOf('contacts', loser))?.['deleted_at']).toBeNull();
    expect(
      (await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', loser))['timeline_events'],
    ).toBe(5001);
  });
});

describe('retries and races', () => {
  it('answers a retry with the first answer, writes nothing twice, and refuses the key for another request', async () => {
    const master = await contact('Retry Master');
    const loser = await contact('Retry Loser');
    const other = await contact('Retry Other');
    const body = await mergeBody('contact', master, loser);
    const key = `merge-${crypto.randomUUID()}`;

    const first = dataOf<Result>(await post(body, { key }), 200);
    expect(first.replayed).toBe(false);
    const auditAfterFirst = (await harness.fixtures.auditEntries(tenantId, 'contact')).length;

    const retry = await post(body, { key });
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(dataOf<Result>(retry, 200)).toMatchObject({
      replayed: true,
      masterId: master,
      loserId: loser,
      counts: first.counts,
    });
    expect((await harness.fixtures.auditEntries(tenantId, 'contact')).length).toBe(auditAfterFirst);
    expect(
      (await harness.fixtures.mergePointers(tenantId)).filter(
        (pointer) => pointer.loserId === loser,
      ),
    ).toHaveLength(1);

    const reused = await post(await mergeBody('contact', master, other), { key });
    expect(reused.status).toBe(409);
    expect((reused.body['error'] as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('stores ids and counts under a key, never a field’s value', async () => {
    const master = await contact('Store Master', { email: 'store-master@acme.example' });
    const loser = await contact('Store Loser', { email: 'store-loser@acme.example' });
    const key = `merge-${crypto.randomUUID()}`;
    dataOf<Result>(
      await post(await mergeBody('contact', master, loser, { fields: { email: 'loser' } }), {
        key,
      }),
      200,
    );

    const stored = JSON.stringify(
      await harness.fixtures.bulkOperationRows(tenantId, admin.userId, key),
    );
    expect(stored).toContain(master);
    expect(stored).not.toContain('store-loser@acme.example');
    expect(stored).not.toContain('Store Loser');
  });

  it('merges the same pair twice at once: one wins, the other is told it was already done', async () => {
    const master = await contact('Race Master');
    const loser = await contact('Race Loser');
    const body = await mergeBody('contact', master, loser);
    await harness.fixtures.createAttachmentRow(tenantId, 'contact', loser);

    const [a, b] = await Promise.all([post(body), post(body)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const refused = a.status === 409 ? a : b;
    expect((refused.body['error'] as { code: string }).code).toBe('RECORD_ALREADY_MERGED');
    expect(
      (await harness.fixtures.mergePointers(tenantId)).filter(
        (pointer) => pointer.loserId === loser,
      ),
    ).toHaveLength(1);
    // Moved once: the master has the file once, not twice and not none.
    expect(
      (await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', master))['attachments'],
    ).toBe(1);
  });

  it('merges A into B and B into A at once without deadlocking: one succeeds, the other is not found', async () => {
    const a = await contact('Cross A');
    const b = await contact('Cross B');
    const forward = await mergeBody('contact', a, b);
    const backward = await mergeBody('contact', b, a);

    const [x, y] = await Promise.all([post(forward), post(backward)]);

    expect([x.status, y.status].sort()).toEqual([200, 404]);
    const live = await Promise.all(
      [a, b].map(
        async (id) => (await harness.fixtures.rowOf('contacts', id))?.['deleted_at'] === null,
      ),
    );
    expect(live.filter(Boolean)).toHaveLength(1);
  });
});

describe('restoring a merged-away record from the Recycle Bin', () => {
  it('brings it back as its own record, stops the old id answering "merged", and leaves what moved where it is', async () => {
    const master = await contact('Restore Master');
    const loser = await contact('Restore Loser', { email: 'restore-loser@acme.example' });
    const note = await harness.fixtures.createActivity(tenantId, {
      assignedTo: admin.userId,
      type: 'note',
      subject: 'Moved note',
    });
    await harness.fixtures.linkActivity(tenantId, note, 'contact', loser);
    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);
    expect((await get(`contacts/${loser}`)).status).toBe(410);

    const deleted = (await harness.fixtures.rowOf('contacts', loser))!;
    const restored = await request(harness, {
      method: 'POST',
      url: `/api/v1/recycle-bin/contact/${loser}/restore`,
      token: admin.token,
      body: { version: deleted['version'] },
    });
    expect(restored.status).toBe(200);

    const back = await get(`contacts/${loser}`);
    expect(back.status).toBe(200);
    expect(back.body['data']).toMatchObject({
      lastName: 'Restore Loser',
      email: 'restore-loser@acme.example',
    });
    expect(
      (await harness.fixtures.mergePointers(tenantId)).find((p) => p.loserId === loser)?.undone,
    ).toBe(true);
    // The note stays with the record it was merged into.
    expect(
      (await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', loser))['activity_links'],
    ).toBe(0);
    expect(
      (await harness.fixtures.polymorphicRowCounts(tenantId, 'contact', master))['activity_links'],
    ).toBe(1);

    // It can be merged again, and the second pointer answers.
    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);
    expect((await get(`contacts/${loser}`)).status).toBe(410);
  });
});

describe('what the rest of the product sees', () => {
  it('lists one contact where there were two, and finds the survivor and not the loser in search', async () => {
    const master = await contact('Searchable Duplicate', { email: 'dup-search@acme.example' });
    const loser = await contact('Searchable Duplicate', { email: 'dup-search@acme.example' });
    await harness.indexForSearch(tenantId);
    const find = async () => dataOf<{ id: string }[]>(await get('search?q=Searchable'));
    const searchBefore = JSON.stringify(await find());
    expect(searchBefore).toContain(master);
    expect(searchBefore).toContain(loser);

    const listBefore = dataOf<{ id: string }[]>(await get('contacts?q=Searchable&limit=50'));
    expect(listBefore.filter((row) => [master, loser].includes(row.id))).toHaveLength(2);

    dataOf<Result>(await post(await mergeBody('contact', master, loser)), 200);
    // The relay would run `contact.deleted.v1` and `contact.updated.v1`; the projection is rebuilt as it does.
    await harness.indexForSearch(tenantId);

    const searchAfter = JSON.stringify(await find());
    expect(searchAfter).toContain(master);
    expect(searchAfter).not.toContain(loser);
    expect(await harness.fixtures.searchDocumentCount(tenantId, 'contact', loser)).toBe(0);
    expect(await harness.fixtures.searchDocumentCount(tenantId, 'contact', master)).toBeGreaterThan(
      0,
    );

    const listAfter = dataOf<{ id: string }[]>(await get('contacts?q=Searchable&limit=50'));
    expect(
      listAfter.filter((row) => [master, loser].includes(row.id)).map((row) => row.id),
    ).toEqual([master]);
  });

  it('keeps the dashboard’s deal figures the same when the deals of a merged-away company move', async () => {
    const master = await account('Dash Master');
    const loser = await account('Dash Loser');
    await deal('Dash deal 1', { accountId: loser, amountMinor: 1_000_000n, currency: 'INR' });
    await deal('Dash deal 2', { accountId: master, amountMinor: 2_500_000n, currency: 'INR' });

    const pipelineFigure = async () =>
      JSON.stringify((await get('dashboard/pipeline')).body['data']);
    const before = await pipelineFigure();

    dataOf<Result>(await post(await mergeBody('account', master, loser)), 200);

    // Deals follow the company; none disappears with the merged-away record, so the totals are unchanged.
    expect(await pipelineFigure()).toBe(before);
  });
});
