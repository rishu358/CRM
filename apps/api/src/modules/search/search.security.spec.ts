import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * The four mandatory per-module security suites (CLAUDE.md §10):
 *   (a) tenant A cannot see tenant B's records
 *   (b) a user with `own` scope cannot see other people's records
 *   (c) hidden fields are absent from responses — and here, unsearchable
 *   (d) unauthenticated requests get 401
 *
 * Search earns a longer file than most modules because of what it is: **one
 * read path that deliberately crosses every object**, answering a string the
 * caller typed. Every other read path is a question about a record the caller
 * already named; this one is a question about records they have not. So it is
 * the easiest place in the product to leak from, and four of the tests below
 * cover ways to leak that no other module has:
 *
 *   1. **the snippet.** Stripping a hidden field from the payload and then
 *      quoting the text around the match puts the field's contents in the
 *      response anyway. Here the snippet is the matched field's own value and
 *      the match could only ever be on a readable field, so this is
 *      structural — and tested, because "structural" is a claim.
 *   2. **matching alone is an answer.** A record that is returned *only*
 *      because a hidden value matched tells the caller that value, one guess
 *      at a time, without ever showing it.
 *   3. **the index is a copy.** It holds owner ids and text that were true
 *      when the relay last ran. A record reassigned or deleted since then is
 *      visible to the index and must not be visible in the answer.
 *   4. **scope is per object type.** A rep may hold `all` on contacts and
 *      `own` on deals, so one predicate for the whole query would be wrong
 *      for at least one of them.
 *
 * Everything goes through the real HTTP stack and the real indexer.
 */
let harness: ApiHarness;

/** Tenant A: an admin with `all`, and two reps with `own`. */
let tenantA: string;
let repRoleA: string;
let admin: { token: string; userId: string };
let rep: { token: string; userId: string };
let otherRep: { token: string; userId: string };
/** Somebody with a role that grants nothing at all. */
let outsider: { token: string; userId: string };

/** Tenant B: a different company, holding deliberately identical values. */
let tenantB: string;
let adminB: { token: string; userId: string };

let adminContact: string;
let repContact: string;
let adminDeal: string;
let repDeal: string;
let adminActivity: string;
let repActivity: string;
let secretContact: string;
let hiddenEmailContact: string;
let leadWithEmail: string;
let contactB: string;

/** The address tenant B holds. Nobody in tenant A may ever see it. */
const RIVAL_EMAIL = 'rival.trader@rivaltraders.example';
/** The address only a hidden field on a contact holds. */
const SECRET_EMAIL = 'quietmole@confidential.example';
/** A lead's address. The same **key**, `email`, on a different object type. */
const LEAD_EMAIL = 'chandran@leadmail.example';

type Result = {
  objectType: string;
  id: string;
  title: string;
  matchedField: string;
  snippet: string;
};

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seededA = await harness.fixtures.createTenant({ name: 'Acme Jewellers' });
  tenantA = seededA.tenantId;
  const rolesA = await harness.provision(tenantA);

  const seededB = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  tenantB = seededB.tenantId;
  const rolesB = await harness.provision(tenantB);

  const adminUser = await harness.fixtures.createUser(tenantA, rolesA.get('Admin')!);
  admin = { userId: adminUser.userId, token: await harness.signIn(adminUser.userId, tenantA) };

  repRoleA = rolesA.get('Sales Rep')!;
  const repUser = await harness.fixtures.createUser(tenantA, repRoleA);
  rep = { userId: repUser.userId, token: await harness.signIn(repUser.userId, tenantA) };
  const otherUser = await harness.fixtures.createUser(tenantA, repRoleA);
  otherRep = { userId: otherUser.userId, token: await harness.signIn(otherUser.userId, tenantA) };

  // A role with no grants at all, to prove default deny is an empty answer
  // rather than an error that confirms the workspace has records in it.
  const emptyRole = await harness.fixtures.createRole(tenantA, 'No grants');
  const outsiderUser = await harness.fixtures.createUser(tenantA, emptyRole);
  outsider = {
    userId: outsiderUser.userId,
    token: await harness.signIn(outsiderUser.userId, tenantA),
  };

  const adminBUser = await harness.fixtures.createUser(tenantB, rolesB.get('Admin')!);
  adminB = { userId: adminBUser.userId, token: await harness.signIn(adminBUser.userId, tenantB) };

  const [pipelineA] = await harness.fixtures.pipelinesFor(tenantA);

  adminContact = await harness.fixtures.createContact(tenantA, {
    ownerId: admin.userId,
    firstName: 'Shared',
    lastName: 'Trefoil',
    email: 'admin.trefoil@acme.example',
    phone: '+919000000001',
  });
  repContact = await harness.fixtures.createContact(tenantA, {
    ownerId: rep.userId,
    firstName: 'Shared',
    lastName: 'Trefoil',
    email: 'rep.trefoil@acme.example',
    phone: '+919000000002',
  });
  adminDeal = await harness.fixtures.createDeal(tenantA, {
    ownerId: admin.userId,
    pipelineId: pipelineA!.id,
    stageId: pipelineA!.stages[0]!.id,
    name: 'Trefoil admin order',
  });
  repDeal = await harness.fixtures.createDeal(tenantA, {
    ownerId: rep.userId,
    pipelineId: pipelineA!.id,
    stageId: pipelineA!.stages[0]!.id,
    name: 'Trefoil rep order',
  });
  adminActivity = await harness.fixtures.createActivity(tenantA, {
    assignedTo: admin.userId,
    subject: 'Trefoil admin follow-up',
  });
  repActivity = await harness.fixtures.createActivity(tenantA, {
    assignedTo: rep.userId,
    subject: 'Trefoil rep follow-up',
  });

  // Matches **only** on a field the rep may not read, so returning it at all
  // would answer a question about a hidden value.
  secretContact = await harness.fixtures.createContact(tenantA, {
    ownerId: rep.userId,
    firstName: 'Padma',
    lastName: 'Narayanan',
    email: SECRET_EMAIL,
  });
  // Matches on a readable field *and* holds a hidden one, so the snippet has
  // something safe to be and something unsafe to accidentally become. Its
  // name deliberately shares no word with the address, or matching the name
  // would not prove where the snippet came from.
  hiddenEmailContact = await harness.fixtures.createContact(tenantA, {
    ownerId: rep.userId,
    firstName: 'Hemalatha',
    lastName: 'Sundaram',
    email: SECRET_EMAIL,
  });
  // The same **key**, `email`, on another object type, to prove a field
  // permission is per object and not per name.
  leadWithEmail = await harness.fixtures.createLead(tenantA, {
    ownerId: rep.userId,
    lastName: 'Chandran',
    email: LEAD_EMAIL,
  });

  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    firstName: 'Shared',
    lastName: 'Trefoil',
    email: RIVAL_EMAIL,
    phone: '+919000000001',
  });
  await harness.fixtures.createAccount(tenantB, {
    ownerId: adminB.userId,
    name: 'Trefoil Rival Holdings',
    domain: 'rivaltraders.example',
  });

  // `email` is hidden for the Sales Rep role, on contacts only.
  await harness.fixtures.setFieldPermission(tenantA, repRoleA, 'contact', 'email', 'hidden');

  await harness.indexForSearch(tenantA);
  await harness.indexForSearch(tenantB);
});

afterAll(async () => {
  await harness.close();
});

async function search(
  term: string,
  token?: string,
  tenantId?: string,
): Promise<{ status: number; body: Record<string, unknown>; results: Result[] }> {
  const response = await request(harness, {
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(term)}&limit=25`,
    token,
    tenantId,
  });
  return {
    status: response.status,
    body: response.body,
    results: (response.body['data'] as Result[] | undefined) ?? [],
  };
}

function ids(results: readonly Result[]): string[] {
  return results.map((result) => result.id);
}

// ---------------------------------------------------------------------------
// (a) Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('never returns another tenant record, on any field', async () => {
    // Every value tenant B holds, searched from tenant A: the shared name,
    // the exact address, the shared phone number, the company name.
    for (const term of [
      RIVAL_EMAIL,
      'rivaltraders.example',
      'Rival Holdings',
      '+919000000001',
      'Trefoil',
    ]) {
      const { results } = await search(term, admin.token);
      expect(ids(results)).not.toContain(contactB);
      for (const result of results) {
        expect(JSON.stringify(result)).not.toContain('rival');
      }
    }
  });

  it('is not an existence oracle for an address in another tenant', async () => {
    // The answer for a value that exists next door must be identical to the
    // answer for one that exists nowhere (CLAUDE.md §5.5).
    const next = await search(RIVAL_EMAIL, admin.token);
    const nowhere = await search('nobody.at.all@nowhere.example', admin.token);
    expect(next.status).toBe(nowhere.status);
    expect(next.body['data']).toEqual(nowhere.body['data']);
  });

  it('does not let a header name somebody else workspace', async () => {
    // `X-Tenant-Id` is re-checked against membership (CLAUDE.md §5.2), so
    // pointing it at tenant B is refused rather than honoured.
    const { status, results } = await search('Trefoil', admin.token, tenantB);
    expect(status === 403 || results.length === 0).toBe(true);
    expect(ids(results)).not.toContain(contactB);
  });

  it('keeps tenant B from seeing tenant A, symmetrically', async () => {
    const found = ids((await search('Trefoil', adminB.token)).results);
    expect(found).toContain(contactB);
    for (const id of [adminContact, repContact, adminDeal, repDeal, adminActivity, repActivity]) {
      expect(found).not.toContain(id);
    }
  });
});

// ---------------------------------------------------------------------------
// (b) Record scope
// ---------------------------------------------------------------------------

describe('record scope', () => {
  it('shows a rep only their own records, across every object type', async () => {
    const { results } = await search('Trefoil', rep.token);
    const found = ids(results);

    expect(found).toContain(repContact);
    expect(found).toContain(repDeal);
    expect(found).toContain(repActivity);

    expect(found).not.toContain(adminContact);
    expect(found).not.toContain(adminDeal);
    expect(found).not.toContain(adminActivity);
  });

  it('shows an admin with `all` scope both', async () => {
    const found = ids((await search('Trefoil', admin.token)).results);
    expect(found).toContain(adminContact);
    expect(found).toContain(repContact);
    expect(found).toContain(adminDeal);
    expect(found).toContain(repDeal);
  });

  it('shows a second rep neither of the first rep records', async () => {
    const found = ids((await search('Trefoil', otherRep.token)).results);
    expect(found).not.toContain(repContact);
    expect(found).not.toContain(repDeal);
    expect(found).not.toContain(adminContact);
  });

  it('applies scope per object type, not once for the whole query', async () => {
    // The real shape of a manager's permissions: wide on one object, narrow
    // on another. One predicate for the whole query would be wrong for one
    // of them, and the wrong one is the one that leaks.
    const mixedRole = await harness.fixtures.createRole(tenantA, 'Mixed scope');
    await harness.fixtures.grantAll(tenantA, mixedRole, 'contact', 'all');
    await harness.fixtures.grantAll(tenantA, mixedRole, 'deal', 'own');
    const user = await harness.fixtures.createUser(tenantA, mixedRole);
    const token = await harness.signIn(user.userId, tenantA);

    const found = ids((await search('Trefoil', token)).results);

    // `all` on contacts: both reps' people are visible.
    expect(found).toContain(adminContact);
    expect(found).toContain(repContact);
    // `own` on deals, and they own none: neither deal is.
    expect(found).not.toContain(adminDeal);
    expect(found).not.toContain(repDeal);
  });

  it('drops a record reassigned out of scope before the index catches up', async () => {
    // The index carries a **copy** of the owner, written when the relay last
    // ran. Between a reassignment and the next event being relayed it says
    // the rep still owns this record. The live re-resolve is what closes that
    // window (ADR-0028 §5), and this test deliberately does not reindex.
    const moving = await harness.fixtures.createContact(tenantA, {
      ownerId: rep.userId,
      firstName: 'Transient',
      lastName: 'Ownership',
    });
    await harness.indexForSearch(tenantA);
    expect(ids((await search('Transient', rep.token)).results)).toContain(moving);

    const before = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${moving}`,
      token: admin.token,
    });
    const version = (before.body['data'] as { version: number }).version;
    const reassigned = await request(harness, {
      method: 'PATCH',
      url: `/api/v1/contacts/${moving}`,
      token: admin.token,
      body: { ownerId: admin.userId, version },
    });
    expect(reassigned.status).toBe(200);

    expect(ids((await search('Transient', rep.token)).results)).not.toContain(moving);
    expect(ids((await search('Transient', admin.token)).results)).toContain(moving);
  });
});

// ---------------------------------------------------------------------------
// (c) Field-level permissions, and the snippet
// ---------------------------------------------------------------------------

describe('field permissions', () => {
  it('does not match on a field the caller may not read', async () => {
    // The admin can find this address; the rep, for whom `contact.email` is
    // hidden, cannot — even though they own the record.
    expect(ids((await search(SECRET_EMAIL, admin.token)).results)).toContain(secretContact);
    expect(ids((await search(SECRET_EMAIL, rep.token)).results)).not.toContain(secretContact);
  });

  it('does not return a record that matched only on a hidden field', async () => {
    // Returning it without the value would still answer "is this address in
    // the workspace", one guess at a time. `confidential` is a word no
    // readable field anywhere in this tenant contains, so an empty answer is
    // the whole assertion.
    const { results } = await search('confidential', rep.token);
    expect(ids(results)).not.toContain(secretContact);
    expect(results).toEqual([]);

    // The admin, who may read the field, gets both records that hold it.
    const visible = ids((await search('confidential', admin.token)).results);
    expect(visible).toContain(secretContact);
    expect(visible).toContain(hiddenEmailContact);
  });

  it('never quotes a hidden field in a snippet', async () => {
    // This record matches a readable field (`first_name` is "Hemalatha") and
    // also holds the hidden address, which shares no word with the name. The
    // snippet must be the name, and the address must appear nowhere in the
    // response — the leak a `ts_headline` over the whole record would be.
    const { results, body } = await search('Hemalatha', rep.token);
    const hit = results.find((result) => result.id === hiddenEmailContact);

    expect(hit).toBeDefined();
    expect(hit?.matchedField).toBe('first_name');
    expect(hit?.snippet).toBe('Hemalatha');
    expect(JSON.stringify(body)).not.toContain(SECRET_EMAIL);
    expect(JSON.stringify(body)).not.toContain('confidential.example');
  });

  it('gives the admin the same record with the hidden field quoted', async () => {
    // The inverse of the test above: the field is only hidden for a role, and
    // the one who may read it still gets the match and the snippet.
    const { results } = await search(SECRET_EMAIL, admin.token);
    const hit = results.find((result) => result.id === hiddenEmailContact);
    expect(hit?.matchedField).toBe('email');
    expect(hit?.snippet).toBe(SECRET_EMAIL);
  });

  it('hides a field on one object type without hiding it on another', async () => {
    // `email` is hidden on contacts for this role and nothing was said about
    // leads, so a lead is still findable — and quotable — by its address.
    const lead = (await search(LEAD_EMAIL, rep.token)).results;
    expect(ids(lead)).toContain(leadWithEmail);
    expect(lead.find((result) => result.id === leadWithEmail)?.matchedField).toBe('email');

    // The same role, the same key, the other object type: nothing.
    const contacts = ids((await search(SECRET_EMAIL, rep.token)).results);
    expect(contacts).not.toContain(secretContact);
    expect(contacts).not.toContain(hiddenEmailContact);
  });

  it('searches no object at all when every searchable field on it is hidden', async () => {
    // A deal has one searchable field. Hide it and the object type should
    // drop out of the query entirely rather than be matched on and filtered.
    const role = await harness.fixtures.createRole(tenantA, 'Deal name hidden');
    await harness.fixtures.grantAll(tenantA, role, 'deal', 'all');
    await harness.fixtures.setFieldPermission(tenantA, role, 'deal', 'name', 'hidden');
    const user = await harness.fixtures.createUser(tenantA, role);
    const token = await harness.signIn(user.userId, tenantA);

    const { status, results } = await search('Trefoil', token);
    expect(status).toBe(200);
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) Authentication, and default deny
// ---------------------------------------------------------------------------

describe('authentication and default deny', () => {
  it('refuses an unauthenticated request', async () => {
    const { status } = await search('Trefoil');
    expect(status).toBe(401);
  });

  it('refuses a request carrying a token that is not a session', async () => {
    const { status } = await search('Trefoil', 'not-a-real-session-token');
    expect(status).toBe(401);
  });

  it('answers a caller with no grants with an empty list, not a 403', async () => {
    // Search is a question about your own workspace. A 403 would be the one
    // answer that distinguishes "you may read nothing" from "there is nothing
    // here", and neither is worth telling them.
    const { status, results } = await search('Trefoil', outsider.token);
    expect(status).toBe(200);
    expect(results).toEqual([]);
  });

  it('does not let a long query be used to probe', async () => {
    // Bounded by the contract, so a generated query is a 422 rather than a
    // large amount of work (CLAUDE.md §5.6).
    const response = await request(harness, {
      method: 'GET',
      url: `/api/v1/search?q=${'a'.repeat(500)}`,
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });
});
