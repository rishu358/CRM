import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../testing/harness.js';

/**
 * Free-text search is a read of every column it matches (CLAUDE.md §5.4, ADR-0041).
 *
 * `sort` and `filter` already refuse a field the caller cannot read, because ordering or comparing
 * by a hidden column reads it a character at a time. `q` matched first name, last name, email and
 * phone whatever the caller could see, so `q=@gmail` answered as a list of rows was the same
 * leak. It was found by the load test reading the SQL, not by a review; this is the test that
 * keeps it closed, for every list that has a `q`.
 *
 * Each case builds a role that may read everything on the object except one searchable field, and
 * puts a distinctive value in that field. The control is the administrator, who finds the row by
 * that value: without it, "found nothing" could mean the search was broken for everybody.
 */

let harness: ApiHarness;
let tenant: string;
let admin: { token: string; userId: string };

async function userWithHidden(
  objectType: 'contact' | 'lead' | 'account' | 'deal' | 'activity',
  hiddenField: string,
): Promise<string> {
  const role = await harness.fixtures.createRole(tenant, `No ${hiddenField} on ${objectType}`);
  await harness.fixtures.grantAll(tenant, role, objectType, 'all');
  await harness.fixtures.setFieldPermission(tenant, role, objectType, hiddenField, 'hidden');
  const user = await harness.fixtures.createUser(tenant, role);
  return harness.signIn(user.userId, tenant);
}

async function ids(url: string, token: string): Promise<string[]> {
  const response = await request(harness, { method: 'GET', url, token });
  expect(response.status, url).toBe(200);
  return dataOf<{ id: string }[]>(response).map((row) => row.id);
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenant = (await harness.fixtures.createTenant({ name: 'Search permissions' })).tenantId;
  const roles = await harness.provision(tenant);
  const adminUser = await harness.fixtures.createUser(tenant, roles.get('Admin')!);
  admin = { userId: adminUser.userId, token: await harness.signIn(adminUser.userId, tenant) };
});

afterAll(async () => {
  await harness.close();
});

describe('q does not search a field the caller may not read', () => {
  it('contacts: a hidden phone cannot be found by its digits, a visible surname still can', async () => {
    const contact = await harness.fixtures.createContact(tenant, {
      ownerId: admin.userId,
      lastName: 'Quillfeather',
      phone: '+919123400007',
    });
    const token = await userWithHidden('contact', 'phone');

    expect(await ids('/api/v1/contacts?q=9123400007', admin.token)).toContain(contact);
    expect(await ids('/api/v1/contacts?q=9123400007', token)).toEqual([]);
    expect(await ids('/api/v1/contacts?q=Quillfeather', token)).toContain(contact);
  });

  it('contacts: a hidden email cannot be probed one character at a time', async () => {
    const contact = await harness.fixtures.createContact(tenant, {
      ownerId: admin.userId,
      lastName: 'Marrowby',
      email: 'private.marker@hidden-domain.example',
    });
    const token = await userWithHidden('contact', 'email');

    for (const probe of ['hidden-domain', 'private.marker', '@hidden', 'p']) {
      const found = await ids(`/api/v1/contacts?q=${encodeURIComponent(probe)}`, token);
      expect(found, probe).not.toContain(contact);
    }
    expect(await ids('/api/v1/contacts?q=hidden-domain', admin.token)).toContain(contact);
  });

  it('contacts: a role that may read none of the searchable fields finds nothing at all', async () => {
    await harness.fixtures.createContact(tenant, { ownerId: admin.userId, lastName: 'Zephyrine' });
    const role = await harness.fixtures.createRole(tenant, 'Blind to contact search');
    await harness.fixtures.grantAll(tenant, role, 'contact', 'all');
    for (const field of ['first_name', 'last_name', 'email', 'phone']) {
      await harness.fixtures.setFieldPermission(tenant, role, 'contact', field, 'hidden');
    }
    const user = await harness.fixtures.createUser(tenant, role);
    const token = await harness.signIn(user.userId, tenant);

    expect(await ids('/api/v1/contacts?q=Zephyrine', token)).toEqual([]);
    expect(await ids('/api/v1/contacts?q=Zephyrine', admin.token)).not.toEqual([]);
  });

  it('leads: a hidden company and a hidden email are not searched', async () => {
    const lead = await harness.fixtures.createLead(tenant, {
      ownerId: admin.userId,
      lastName: 'Brindlewood',
      company: 'Undisclosed Holdings Pvt',
      email: 'deal.secret@ghostmail.example',
    });
    const noCompany = await userWithHidden('lead', 'company');
    const noEmail = await userWithHidden('lead', 'email');

    expect(await ids('/api/v1/leads?q=Undisclosed', admin.token)).toContain(lead);
    expect(await ids('/api/v1/leads?q=Undisclosed', noCompany)).not.toContain(lead);
    expect(await ids('/api/v1/leads?q=deal.secret', noEmail)).not.toContain(lead);
    expect(await ids('/api/v1/leads?q=Brindlewood', noCompany)).toContain(lead);
  });

  it('accounts: a hidden domain is not searched', async () => {
    const account = await harness.fixtures.createAccount(tenant, {
      ownerId: admin.userId,
      name: 'Plain Name Traders',
      domain: 'covert-domain-marker.example',
    });
    const token = await userWithHidden('account', 'domain');

    expect(await ids('/api/v1/accounts?q=covert-domain-marker', admin.token)).toContain(account);
    expect(await ids('/api/v1/accounts?q=covert-domain-marker', token)).toEqual([]);
    expect(await ids('/api/v1/accounts?q=Plain%20Name', token)).toContain(account);
  });

  it('deals: a hidden name is not searched', async () => {
    const pipeline = await harness.fixtures.createPipeline(tenant, 'Search pipeline', [
      { name: 'Open', stageType: 'open', probability: 10 },
    ]);
    const deal = await harness.fixtures.createDeal(tenant, {
      pipelineId: pipeline.pipelineId,
      stageId: pipeline.stageIds[0]!,
      ownerId: admin.userId,
      name: 'Confidential Wintermute Order',
    });
    const token = await userWithHidden('deal', 'name');

    expect(await ids('/api/v1/deals?q=Wintermute', admin.token)).toContain(deal);
    expect(await ids('/api/v1/deals?q=Wintermute', token)).toEqual([]);
  });

  it('activities: a hidden subject is not searched', async () => {
    const activity = await harness.fixtures.createActivity(tenant, {
      assignedTo: admin.userId,
      subject: 'Renegotiate the Ostrander contract',
    });
    const token = await userWithHidden('activity', 'subject');

    expect(await ids('/api/v1/activities?q=Ostrander', admin.token)).toContain(activity);
    expect(await ids('/api/v1/activities?q=Ostrander', token)).toEqual([]);
  });
});
