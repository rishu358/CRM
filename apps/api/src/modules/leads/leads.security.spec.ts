import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10):
 *   (a) tenant A cannot list/read/update/delete tenant B records
 *   (b) a user with `own` scope cannot see other people's records
 *   (c) hidden fields are absent from responses and rejected on write
 *   (d) unauthenticated requests get 401
 *
 * Plus a fifth that only leads need: duplicate detection must never be a way
 * to find out that a record exists. A match is a statement about a record, so
 * it is held to the same tenant, scope and field rules as reading the record
 * itself (ADR-0023).
 *
 * They go through the real HTTP stack — the same guards, pipes, filter and
 * database roles as production — because every one of those layers is part of
 * what is being asserted.
 */

let harness: ApiHarness;

let tenantA: string;
let adminA: { token: string; userId: string };
let repA: { token: string; userId: string };
let otherRepA: { token: string; userId: string };

let tenantB: string;
let adminB: { token: string; userId: string };

let adminLeadA: string;
let repLeadA: string;
let leadB: string;

/** Records in tenant B that share identifying details with tenant A's. */
let contactB: string;
let accountB: string;

const SHARED_EMAIL = 'shared.person@sharedco.example';
const SHARED_PHONE = '+919800000001';
const SHARED_COMPANY = 'Sharedco Industries';

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seededA = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantA = seededA.tenantId;
  const rolesA = await harness.provision(tenantA);

  const seededB = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  tenantB = seededB.tenantId;
  const rolesB = await harness.provision(tenantB);

  const admin = await harness.fixtures.createUser(tenantA, rolesA.get('Admin')!);
  adminA = { userId: admin.userId, token: await harness.signIn(admin.userId, tenantA) };

  const rep = await harness.fixtures.createUser(tenantA, rolesA.get('Sales Rep')!);
  repA = { userId: rep.userId, token: await harness.signIn(rep.userId, tenantA) };

  const otherRep = await harness.fixtures.createUser(tenantA, rolesA.get('Sales Rep')!);
  otherRepA = { userId: otherRep.userId, token: await harness.signIn(otherRep.userId, tenantA) };

  const bAdmin = await harness.fixtures.createUser(tenantB, rolesB.get('Admin')!);
  adminB = { userId: bAdmin.userId, token: await harness.signIn(bAdmin.userId, tenantB) };

  adminLeadA = await harness.fixtures.createLead(tenantA, {
    ownerId: adminA.userId,
    lastName: 'Mehta',
    email: 'mehta@acme.example',
  });
  repLeadA = await harness.fixtures.createLead(tenantA, {
    ownerId: repA.userId,
    lastName: 'Sharma',
    email: 'sharma@acme.example',
  });
  leadB = await harness.fixtures.createLead(tenantB, {
    ownerId: adminB.userId,
    lastName: 'Rival',
    email: SHARED_EMAIL,
    phone: SHARED_PHONE,
    company: SHARED_COMPANY,
  });
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'RivalContact',
    email: SHARED_EMAIL,
    phone: SHARED_PHONE,
  });
  accountB = await harness.fixtures.createAccount(tenantB, {
    ownerId: adminB.userId,
    name: SHARED_COMPANY,
    domain: 'sharedco.example',
  });
});

afterAll(async () => {
  await harness.close();
});

interface Match {
  objectType: string;
  id: string;
  label: string;
  matchedOn: string[];
}

async function duplicateCheck(
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; matches: Match[]; raw: string }> {
  const response = await request(harness, {
    method: 'POST',
    url: '/api/v1/leads/duplicate-check',
    token,
    body,
  });
  return {
    status: response.status,
    // Tolerant on purpose: a refused probe has no data envelope.
    matches: (response.body['data'] as Match[] | undefined) ?? [],
    raw: JSON.stringify(response.body),
  };
}

describe('(d) unauthenticated requests get 401', () => {
  it('rejects every lead route with no credentials', async () => {
    const calls = [
      { method: 'GET', url: '/api/v1/leads' },
      { method: 'GET', url: `/api/v1/leads/${adminLeadA}` },
      { method: 'POST', url: '/api/v1/leads', body: { lastName: 'Intruder' } },
      { method: 'PATCH', url: `/api/v1/leads/${adminLeadA}`, body: { version: 1 } },
      { method: 'DELETE', url: `/api/v1/leads/${adminLeadA}?version=1` },
      {
        method: 'POST',
        url: `/api/v1/leads/${adminLeadA}/convert`,
        body: { version: 1 },
      },
      { method: 'GET', url: `/api/v1/leads/${adminLeadA}/conversion-matches` },
      { method: 'POST', url: '/api/v1/leads/duplicate-check', body: { email: SHARED_EMAIL } },
    ] as const;

    for (const call of calls) {
      const response = await request(harness, { ...call });
      expect(response.status, `${call.method} ${call.url}`).toBe(401);
    }
  });

  it('rejects a made-up bearer token', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads',
      token: 'not-a-real-session-token-but-long-enough',
    });
    expect(response.status).toBe(401);
  });

  it('returns the error envelope with a request id, and no stack trace', async () => {
    const response = await request(harness, { method: 'GET', url: '/api/v1/leads' });
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('UNAUTHENTICATED');
    expect(typeof error['requestId']).toBe('string');
    expect(JSON.stringify(response.body)).not.toMatch(/at .*\.ts:/);
  });
});

describe('(a) tenant A cannot reach tenant B records', () => {
  it('lists only its own tenant leads', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads',
      token: adminA.token,
    });
    expect(response.status).toBe(200);
    const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
    expect(ids).toContain(adminLeadA);
    expect(ids).toContain(repLeadA);
    expect(ids).not.toContain(leadB);
  });

  it('returns 404 for another tenant lead, not 403', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${leadB}`,
      token: adminA.token,
    });
    expect(response.status).toBe(404);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('NOT_FOUND');
  });

  it('gives the same 404 for an id that does not exist anywhere', async () => {
    const missing = '01a1443a-0000-7000-8000-000000000000';
    const absent = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${missing}`,
      token: adminA.token,
    });
    const foreign = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${leadB}`,
      token: adminA.token,
    });
    expect(absent.status).toBe(foreign.status);
    expect((absent.body['error'] as Record<string, unknown>)['message']).toBe(
      (foreign.body['error'] as Record<string, unknown>)['message'],
    );
  });

  it('cannot update, delete or convert another tenant lead', async () => {
    const patch = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${leadB}`,
      token: adminA.token,
      body: { lastName: 'Hacked', version: 1 },
    });
    expect(patch.status).toBe(404);

    const del = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/leads/${leadB}?version=1`,
      token: adminA.token,
    });
    expect(del.status).toBe(404);

    const convert = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${leadB}/convert`,
      token: adminA.token,
      body: { version: 1 },
    });
    expect(convert.status).toBe(404);

    const matches = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${leadB}/conversion-matches`,
      token: adminA.token,
    });
    expect(matches.status).toBe(404);

    const row = await harness.fixtures.leadRow(leadB);
    expect(row?.status).toBe('new');
    expect(row?.version).toBe(1);
    expect(row?.deleted_at).toBeNull();
  });

  it('cannot switch tenant with a header for a tenant it does not belong to', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads',
      token: adminA.token,
      tenantId: tenantB,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a created lead name another tenant', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/leads',
      token: adminA.token,
      body: { lastName: 'Smuggled', tenantId: tenantB },
    });
    expect(response.status).toBe(422);
  });

  it('never offers another tenant record as a duplicate, on any field', async () => {
    // Tenant B holds a lead, a contact and an account with exactly these
    // details. None of them may be named, counted or hinted at.
    const check = await duplicateCheck(adminA.token, {
      email: SHARED_EMAIL,
      phone: SHARED_PHONE,
      company: SHARED_COMPANY,
    });
    expect(check.status).toBe(200);
    expect(check.matches).toEqual([]);
    for (const secret of [leadB, contactB, accountB, 'RivalContact', 'Rival']) {
      expect(check.raw).not.toContain(secret);
    }
  });

  it('does not report another tenant record when a lead is created with its details', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/leads',
      token: adminA.token,
      body: {
        lastName: 'Lookalike',
        email: SHARED_EMAIL,
        phone: SHARED_PHONE,
        company: SHARED_COMPANY,
      },
    });
    expect(response.status).toBe(201);
    const meta = response.body['meta'] as { duplicates: Match[] };
    expect(meta.duplicates).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain(contactB);
  });

  it('cannot link a conversion to another tenant contact or account', async () => {
    const lead = await harness.fixtures.createLead(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Linker',
      company: 'Linker Co',
    });

    const contact = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${lead}/convert`,
      token: adminA.token,
      body: {
        version: 1,
        contact: { mode: 'link', contactId: contactB },
        account: { mode: 'none' },
      },
    });
    expect(contact.status).toBe(422);

    const account = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${lead}/convert`,
      token: adminA.token,
      body: {
        version: 1,
        account: { mode: 'link', accountId: accountB },
        acknowledgeDuplicates: true,
      },
    });
    expect(account.status).toBe(422);

    // Same sentence as for an id that exists nowhere, so the refusal cannot be
    // used to find out which ids belong to other companies.
    const nowhere = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${lead}/convert`,
      token: adminA.token,
      body: {
        version: 1,
        contact: { mode: 'link', contactId: '01a1443a-0000-7000-8000-000000000000' },
        account: { mode: 'none' },
      },
    });
    expect(nowhere.status).toBe(contact.status);
    expect((nowhere.body['error'] as Record<string, unknown>)['message']).toBe(
      (contact.body['error'] as Record<string, unknown>)['message'],
    );
    expect((nowhere.body['error'] as { details: unknown[] }).details).toEqual(
      (contact.body['error'] as { details: unknown[] }).details,
    );

    // And nothing was created in either tenant by the failed attempts.
    const row = await harness.fixtures.leadRow(lead);
    expect(row?.status).toBe('new');
  });
});

describe('(b) a user with own scope cannot see other people records', () => {
  it('lists only the leads the rep owns', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads',
      token: repA.token,
    });
    expect(response.status).toBe(200);
    const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
    expect(ids).toContain(repLeadA);
    expect(ids).not.toContain(adminLeadA);
  });

  it('keeps the scope on every page, including a nullable sort column', async () => {
    // Regression guard copied from contacts: the keyset predicate contains an
    // `or`, and an unbracketed fragment once detached the scope filter from
    // page two onward. Sorting by a mostly-null column is what reaches it.
    for (let index = 0; index < 8; index += 1) {
      await harness.fixtures.createLead(tenantA, {
        ownerId: adminA.userId,
        lastName: `AdminOwned${index}`,
        company: `Admin Co ${index}`,
      });
      await harness.fixtures.createLead(tenantA, {
        ownerId: repA.userId,
        lastName: `RepOwned${index}`,
        company: null,
      });
    }

    for (const sort of ['company', '-company']) {
      let cursor: string | null = null;
      let pages = 0;
      const seen: string[] = [];

      do {
        const query = new URLSearchParams({ limit: '3', sort });
        if (cursor !== null) query.set('cursor', cursor);
        const response = await request(harness, {
          method: 'GET',
          url: `/api/v1/leads?${query.toString()}`,
          token: repA.token,
        });
        expect(response.status, sort).toBe(200);

        for (const row of dataOf<{ id: string; ownerId?: string }[]>(response)) {
          seen.push(row.id);
          expect(row.ownerId, `${sort}: a record owned by someone else`).toBe(repA.userId);
        }
        cursor = (response.body['meta'] as { nextCursor: string | null }).nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 30);

      expect(cursor, `${sort}: paging never ended`).toBeNull();
      expect(new Set(seen).size, `${sort}: a row came back twice`).toBe(seen.length);
    }
  });

  it('returns 404 reading, updating or converting a colleague lead', async () => {
    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${adminLeadA}`,
      token: repA.token,
    });
    expect(read.status).toBe(404);

    const update = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${adminLeadA}`,
      token: repA.token,
      body: { lastName: 'Taken', version: 1 },
    });
    expect(update.status).toBe(404);

    const convert = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${adminLeadA}/convert`,
      token: repA.token,
      body: { version: 1 },
    });
    expect(convert.status).toBe(404);

    const row = await harness.fixtures.leadRow(adminLeadA);
    expect(row?.status).toBe('new');
  });

  it('refuses the rep deleting anything: Sales Rep has no delete grant', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/leads/${repLeadA}?version=1`,
      token: repA.token,
    });
    expect(response.status).toBe(403);
  });

  it('does not let a rep assign a lead to someone else', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/leads',
      token: repA.token,
      body: { lastName: 'Handover', ownerId: otherRepA.userId },
    });
    expect(response.status).toBe(422);
  });

  it('assigns a rep own new leads to themselves', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/leads',
      token: repA.token,
      body: { lastName: 'Patel' },
    });
    expect(response.status).toBe(201);
    expect(dataOf<Record<string, unknown>>(response)['ownerId']).toBe(repA.userId);
  });

  it('lets an admin with all scope see every lead in the tenant', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads',
      token: adminA.token,
    });
    const ids = dataOf<{ id: string }[]>(response).map((row) => row.id);
    expect(ids).toContain(adminLeadA);
    expect(ids).toContain(repLeadA);
  });
});

describe('duplicate detection respects the actor record scope', () => {
  // A colleague's records with details the rep will type. The rep may not read
  // any of them, so none may be named, counted or hinted at.
  const COLLEAGUE_EMAIL = 'colleague.only@secretco.example';
  const COLLEAGUE_PHONE = '+919800000077';
  const COLLEAGUE_COMPANY = 'Secretco Holdings';
  let colleagueLead: string;
  let colleagueContact: string;
  let colleagueAccount: string;

  beforeAll(async () => {
    colleagueLead = await harness.fixtures.createLead(tenantA, {
      ownerId: otherRepA.userId,
      lastName: 'ColleagueLead',
      email: COLLEAGUE_EMAIL,
      phone: COLLEAGUE_PHONE,
    });
    colleagueContact = await harness.fixtures.createContact(tenantA, {
      ownerId: otherRepA.userId,
      lastName: 'ColleagueContact',
      email: COLLEAGUE_EMAIL,
      phone: COLLEAGUE_PHONE,
    });
    colleagueAccount = await harness.fixtures.createAccount(tenantA, {
      ownerId: otherRepA.userId,
      name: COLLEAGUE_COMPANY,
      domain: 'secretco.example',
    });
  });

  it('offers a colleague record to the colleague, who may read it', async () => {
    const check = await duplicateCheck(otherRepA.token, {
      email: COLLEAGUE_EMAIL,
      phone: COLLEAGUE_PHONE,
      company: COLLEAGUE_COMPANY,
    });
    const ids = check.matches.map((match) => match.id);
    expect(ids).toContain(colleagueLead);
    expect(ids).toContain(colleagueContact);
    expect(ids).toContain(colleagueAccount);
  });

  it('does not offer them to a rep with own scope, on any match field', async () => {
    const check = await duplicateCheck(repA.token, {
      email: COLLEAGUE_EMAIL,
      phone: COLLEAGUE_PHONE,
      company: COLLEAGUE_COMPANY,
    });
    expect(check.status).toBe(200);
    expect(check.matches).toEqual([]);
    for (const secret of [
      colleagueLead,
      colleagueContact,
      colleagueAccount,
      'ColleagueLead',
      'ColleagueContact',
      COLLEAGUE_COMPANY,
    ]) {
      expect(check.raw).not.toContain(secret);
    }
  });

  it('answers identically for out-of-scope records and for ones that do not exist', async () => {
    const real = await duplicateCheck(repA.token, { email: COLLEAGUE_EMAIL });
    const imaginary = await duplicateCheck(repA.token, { email: 'nobody.at.all@nowhere.example' });
    expect(real.status).toBe(imaginary.status);
    expect(real.matches).toEqual(imaginary.matches);
  });

  it('does not report them when the rep creates a lookalike lead', async () => {
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/leads',
      token: repA.token,
      body: { lastName: 'Lookalike', email: COLLEAGUE_EMAIL, company: COLLEAGUE_COMPANY },
    });
    expect(response.status).toBe(201);
    expect((response.body['meta'] as { duplicates: Match[] }).duplicates).toEqual([]);
  });

  it('does not report them in the conversion matches of the rep own lead', async () => {
    const lead = await harness.fixtures.createLead(tenantA, {
      ownerId: repA.userId,
      lastName: 'Convertible',
      email: COLLEAGUE_EMAIL,
      company: COLLEAGUE_COMPANY,
    });
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${lead}/conversion-matches`,
      token: repA.token,
    });
    expect(response.status).toBe(200);
    // The rep's own earlier lookalike lead may legitimately appear; the
    // colleague's three records may not.
    const ids = dataOf<Match[]>(response).map((match) => match.id);
    for (const hidden of [colleagueLead, colleagueContact, colleagueAccount]) {
      expect(ids).not.toContain(hidden);
    }
    expect(JSON.stringify(response.body)).not.toContain('Colleague');
  });

  it('refuses to link a conversion to a colleague out-of-scope contact or account', async () => {
    const lead = await harness.fixtures.createLead(tenantA, {
      ownerId: repA.userId,
      lastName: 'Adopter',
    });
    const contact = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${lead}/convert`,
      token: repA.token,
      body: {
        version: 1,
        contact: { mode: 'link', contactId: colleagueContact },
        account: { mode: 'none' },
      },
    });
    expect(contact.status).toBe(422);

    const account = await request(harness, {
      method: 'POST',
      url: `/api/v1/leads/${lead}/convert`,
      token: repA.token,
      body: {
        version: 1,
        account: { mode: 'link', accountId: colleagueAccount },
      },
    });
    expect(account.status).toBe(422);
    expect((await harness.fixtures.leadRow(lead))?.status).toBe('new');
  });

  it('does not offer matches to a role that cannot read those objects at all', async () => {
    // Can create and read leads, but has no grant on contacts or accounts.
    const role = await harness.fixtures.createRole(tenantA, 'Leads only');
    await harness.fixtures.grantAll(tenantA, role, 'lead', 'all');
    const user = await harness.fixtures.createUser(tenantA, role);
    const token = await harness.signIn(user.userId, tenantA);

    const check = await duplicateCheck(token, {
      email: COLLEAGUE_EMAIL,
      company: COLLEAGUE_COMPANY,
    });
    expect(check.status).toBe(200);
    // Leads only: no contact and no account, and no error that says why.
    const kinds = new Set(check.matches.map((match) => match.objectType));
    expect([...kinds]).toEqual(['lead']);
    expect(check.matches.map((match) => match.id)).toContain(colleagueLead);
  });
});

describe('(c) hidden fields are absent from responses and rejected on write', () => {
  let hiddenRepToken: string;
  let readOnlyFieldRepToken: string;
  let ownedLead: string;

  beforeAll(async () => {
    const hiddenRole = await harness.fixtures.createRole(tenantA, 'Rep without phone');
    await harness.fixtures.grantAll(tenantA, hiddenRole, 'lead', 'all');
    await harness.fixtures.grantAll(tenantA, hiddenRole, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'lead', 'phone', 'hidden');
    await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'contact', 'phone', 'hidden');

    const readOnlyRole = await harness.fixtures.createRole(tenantA, 'Rep with locked source');
    await harness.fixtures.grantAll(tenantA, readOnlyRole, 'lead', 'all');
    await harness.fixtures.setFieldPermission(tenantA, readOnlyRole, 'lead', 'source', 'read');

    const hiddenUser = await harness.fixtures.createUser(tenantA, hiddenRole);
    hiddenRepToken = await harness.signIn(hiddenUser.userId, tenantA);

    const readOnlyUser = await harness.fixtures.createUser(tenantA, readOnlyRole);
    readOnlyFieldRepToken = await harness.signIn(readOnlyUser.userId, tenantA);

    ownedLead = await harness.fixtures.createLead(tenantA, {
      ownerId: hiddenUser.userId,
      lastName: 'Iyer',
      email: 'iyer@acme.example',
      phone: '+919876500000',
      source: 'referral',
    });
  });

  it('omits the hidden field from a single-record response', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${ownedLead}`,
      token: hiddenRepToken,
    });
    expect(response.status).toBe(200);
    const lead = dataOf<Record<string, unknown>>(response);
    // Absent, not null: a null would still confirm the field exists and is set.
    expect('phone' in lead).toBe(false);
    expect(lead['lastName']).toBe('Iyer');
  });

  it('omits the hidden field from every row of a list, and never leaks the value', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads',
      token: hiddenRepToken,
    });
    const rows = dataOf<Record<string, unknown>[]>(response);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect('phone' in row).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain('919876500000');
  });

  it('rejects a write to a hidden field instead of dropping it, on update and create', async () => {
    const update = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${ownedLead}`,
      token: hiddenRepToken,
      body: { phone: '+919000000000', version: 1 },
    });
    expect(update.status).toBe(403);
    expect((update.body['error'] as Record<string, unknown>)['code']).toBe('FIELD_NOT_WRITABLE');

    const create = await request(harness, {
      method: 'POST',
      url: '/api/v1/leads',
      token: hiddenRepToken,
      body: { lastName: 'Nair', phone: '+919000000001' },
    });
    expect(create.status).toBe(403);

    const check = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${ownedLead}`,
      token: adminA.token,
    });
    expect(dataOf<Record<string, unknown>>(check)['phone']).toBe('+919876500000');
  });

  it('rejects a write to a read-only field, and still shows it', async () => {
    const response = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/leads/${ownedLead}`,
      token: readOnlyFieldRepToken,
      body: { source: 'website', version: 1 },
    });
    expect(response.status).toBe(403);

    const read = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${ownedLead}`,
      token: readOnlyFieldRepToken,
    });
    expect(dataOf<Record<string, unknown>>(read)['source']).toBe('referral');
  });

  it('refuses to sort or filter by a field the caller cannot read', async () => {
    // Otherwise `filter=phone:starts_with:+9198` is a character-at-a-time read.
    const filter = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads?filter=${encodeURIComponent('phone:starts_with:+91987')}`,
      token: hiddenRepToken,
    });
    expect(filter.status).toBe(422);

    const sort = await request(harness, {
      method: 'GET',
      url: '/api/v1/leads?sort=phone',
      token: hiddenRepToken,
    });
    expect(sort.status).toBe(422);
  });

  it('does not match on a hidden field, so a match cannot reveal a hidden value', async () => {
    // A contact holds this phone. The caller cannot read contact phones, so
    // typing the number must learn nothing — otherwise duplicate detection is
    // a way to test guesses against a field they are not allowed to see.
    const phone = '+919811122233';
    await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'PhoneHolder',
      phone,
    });

    const hidden = await duplicateCheck(hiddenRepToken, { phone });
    expect(hidden.matches).toEqual([]);

    // The same question from somebody who may read phones does find it.
    const visible = await duplicateCheck(adminA.token, { phone });
    expect(visible.matches.map((match) => match.objectType)).toContain('contact');
  });

  it('does not use a hidden lead value to look for conversion matches', async () => {
    const phone = '+919811122244';
    await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      lastName: 'AnotherPhoneHolder',
      phone,
    });
    const lead = await harness.fixtures.createLead(tenantA, {
      ownerId: adminA.userId,
      lastName: 'Probe',
      phone,
    });

    const hidden = await request(harness, {
      method: 'GET',
      url: `/api/v1/leads/${lead}/conversion-matches`,
      token: hiddenRepToken,
    });
    expect(hidden.status).toBe(200);
    expect(dataOf(hidden)).toEqual([]);
  });

  it('builds match labels only from fields the caller may read', async () => {
    const role = await harness.fixtures.createRole(tenantA, 'Contacts without names');
    await harness.fixtures.grantAll(tenantA, role, 'lead', 'all');
    await harness.fixtures.grantAll(tenantA, role, 'contact', 'all');
    await harness.fixtures.setFieldPermission(tenantA, role, 'contact', 'last_name', 'hidden');
    await harness.fixtures.setFieldPermission(tenantA, role, 'contact', 'first_name', 'hidden');
    const user = await harness.fixtures.createUser(tenantA, role);
    const token = await harness.signIn(user.userId, tenantA);

    await harness.fixtures.createContact(tenantA, {
      ownerId: adminA.userId,
      firstName: 'Concealed',
      lastName: 'Surname',
      email: 'labelled@label.example',
    });

    const check = await duplicateCheck(token, { email: 'labelled@label.example' });
    const contact = check.matches.find((match) => match.objectType === 'contact');
    expect(contact?.label).toBe('Contact');
    expect(check.raw).not.toContain('Concealed');
    expect(check.raw).not.toContain('Surname');
  });
});
