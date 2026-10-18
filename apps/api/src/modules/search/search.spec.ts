import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApiHarness, request, type ApiHarness } from '../../testing/harness.js';

/**
 * Global search, through the real HTTP stack (MVP_SPEC §M7, ADR-0028).
 *
 * This file is about whether search **works**: that it reaches every object,
 * that the best answer comes first, that a fragment of an address or a number
 * finds the person, and that a typo still does. Whether it leaks is
 * `search.security.spec.ts`, which is the harder question and has its own
 * file for that reason.
 *
 * The index is built by `harness.indexForSearch`, which runs the same
 * projection the outbox relay runs, as the same database role. Nothing here
 * writes an index row by hand, because a test that invents its own index
 * proves only that the query matches what the test wrote.
 */
let harness: ApiHarness;
let tenantId: string;
let admin: { token: string; userId: string };

type Result = {
  objectType: string;
  id: string;
  title: string;
  matchedField: string;
  snippet: string;
};

let contactId: string;
let accountId: string;
let leadId: string;
let dealId: string;
let activityId: string;
let namesakeContactId: string;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));

  const seeded = await harness.fixtures.createTenant({ name: 'Search Works' });
  tenantId = seeded.tenantId;
  const roles = await harness.provision(tenantId);

  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };

  accountId = await harness.fixtures.createAccount(tenantId, {
    ownerId: admin.userId,
    name: 'Kulkarni Silks',
    domain: 'kulkarnisilks.example',
    phone: '+919822011001',
  });
  contactId = await harness.fixtures.createContact(tenantId, {
    ownerId: admin.userId,
    firstName: 'Anjali',
    lastName: 'Deshmukh',
    email: 'anjali.deshmukh@kulkarnisilks.example',
    phone: '+919876543210',
  });
  // Shares a first name with the contact and nothing else, so a two-word
  // query has something to rank *below* the record that matches both words.
  namesakeContactId = await harness.fixtures.createContact(tenantId, {
    ownerId: admin.userId,
    firstName: 'Anjali',
    lastName: 'Bhatt',
  });
  leadId = await harness.fixtures.createLead(tenantId, {
    ownerId: admin.userId,
    firstName: 'Imran',
    lastName: 'Qureshi',
    company: 'Qureshi Leather Works',
  });
  const [pipeline] = await harness.fixtures.pipelinesFor(tenantId);
  dealId = await harness.fixtures.createDeal(tenantId, {
    ownerId: admin.userId,
    pipelineId: pipeline!.id,
    stageId: pipeline!.stages[0]!.id,
    name: 'Festival collection order',
  });
  activityId = await harness.fixtures.createActivity(tenantId, {
    assignedTo: admin.userId,
    subject: 'Call Kulkarni about the festival order',
  });

  await harness.indexForSearch(tenantId);
});

afterAll(async () => {
  await harness.close();
});

async function search(term: string, token = admin.token, limit?: number): Promise<Result[]> {
  const query = limit === undefined ? '' : `&limit=${String(limit)}`;
  const response = await request(harness, {
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(term)}${query}`,
    token,
  });
  expect(response.status).toBe(200);
  return response.body['data'] as Result[];
}

function ids(results: readonly Result[]): string[] {
  return results.map((result) => result.id);
}

describe('global search', () => {
  it('finds a record on a prefix, so results appear while you type', async () => {
    expect(ids(await search('deshm'))).toContain(contactId);
  });

  it('reaches every object type in one query', async () => {
    // "kulkarni" is in an account name, a contact's email domain and an
    // activity's subject — one query, three kinds of record.
    const found = await search('kulkarni');
    const types = new Set(found.map((result) => result.objectType));
    expect(types).toContain('account');
    expect(types).toContain('contact');
    expect(types).toContain('activity');

    expect(ids(await search('Qureshi'))).toContain(leadId);
    expect(ids(await search('Festival'))).toContain(dealId);
    expect(ids(await search('festival order'))).toContain(activityId);
  });

  it('puts the record that matched both words first', async () => {
    const found = await search('anjali deshmukh');
    expect(found[0]?.id).toBe(contactId);
    // The namesake still appears — a second word narrows the ranking, it does
    // not throw away everyone who matched the first.
    expect(ids(found)).toContain(namesakeContactId);
  });

  it('matches a fragment of an email address', async () => {
    // The whole address is one full-text token, so this only works because
    // the indexer and the tokenizer fold `.` and `@` the same way.
    const found = await search('deshmukh@kulkarnisilks.example');
    expect(ids(found)).toContain(contactId);
  });

  it('matches a block of a phone number', async () => {
    expect(ids(await search('9876543210'))).toContain(contactId);
    expect(ids(await search('+91 9822011001'))).toContain(accountId);
  });

  it('survives a typo, via the trigram pass', async () => {
    // No full-text token begins "kulkarmi"; pg_trgm is the only thing that
    // can reach this record (ADR-0028 §4).
    expect(ids(await search('kulkarmi'))).toContain(accountId);
  });

  it('says which field matched, and quotes only that field', async () => {
    const [hit] = await search('deshmukh@kulkarnisilks.example');
    expect(hit?.objectType).toBe('contact');
    expect(hit?.matchedField).toBe('email');
    expect(hit?.snippet).toBe('anjali.deshmukh@kulkarnisilks.example');
    // The title comes from the owning module's label, not from the index.
    expect(hit?.title).toBe('Anjali Deshmukh');
  });

  it('waits for a second character rather than scanning on one', async () => {
    expect(await search('a')).toEqual([]);
    expect(await search('   ')).toEqual([]);
    expect(await search('@@@')).toEqual([]);
  });

  it('honours the limit', async () => {
    expect((await search('anjali', admin.token, 1)).length).toBe(1);
  });

  it('refuses a limit past the ceiling, rather than quietly capping it', async () => {
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/search?q=anjali&limit=500',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('rejects an unknown query parameter', async () => {
    // `.strict()`, like every other contract: a client sending `types=` is
    // asking for something that does not exist and should be told so
    // (CLAUDE.md §5.6).
    const response = await request(harness, {
      method: 'GET',
      url: '/api/v1/search?q=anjali&types=contact',
      token: admin.token,
    });
    expect(response.status).toBe(422);
  });

  it('finds nothing for a word nobody holds', async () => {
    expect(await search('zzzqqqxxx')).toEqual([]);
  });

  it('forgets a record once it is deleted and the index catches up', async () => {
    const doomed = await harness.fixtures.createContact(tenantId, {
      ownerId: admin.userId,
      firstName: 'Ephemeral',
      lastName: 'Record',
    });
    await harness.indexForSearch(tenantId);
    expect(ids(await search('Ephemeral'))).toContain(doomed);

    const contact = await request(harness, {
      method: 'GET',
      url: `/api/v1/contacts/${doomed}`,
      token: admin.token,
    });
    const version = (contact.body['data'] as { version: number }).version;
    const deleted = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/contacts/${doomed}?version=${String(version)}`,
      token: admin.token,
    });
    expect(deleted.status).toBe(204);

    // Before the index is rebuilt it still holds the row; the live re-resolve
    // is what keeps it out of the answer (ADR-0028 §5). Afterwards the row is
    // gone too, and both paths agree.
    expect(ids(await search('Ephemeral'))).not.toContain(doomed);
    await harness.indexForSearch(tenantId);
    expect(ids(await search('Ephemeral'))).not.toContain(doomed);
  });
});
