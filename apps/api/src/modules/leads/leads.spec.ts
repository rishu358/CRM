import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for the leads module: CRUD, duplicate detection, and above
 * all conversion.
 *
 * Run against real Postgres with RLS on, like every other test here. The
 * properties under test — a conversion is one transaction, two concurrent
 * conversions cannot both win, fuzzy matching uses pg_trgm — are database
 * behaviour, and a mock would simply agree with whatever this file expects.
 */

let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };
let rep: { token: string; userId: string };
let roles: ReadonlyMap<string, string>;

type Body = Record<string, unknown>;
interface Match {
  objectType: string;
  id: string;
  label: string;
  matchedOn: string[];
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const tenant = await harness.fixtures.createTenant({ name: 'Leads Behaviour Co' });
  tenantId = tenant.tenantId;
  roles = await harness.provision(tenantId);

  const a = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: a.userId, token: await harness.signIn(a.userId, tenantId) };
  const r = await harness.fixtures.createUser(tenantId, roles.get('Sales Rep')!);
  rep = { userId: r.userId, token: await harness.signIn(r.userId, tenantId) };
});

afterAll(async () => {
  await harness.close();
});

function post(url: string, body: Body, token = admin.token) {
  return request(harness, { method: 'POST', url: `/api/v1${url}`, token, body });
}

function get(url: string, token = admin.token) {
  return request(harness, { method: 'GET', url: `/api/v1${url}`, token });
}

async function createLead(
  body: Body,
  token = admin.token,
): Promise<{ id: string; version: number }> {
  const response = await post('/leads', body, token);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const data = response.body['data'] as { id: string; version: number };
  return { id: data.id, version: data.version };
}

function counts() {
  return Promise.all([
    harness.fixtures.countRows('contacts', tenantId),
    harness.fixtures.countRows('accounts', tenantId),
    harness.fixtures.countRows('deals', tenantId),
  ]).then(([contacts, accounts, deals]) => ({ contacts, accounts, deals }));
}

describe('creating and editing a lead', () => {
  it('creates a lead owned by the actor, with an audit entry and an event', async () => {
    const { id } = await createLead({ lastName: 'Kapoor', company: 'Kapoor Textiles' }, rep.token);

    const response = await get(`/leads/${id}`, rep.token);
    const lead = response.body['data'] as Body;
    expect(lead['status']).toBe('new');
    expect(lead['ownerId']).toBe(rep.userId);
    expect(lead['convertedAt']).toBeNull();

    const audit = await harness.fixtures.auditEntries(tenantId, 'lead');
    expect(audit.some((entry) => entry.recordId === id && entry.action === 'create')).toBe(true);
    const events = await harness.fixtures.outboxEvents(tenantId, 'lead.created.v1');
    expect(events.some((event) => event.recordId === id)).toBe(true);
  });

  it('normalises email case and rejects a malformed phone number', async () => {
    const { id } = await createLead({ lastName: 'Case', email: 'MiXeD@Example.COM' });
    const lead = (await get(`/leads/${id}`)).body['data'] as Body;
    expect(lead['email']).toBe('mixed@example.com');

    const bad = await post('/leads', { lastName: 'Phone', phone: '98765' });
    expect(bad.status).toBe(422);
  });

  it('rejects an unknown key and an unknown custom field', async () => {
    expect((await post('/leads', { lastName: 'X', score: 90 })).status).toBe(422);
    expect((await post('/leads', { lastName: 'X', customFields: { not_a_field: 1 } })).status).toBe(
      403,
    );
  });

  it('refuses to set the status to converted by hand', async () => {
    const created = await post('/leads', { lastName: 'Sneaky', status: 'converted' });
    expect(created.status).toBe(422);

    const { id, version } = await createLead({ lastName: 'Sneakier' });
    const patched = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${id}`,
      token: admin.token,
      body: { status: 'converted', version },
    });
    expect(patched.status).toBe(422);
    expect((await harness.fixtures.leadRow(id))?.status).toBe('new');
  });

  it('refuses a stale version with 409 rather than overwriting', async () => {
    const { id, version } = await createLead({ lastName: 'Locked' });
    const first = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${id}`,
      token: admin.token,
      body: { status: 'contacted', version },
    });
    expect(first.status).toBe(200);

    const stale = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${id}`,
      token: admin.token,
      body: { status: 'qualified', version },
    });
    expect(stale.status).toBe(409);
    expect((stale.body['error'] as Body)['code']).toBe('VERSION_CONFLICT');
  });

  it('filters by status', async () => {
    const { id } = await createLead({ lastName: 'Filterable', status: 'qualified' });
    const response = await get(`/leads?filter=${encodeURIComponent('status:eq:qualified')}`);
    const ids = (response.body['data'] as { id: string }[]).map((row) => row.id);
    expect(ids).toContain(id);
    for (const row of response.body['data'] as { status: string }[]) {
      expect(row.status).toBe('qualified');
    }
  });
});

describe('duplicate detection', () => {
  it('finds a contact by exact email and by phone, and says why', async () => {
    const byEmail = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'EmailTwin',
      email: 'twin@dupes.example',
    });
    const byPhone = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'PhoneTwin',
      phone: '+919822000001',
    });

    const response = await post('/leads/duplicate-check', {
      email: 'TWIN@dupes.example',
      phone: '+919822000001',
    });
    const matches = response.body['data'] as Match[];
    expect(matches.find((m) => m.id === byEmail)?.matchedOn).toEqual(['email']);
    expect(matches.find((m) => m.id === byPhone)?.matchedOn).toEqual(['phone']);
  });

  it('finds an account by its domain, but never by a free-mail domain', async () => {
    const account = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Rajesh Gold House',
      domain: 'rajeshgold-dupes.example',
    });
    const gmailAccount = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Gmail Holder Unrelated',
      domain: 'gmail.com',
    });

    const company = await post('/leads/duplicate-check', {
      email: 'buyer@rajeshgold-dupes.example',
    });
    const found = (company.body['data'] as Match[]).find((m) => m.id === account);
    expect(found?.matchedOn).toEqual(['domain']);

    const free = await post('/leads/duplicate-check', { email: 'someone@gmail.com' });
    expect((free.body['data'] as Match[]).map((m) => m.id)).not.toContain(gmailAccount);
  });

  it('matches company names fuzzily with pg_trgm, and not unrelated ones', async () => {
    const account = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Lotus Design Studio Pvt Ltd',
    });

    for (const company of [
      'Lotus Design Studio',
      'LOTUS DESIGN STUDIOS',
      'Lotus Design Studio Private',
    ]) {
      const response = await post('/leads/duplicate-check', { company });
      const found = (response.body['data'] as Match[]).find((m) => m.id === account);
      expect(found?.matchedOn, company).toEqual(['name']);
    }

    // Shares a word, and is a different company.
    const other = await post('/leads/duplicate-check', { company: 'Orchid Furniture Works' });
    expect((other.body['data'] as Match[]).map((m) => m.id)).not.toContain(account);
  });

  it('does not offer a deleted record', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Gone',
      email: 'gone@dupes.example',
    });
    const before = await post('/leads/duplicate-check', { email: 'gone@dupes.example' });
    expect((before.body['data'] as Match[]).map((m) => m.id)).toContain(contact);

    const removed = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/contacts/${contact}?version=1`,
      token: admin.token,
    });
    expect(removed.status).toBe(204);

    const after = await post('/leads/duplicate-check', { email: 'gone@dupes.example' });
    expect((after.body['data'] as Match[]).map((m) => m.id)).not.toContain(contact);
  });

  it('creates the lead anyway and reports the matches in meta', async () => {
    const contact = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Already',
      email: 'already@dupes.example',
    });
    const response = await post('/leads', { lastName: 'Newcomer', email: 'already@dupes.example' });
    expect(response.status).toBe(201);
    const meta = response.body['meta'] as { duplicates: Match[] };
    expect(meta.duplicates.map((m) => m.id)).toContain(contact);
  });

  it('offers another lead with the same email, excluding the lead itself', async () => {
    const first = await createLead({ lastName: 'First', email: 'two.leads@dupes.example' });
    const response = await post('/leads', { lastName: 'Second', email: 'two.leads@dupes.example' });
    const meta = response.body['meta'] as { duplicates: Match[] };
    expect(meta.duplicates.map((m) => m.id)).toEqual([first.id]);
  });
});

describe('converting a lead', () => {
  it('converting a lead whose email matches an existing contact offers "link to existing" rather than silently creating a duplicate', async () => {
    // The M4 acceptance criterion, in full.
    const existing = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      firstName: 'Meena',
      lastName: 'Existing',
      email: 'meena@acceptance.example',
    });
    const lead = await createLead({
      firstName: 'Meena',
      lastName: 'Existing',
      email: 'meena@acceptance.example',
    });
    const before = await counts();

    // 1. The dialog asks what converting would duplicate, and is offered the
    //    existing contact, with the reason.
    const offered = await get(`/leads/${lead.id}/conversion-matches`);
    const match = (offered.body['data'] as Match[]).find((m) => m.id === existing);
    expect(match).toBeDefined();
    expect(match?.objectType).toBe('contact');
    expect(match?.matchedOn).toContain('email');

    // 2. Converting as "create a new contact" is NOT silently allowed: it is
    //    refused with the match, and nothing was written.
    const refused = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      contact: { mode: 'create' },
      account: { mode: 'none' },
    });
    expect(refused.status).toBe(409);
    const error = refused.body['error'] as { code: string; details: { meta?: Body }[] };
    expect(error.code).toBe('DUPLICATE_RECORDS');
    expect(error.details.map((d) => d.meta?.['id'])).toContain(existing);
    expect(await counts()).toEqual(before);
    expect((await harness.fixtures.leadRow(lead.id))?.status).toBe('new');

    // The default (no explicit choice) is refused in exactly the same way.
    const byDefault = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      account: { mode: 'none' },
    });
    expect(byDefault.status).toBe(409);

    // 3. Choosing "link to existing" converts the lead onto that contact and
    //    creates no second one.
    const linked = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      contact: { mode: 'link', contactId: existing },
      account: { mode: 'none' },
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    const result = linked.body['data'] as {
      contact: { id: string; created: boolean };
      lead: Body;
    };
    expect(result.contact).toEqual({ id: existing, created: false });
    expect(result.lead['status']).toBe('converted');
    expect(result.lead['convertedContactId']).toBe(existing);
    expect(await counts()).toEqual(before);

    // The contact's history records that a lead was linked to it.
    const events = await harness.fixtures.outboxEvents(tenantId, 'contact.linked_from_lead.v1');
    expect(events.some((e) => e.recordId === existing && e.payload['leadId'] === lead.id)).toBe(
      true,
    );
  });

  it('creates an account, a contact and a deal, copies the mapped fields, and marks the lead converted', async () => {
    const lead = await createLead({
      firstName: 'Anita',
      lastName: 'Desai',
      company: 'Desai Fabrics',
      email: 'anita@desaifabrics.example',
      phone: '+919833300001',
      source: 'exhibition',
    });
    const before = await counts();

    const response = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      deal: {
        name: 'Desai first order',
        amount: { amountMinor: '250000', currency: 'INR' },
        expectedCloseDate: '2026-12-01',
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body['data'] as {
      lead: Body;
      contact: { id: string; created: boolean };
      account: { id: string; created: boolean } | null;
      deal: { id: string } | null;
      skippedFields: string[];
    };

    expect(result.contact.created).toBe(true);
    expect(result.account?.created).toBe(true);
    expect(result.deal).not.toBeNull();
    expect(result.skippedFields).toEqual([]);
    expect(await counts()).toEqual({
      contacts: before.contacts + 1,
      accounts: before.accounts + 1,
      deals: before.deals + 1,
    });

    // The lead keeps the history: what it became, and when.
    expect(result.lead['status']).toBe('converted');
    expect(result.lead['convertedContactId']).toBe(result.contact.id);
    expect(result.lead['convertedAccountId']).toBe(result.account?.id);
    expect(result.lead['convertedDealId']).toBe(result.deal?.id);
    expect(typeof result.lead['convertedAt']).toBe('string');

    // Fields were mapped across: source -> leadSource, company -> account name,
    // the email's domain -> account domain.
    const contact = (await get(`/contacts/${result.contact.id}`)).body['data'] as Body;
    expect(contact).toMatchObject({
      firstName: 'Anita',
      lastName: 'Desai',
      email: 'anita@desaifabrics.example',
      phone: '+919833300001',
      leadSource: 'exhibition',
    });
    const account = (await get(`/accounts/${result.account?.id}`)).body['data'] as Body;
    expect(account).toMatchObject({ name: 'Desai Fabrics', domain: 'desaifabrics.example' });

    // And the new records point at each other.
    const deal = (await get(`/deals/${result.deal?.id}`)).body['data'] as Body;
    expect(deal).toMatchObject({
      name: 'Desai first order',
      accountId: result.account?.id,
      primaryContactId: result.contact.id,
    });
  });

  it('writes an audit entry and an outbox event for everything it creates', async () => {
    const lead = await createLead({
      lastName: 'Audited',
      company: 'Audited Exports',
      email: 'a@auditedexports.example',
    });
    const result = (await post(`/leads/${lead.id}/convert`, { version: lead.version, deal: {} }))
      .body['data'] as {
      contact: { id: string };
      account: { id: string };
      deal: { id: string };
    };

    const audited = async (type: string, id: string) =>
      (await harness.fixtures.auditEntries(tenantId, type)).filter((e) => e.recordId === id);

    expect((await audited('contact', result.contact.id)).map((e) => e.action)).toEqual(['create']);
    expect((await audited('account', result.account.id)).map((e) => e.action)).toEqual(['create']);
    expect((await audited('deal', result.deal.id)).map((e) => e.action)).toEqual(['create']);

    const leadAudit = await audited('lead', lead.id);
    expect(leadAudit.map((e) => e.action).sort()).toEqual(['create', 'update']);
    const update = (await harness.fixtures.auditEntries(tenantId, 'lead')).find(
      (e) => e.recordId === lead.id && e.action === 'update',
    );
    const changes = update?.changes as Record<string, { old?: unknown; new?: unknown }>;
    expect(changes['status']).toEqual({ old: 'new', new: 'converted' });
    expect(changes['convertedContactId']?.new).toBe(result.contact.id);

    const has = async (type: string, id: string) =>
      (await harness.fixtures.outboxEvents(tenantId, type)).some((e) => e.recordId === id);
    expect(await has('contact.created.v1', result.contact.id)).toBe(true);
    expect(await has('account.created.v1', result.account.id)).toBe(true);
    expect(await has('deal.created.v1', result.deal.id)).toBe(true);
    const converted = (await harness.fixtures.outboxEvents(tenantId, 'lead.converted.v1')).find(
      (e) => e.recordId === lead.id,
    );
    expect(converted?.payload).toMatchObject({
      contactId: result.contact.id,
      accountId: result.account.id,
      dealId: result.deal.id,
      contactCreated: true,
      accountCreated: true,
    });
  });

  it('is one transaction: a failure at the deal leaves no contact, no account and an unconverted lead', async () => {
    const lead = await createLead({
      lastName: 'Atomic',
      company: 'Atomic Holdings',
      email: 'x@atomicholdings.example',
    });
    const before = await counts();
    const auditBefore = (await harness.fixtures.auditEntries(tenantId, 'contact')).length;
    const eventsBefore = (await harness.fixtures.outboxEvents(tenantId, 'contact.created.v1'))
      .length;

    // The contact and the account are created first; the deal then names a
    // stage that does not exist and the whole conversion must unwind.
    const response = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      deal: { stageId: '01a1443a-0000-7000-8000-000000000000' },
    });
    expect(response.status).toBe(422);

    expect(await counts()).toEqual(before);
    expect((await harness.fixtures.leadRow(lead.id))?.status).toBe('new');
    expect((await harness.fixtures.leadRow(lead.id))?.converted_contact_id).toBeNull();
    // And not even their audit entries or events survived.
    expect((await harness.fixtures.auditEntries(tenantId, 'contact')).length).toBe(auditBefore);
    expect((await harness.fixtures.outboxEvents(tenantId, 'contact.created.v1')).length).toBe(
      eventsBefore,
    );
  });

  it('is one transaction: a role that may not create deals cannot half-convert', async () => {
    const role = await harness.fixtures.createRole(tenantId, 'Converter without deals');
    for (const object of ['lead', 'contact', 'account']) {
      await harness.fixtures.grantAll(tenantId, role, object, 'all');
    }
    const user = await harness.fixtures.createUser(tenantId, role);
    const token = await harness.signIn(user.userId, tenantId);

    const lead = await createLead(
      { lastName: 'NoDeal', company: 'NoDeal Co', email: 'n@nodealco.example' },
      token,
    );
    const before = await counts();

    const response = await post(
      `/leads/${lead.id}/convert`,
      { version: lead.version, deal: {} },
      token,
    );
    expect(response.status).toBe(403);
    expect(await counts()).toEqual(before);
    expect((await harness.fixtures.leadRow(lead.id))?.status).toBe('new');

    // The same role converting without a deal is fine.
    const withoutDeal = await post(`/leads/${lead.id}/convert`, { version: lead.version }, token);
    expect(withoutDeal.status, JSON.stringify(withoutDeal.body)).toBe(200);
  });

  it('refuses a stale version without creating anything', async () => {
    const lead = await createLead({ lastName: 'Stale', email: 's@stale-co.example' });
    await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      token: admin.token,
      body: { status: 'contacted', version: lead.version },
    });
    const before = await counts();

    const response = await post(`/leads/${lead.id}/convert`, { version: lead.version });
    expect(response.status).toBe(409);
    expect((response.body['error'] as Body)['code']).toBe('VERSION_CONFLICT');
    expect(await counts()).toEqual(before);
  });

  it('lets exactly one of two simultaneous conversions win', async () => {
    const lead = await createLead({
      lastName: 'Racer',
      company: 'Racer Logistics',
      email: 'r@racerlogistics.example',
    });
    const before = await counts();

    const [first, second] = await Promise.all([
      post(`/leads/${lead.id}/convert`, { version: lead.version }),
      post(`/leads/${lead.id}/convert`, { version: lead.version }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(200);
    expect([409]).toContain(statuses[1]);

    // The loser's contact and account rolled back with it: one of each, not two.
    expect(await counts()).toEqual({
      contacts: before.contacts + 1,
      accounts: before.accounts + 1,
      deals: before.deals,
    });
    expect((await harness.fixtures.leadRow(lead.id))?.status).toBe('converted');
  });

  it('refuses to convert or edit a lead that is already converted', async () => {
    const lead = await createLead({ lastName: 'Once', email: 'once@only-once.example' });
    const first = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      account: { mode: 'none' },
    });
    expect(first.status).toBe(200);
    const row = await harness.fixtures.leadRow(lead.id);
    const before = await counts();

    const again = await post(`/leads/${lead.id}/convert`, {
      version: row!.version,
      account: { mode: 'none' },
      acknowledgeDuplicates: true,
    });
    expect(again.status).toBe(409);
    expect((again.body['error'] as Body)['code']).toBe('CONFLICT');
    expect(await counts()).toEqual(before);

    const edit = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${lead.id}`,
      token: admin.token,
      body: { lastName: 'Rewritten', version: row!.version },
    });
    expect(edit.status).toBe(409);
  });

  it('links to an existing account instead of creating one', async () => {
    const account = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Existing Anchor Account',
    });
    const lead = await createLead({
      lastName: 'Anchored',
      company: 'Existing Anchor Account',
      email: 'p@anchored-person.example',
    });
    const before = await counts();

    const response = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      account: { mode: 'link', accountId: account },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body['data'] as {
      account: { id: string; created: boolean };
      contact: { id: string };
    };
    expect(result.account).toEqual({ id: account, created: false });
    expect(await counts()).toEqual({ ...before, contacts: before.contacts + 1 });

    const contact = (await get(`/contacts/${result.contact.id}`)).body['data'] as Body;
    expect(contact['accountId']).toBe(account);
  });

  it('asks before creating an account that matches one, and accepts an acknowledgement', async () => {
    const account = await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Mahesh Brothers Pvt Ltd',
    });
    const lead = await createLead({ lastName: 'Mahesh', company: 'Mahesh Brothers' });
    const before = await counts();

    const refused = await post(`/leads/${lead.id}/convert`, { version: lead.version });
    expect(refused.status).toBe(409);
    const error = refused.body['error'] as {
      code: string;
      details: { path: string; meta?: Body }[];
    };
    expect(error.code).toBe('DUPLICATE_RECORDS');
    expect(error.details.find((d) => d.path === 'account')?.meta?.['id']).toBe(account);
    expect(await counts()).toEqual(before);

    const acknowledged = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      acknowledgeDuplicates: true,
    });
    expect(acknowledged.status, JSON.stringify(acknowledged.body)).toBe(200);
    expect(await counts()).toEqual({
      ...before,
      contacts: before.contacts + 1,
      accounts: before.accounts + 1,
    });
  });

  it('lists every match in one refusal, for contact and account together', async () => {
    await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      lastName: 'Both',
      email: 'both@bothsides.example',
    });
    await harness.fixtures.createAccount(tenantId, {
      ownerId: admin.userId,
      name: 'Bothsides Trading Company',
    });
    const lead = await createLead({
      lastName: 'Both',
      company: 'Bothsides Trading Company',
      email: 'both@bothsides.example',
    });

    const refused = await post(`/leads/${lead.id}/convert`, { version: lead.version });
    const error = refused.body['error'] as { details: { path: string }[] };
    expect(new Set(error.details.map((d) => d.path))).toEqual(new Set(['contact', 'account']));
  });

  it('converts a person with no company without an account, and refuses to invent one', async () => {
    const lead = await createLead({ lastName: 'Solo', email: 'solo@solo-person.example' });
    const before = await counts();

    const forced = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      account: { mode: 'create' },
    });
    expect(forced.status).toBe(422);
    expect(await counts()).toEqual(before);

    const response = await post(`/leads/${lead.id}/convert`, { version: lead.version });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body['data'] as { account: unknown };
    expect(result.account).toBeNull();
    expect(await counts()).toEqual({ ...before, contacts: before.contacts + 1 });
  });

  it('gives the records to the lead owner when an admin converts a rep lead', async () => {
    const lead = await createLead(
      { lastName: 'RepOwned', email: 'r@rep-owned.example' },
      rep.token,
    );
    const response = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      account: { mode: 'none' },
    });
    expect(response.status).toBe(200);
    const contactId = (response.body['data'] as { contact: { id: string } }).contact.id;
    const contact = (await get(`/contacts/${contactId}`)).body['data'] as Body;
    expect(contact['ownerId']).toBe(rep.userId);
  });

  it('copies custom fields that exist on both objects with the same key and type', async () => {
    await harness.fixtures.createCustomField(tenantId, 'lead', 'gst_note', 'text');
    await harness.fixtures.createCustomField(tenantId, 'contact', 'gst_note', 'text');
    await harness.fixtures.createCustomField(tenantId, 'lead', 'lead_only', 'text');
    await harness.fixtures.createCustomField(tenantId, 'lead', 'mismatched', 'text');
    await harness.fixtures.createCustomField(tenantId, 'contact', 'mismatched', 'number');

    const lead = await createLead({
      lastName: 'Customised',
      email: 'c@customised.example',
      customFields: { gst_note: 'regular', lead_only: 'stays', mismatched: 'text' },
    });
    const response = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      account: { mode: 'none' },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const contactId = (response.body['data'] as { contact: { id: string } }).contact.id;
    const contact = (await get(`/contacts/${contactId}`)).body['data'] as {
      customFields: Body;
    };
    expect(contact.customFields['gst_note']).toBe('regular');
    // Not a contact field at all, so it is not in the response.
    expect(contact.customFields['lead_only']).toBeUndefined();
    // A contact field of a different type: present, and left empty rather
    // than receiving text it could not hold.
    expect(contact.customFields['mismatched']).toBeNull();
  });

  it('reports fields it could not copy instead of dropping them silently', async () => {
    // May read the lead's phone, but may not write a contact's.
    const role = await harness.fixtures.createRole(tenantId, 'Converter without contact phone');
    for (const object of ['lead', 'contact', 'account']) {
      await harness.fixtures.grantAll(tenantId, role, object, 'all');
    }
    await harness.fixtures.setFieldPermission(tenantId, role, 'contact', 'phone', 'read');
    const user = await harness.fixtures.createUser(tenantId, role);
    const token = await harness.signIn(user.userId, tenantId);

    const lead = await createLead(
      { lastName: 'Skipper', email: 'k@skipper.example', phone: '+919844400001' },
      token,
    );
    const response = await post(
      `/leads/${lead.id}/convert`,
      { version: lead.version, account: { mode: 'none' } },
      token,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body['data'] as { contact: { id: string }; skippedFields: string[] };
    expect(result.skippedFields).toEqual(['contact.phone']);

    const contact = (await get(`/contacts/${result.contact.id}`)).body['data'] as Body;
    expect(contact['phone']).toBeNull();
    expect(contact['email']).toBe('k@skipper.example');
  });

  it('refuses a deal whose stage belongs to another pipeline, without creating the rest', async () => {
    const other = await harness.fixtures.createPipeline(tenantId, 'Elsewhere', [
      { name: 'Open', stageType: 'open', probability: 10 },
    ]);
    const lead = await createLead({ lastName: 'Cross', company: 'Cross Pipelines' });
    const pipelines = await harness.fixtures.pipelinesFor(tenantId);
    const main = pipelines.find((p) => p.isDefault)!;
    const before = await counts();

    const response = await post(`/leads/${lead.id}/convert`, {
      version: lead.version,
      deal: { pipelineId: main.id, stageId: other.stageIds[0] },
    });
    expect(response.status).toBe(422);
    expect(await counts()).toEqual(before);
  });
});
