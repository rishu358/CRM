import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for email sent from a record (ADR-0073):
 *
 *   (a) tenant A cannot list, read, send to, retry or configure anything of tenant B
 *   (b) a caller with `own` scope can only email, and only read the emails of, records they can see; a
 *       Read-only role has no email access at all
 *   (c) a hidden email field gives the same answer as an empty one, and the request cannot name a
 *       recipient, a sender or a status of its own
 *   (d) unauthenticated requests get 401
 */

interface Person {
  token: string;
  userId: string;
}
interface Email {
  id: string;
  status: string;
  toAddress: string | null;
}

let harness: ApiHarness;
let superuser: pg.Pool;

let tenantA: string;
let adminA: Person;
let repA: Person;
let repA2: Person;
let managerA: Person;
let readOnlyA: Person;
let hiddenFieldA: Person;
let contactOfRep: string;
let contactOfRep2: string;
let dealOfRep2: string;
let leadOfRep2: string;

let tenantB: string;
let adminB: Person;
let contactB: string;
let emailB: string;

const messageCount = async (tenantId: string): Promise<number> =>
  (
    await superuser.query<{ n: number }>(
      `select count(*)::int as n from email_messages where tenant_id = $1`,
      [tenantId],
    )
  ).rows[0]!.n;

const send = (token: string, body: Record<string, unknown>) =>
  request(harness, { method: 'POST', url: '/api/v1/emails', token, body });
const forContact = (recordId: string) => ({
  objectType: 'contact',
  recordId,
  subject: 'Hello',
  body: 'Hi there',
});
const list = (token: string, objectType: string, recordId: string) =>
  request(harness, {
    method: 'GET',
    url: `/api/v1/emails?objectType=${objectType}&recordId=${recordId}`,
    token,
  });
const get = (token: string, id: string) =>
  request(harness, { method: 'GET', url: `/api/v1/emails/${id}`, token });

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, { EMAIL_OUTREACH_FROM: 'mail@send.example' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  const make = async (tenantId: string, roleId: string) => {
    const user = await harness.fixtures.createUser(tenantId, roleId);
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  adminA = await make(tenantA, rolesA.get('Admin')!);
  repA = await make(tenantA, rolesA.get('Sales Rep')!);
  repA2 = await make(tenantA, rolesA.get('Sales Rep')!);
  managerA = await make(tenantA, rolesA.get('Manager')!);
  readOnlyA = await make(tenantA, rolesA.get('Read-only')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);

  // A rep whose role may not read the contact email field.
  const hiddenRole = await harness.fixtures.createRole(tenantA, 'No contact email');
  for (const action of ['read', 'create'] as const) {
    await harness.fixtures.grant(tenantA, hiddenRole, 'contact', action, 'all');
    await harness.fixtures.grant(tenantA, hiddenRole, 'email_message', action, 'all');
  }
  await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'contact', 'email', 'hidden');
  hiddenFieldA = await make(tenantA, hiddenRole);

  // The manager shares a team with the first rep, and not with the second.
  await harness.fixtures.createTeam(tenantA, 'Pune', [managerA.userId, repA.userId]);

  contactOfRep = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    lastName: 'Mine',
    email: 'mine@customer.example',
  });
  contactOfRep2 = await harness.fixtures.createContact(tenantA, {
    ownerId: repA2.userId,
    lastName: 'Theirs',
    email: 'theirs@customer.example',
  });
  leadOfRep2 = await harness.fixtures.createLead(tenantA, {
    ownerId: repA2.userId,
    lastName: 'Theirs',
    email: 'theirlead@customer.example',
  });
  const pipeline = (await harness.fixtures.pipelinesFor(tenantA))[0]!;
  dealOfRep2 = await harness.fixtures.createDeal(tenantA, {
    ownerId: repA2.userId,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0]!.id,
    name: 'Their deal',
    primaryContactId: contactOfRep2,
  });
  contactB = await harness.fixtures.createContact(tenantB, {
    ownerId: adminB.userId,
    lastName: 'Rival',
    email: 'rival@customer.example',
  });
  emailB = dataOf<Email>(await send(adminB.token, forContact(contactB))).id;
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

// Several people send within seconds of each other here; the ten-a-minute limit has its own test.
afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes'
     where tenant_id = any($1::uuid[])`,
    [[tenantA, tenantB]],
  );
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects every email route with no credentials, or a made-up token', async () => {
    const id = crypto.randomUUID();
    const routes = [
      { method: 'GET', url: `/api/v1/emails?objectType=contact&recordId=${id}` },
      { method: 'GET', url: `/api/v1/emails/context?objectType=contact&recordId=${id}` },
      { method: 'GET', url: `/api/v1/emails/${id}` },
      { method: 'POST', url: '/api/v1/emails', body: forContact(id) },
      { method: 'POST', url: `/api/v1/emails/${id}/retry` },
      { method: 'GET', url: '/api/v1/email-settings' },
      {
        method: 'PATCH',
        url: '/api/v1/email-settings',
        body: { fromName: 'x', replyTo: null, footerText: null },
      },
    ] as const;
    for (const route of routes) {
      expect((await request(harness, route)).status, route.url).toBe(401);
      expect(
        (await request(harness, { ...route, token: 'not-a-real-session-token-but-long-enough' }))
          .status,
        route.url,
      ).toBe(401);
    }
  });
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('answers 404 to sending to, listing and reading another workspace’s record or email', async () => {
    const before = await messageCount(tenantB);
    expect((await send(adminA.token, forContact(contactB))).status).toBe(404);
    expect((await list(adminA.token, 'contact', contactB)).status).toBe(404);
    expect((await get(adminA.token, emailB)).status).toBe(404);
    expect(
      (
        await request(harness, {
          method: 'POST',
          url: `/api/v1/emails/${emailB}/retry`,
          token: adminA.token,
        })
      ).status,
    ).toBe(404);
    expect(await messageCount(tenantB)).toBe(before);

    // The same answer as for an id that never existed, so ids cannot be probed.
    expect((await get(adminA.token, crypto.randomUUID())).status).toBe(404);
  });

  it('never shows another workspace’s mail in a list, even for a record id that exists there', async () => {
    const mine = await list(adminA.token, 'contact', contactOfRep);
    expect(JSON.stringify(mine.body)).not.toContain('rival@customer.example');
    expect(JSON.stringify(mine.body)).not.toContain(emailB);
  });

  it('keeps each workspace’s sender settings its own', async () => {
    const saved = await request(harness, {
      method: 'PATCH',
      url: '/api/v1/email-settings',
      token: adminA.token,
      body: { fromName: 'Acme Jewellers Ltd', replyTo: 'sales@acme.example', footerText: null },
    });
    expect(saved.status).toBe(200);
    const theirs = dataOf<{ fromName: string; replyTo: string | null }>(
      await request(harness, { method: 'GET', url: '/api/v1/email-settings', token: adminB.token }),
    );
    expect(theirs.fromName).toBe('Rival Traders');
    expect(theirs.replyTo).toBeNull();
  });
});

describe('(b) a caller with own scope', () => {
  it('can email and read the emails of their own record', async () => {
    const email = dataOf<Email>(await send(repA.token, forContact(contactOfRep)));
    expect((await get(repA.token, email.id)).status).toBe(200);
    const page = (await list(repA.token, 'contact', contactOfRep)).body['data'] as Email[];
    expect(page.map((e) => e.id)).toContain(email.id);
  });

  it('cannot email a colleague’s contact, lead or deal: 404, nothing queued', async () => {
    const before = await messageCount(tenantA);
    expect((await send(repA.token, forContact(contactOfRep2))).status).toBe(404);
    expect(
      (
        await send(repA.token, {
          objectType: 'lead',
          recordId: leadOfRep2,
          subject: 'x',
          body: 'x',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send(repA.token, {
          objectType: 'deal',
          recordId: dealOfRep2,
          contactId: contactOfRep2,
          subject: 'x',
          body: 'x',
        })
      ).status,
    ).toBe(404);
    expect(await messageCount(tenantA)).toBe(before);
  });

  it('cannot read a colleague’s record’s emails, or one email by its id', async () => {
    const theirs = dataOf<Email>(await send(repA2.token, forContact(contactOfRep2)));
    expect((await list(repA.token, 'contact', contactOfRep2)).status).toBe(404);
    expect((await get(repA.token, theirs.id)).status).toBe(404);
    expect(
      (
        await request(harness, {
          method: 'POST',
          url: `/api/v1/emails/${theirs.id}/retry`,
          token: repA.token,
        })
      ).status,
    ).toBe(404);
    // …and cannot even ask what an email to them would look like.
    expect(
      (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/emails/context?objectType=contact&recordId=${contactOfRep2}`,
          token: repA.token,
        })
      ).status,
    ).toBe(404);
  });

  it('shows an email on a deal to someone who can see only the person it was written to', async () => {
    const pipeline = (await harness.fixtures.pipelinesFor(tenantA))[0]!;
    const sharedContact = await harness.fixtures.createContact(tenantA, {
      ownerId: repA.userId,
      lastName: 'Shared',
      email: 'shared@customer.example',
    });
    const dealOfAdmin = await harness.fixtures.createDeal(tenantA, {
      ownerId: adminA.userId,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0]!.id,
      name: 'Admin deal',
      primaryContactId: sharedContact,
    });
    const email = dataOf<Email>(
      await send(adminA.token, {
        objectType: 'deal',
        recordId: dealOfAdmin,
        contactId: sharedContact,
        subject: 'Order',
        body: 'Hello',
      }),
    );
    // The rep owns the contact and not the deal: the email is theirs to read through the contact only.
    expect((await get(repA.token, email.id)).status).toBe(200);
    expect((await list(repA.token, 'contact', sharedContact)).status).toBe(200);
    expect((await list(repA.token, 'deal', dealOfAdmin)).status).toBe(404);
  });

  it('lets a manager (team scope) email and read a teammate’s record, and not another team’s', async () => {
    expect((await send(managerA.token, forContact(contactOfRep))).status).toBe(202);
    expect((await list(managerA.token, 'contact', contactOfRep)).status).toBe(200);
    expect((await send(managerA.token, forContact(contactOfRep2))).status).toBe(404);
    expect((await list(managerA.token, 'contact', contactOfRep2)).status).toBe(404);
  });

  it('gives a Read-only role no email access, even to records they can read', async () => {
    expect((await send(readOnlyA.token, forContact(contactOfRep))).status).toBe(403);
    expect((await list(readOnlyA.token, 'contact', contactOfRep)).status).toBe(403);
    const email = dataOf<Email>(await send(repA.token, forContact(contactOfRep)));
    expect((await get(readOnlyA.token, email.id)).status).toBe(403);
    expect(
      (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/emails/context?objectType=contact&recordId=${contactOfRep}`,
          token: readOnlyA.token,
        })
      ).status,
    ).toBe(403);
  });

  it('keeps the sender settings to whoever manages company settings', async () => {
    for (const person of [repA, readOnlyA, managerA]) {
      expect(
        (
          await request(harness, {
            method: 'GET',
            url: '/api/v1/email-settings',
            token: person.token,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(harness, {
            method: 'PATCH',
            url: '/api/v1/email-settings',
            token: person.token,
            body: { fromName: 'Hijack', replyTo: null, footerText: null },
          })
        ).status,
      ).toBe(403);
    }
  });
});

describe('(c) hidden fields and what the client may not say', () => {
  it('treats a hidden email field exactly as an empty one', async () => {
    const hidden = await send(hiddenFieldA.token, forContact(contactOfRep));
    const empty = await send(adminA.token, {
      ...forContact(
        await harness.fixtures.createContact(tenantA, {
          ownerId: adminA.userId,
          lastName: 'Empty',
        }),
      ),
    });
    expect(hidden.status).toBe(422);
    expect(empty.status).toBe(422);
    expect(hidden.body['error']).toMatchObject({ code: 'NO_EMAIL_ADDRESS' });
    expect((hidden.body['error'] as { message: string }).message).toBe(
      (empty.body['error'] as { message: string }).message,
    );

    const context = dataOf<{ to: string | null }>(
      await request(harness, {
        method: 'GET',
        url: `/api/v1/emails/context?objectType=contact&recordId=${contactOfRep}`,
        token: hiddenFieldA.token,
      }),
    );
    expect(context.to).toBeNull();
  });

  it('rejects a request that names its own recipient, sender, status or link', async () => {
    for (const extra of [
      { to: 'someone@evil.example' },
      { from: 'ceo@bank.example' },
      { replyTo: 'x@evil.example' },
      { fromName: 'The Bank' },
      { status: 'sent' },
      { links: [{ objectType: 'contact', recordId: contactOfRep2 }] },
      { createdBy: adminA.userId },
    ]) {
      const response = await send(repA.token, { ...forContact(contactOfRep), ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
    // And a kind of record an email cannot be sent from.
    expect(
      (await send(repA.token, { ...forContact(contactOfRep), objectType: 'account' })).status,
    ).toBe(422);
  });

  it('never lets a person who cannot see a record learn its address from the error', async () => {
    const response = await send(repA.token, forContact(contactOfRep2));
    expect(JSON.stringify(response.body)).not.toContain('theirs@customer.example');
    expect(response.body['error']).toMatchObject({ code: 'NOT_FOUND' });
  });
});
