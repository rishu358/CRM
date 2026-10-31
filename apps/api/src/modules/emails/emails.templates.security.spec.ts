import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for email templates, merge fields and
 * signatures (ADR-0074):
 *
 *   (a) tenant A cannot list, change, remove or send from tenant B's templates, or see its signatures
 *   (b) a caller with `own` scope can use templates but not manage them; a Read-only role has no
 *       email access; one person's signature is never another's
 *   (c) a hidden field fills as an empty one, and a request cannot name its own owner, id or author
 *   (d) unauthenticated requests get 401
 */

interface Person {
  token: string;
  userId: string;
}
interface Template {
  id: string;
  name: string;
  version: number;
}
interface Email {
  id: string;
  subject: string;
  body: string;
}

let harness: ApiHarness;
let superuser: pg.Pool;

let tenantA: string;
let adminA: Person;
let repA: Person;
let repA2: Person;
let readOnlyA: Person;
let hiddenNameA: Person;
let contactOfRep: string;
let templateA: Template;

let tenantB: string;
let adminB: Person;
let repB: Person;
let templateB: Template;

const call = (
  token: string | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
) => request(harness, { method, url: `/api/v1${url}`, token, body });

const create = (token: string, name: string) =>
  call(token, 'POST', '/email-templates', {
    name,
    subject: 'Hi {{contact.first_name}}',
    body: 'Hello',
  });

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
  readOnlyA = await make(tenantA, rolesA.get('Read-only')!);
  adminB = await make(tenantB, rolesB.get('Admin')!);
  repB = await make(tenantB, rolesB.get('Sales Rep')!);

  // A rep whose role may not read the contact's first name.
  const hiddenRole = await harness.fixtures.createRole(tenantA, 'No first names');
  for (const action of ['read', 'create'] as const) {
    await harness.fixtures.grant(tenantA, hiddenRole, 'contact', action, 'all');
    await harness.fixtures.grant(tenantA, hiddenRole, 'email_message', action, 'all');
  }
  await harness.fixtures.setFieldPermission(tenantA, hiddenRole, 'contact', 'first_name', 'hidden');
  hiddenNameA = await make(tenantA, hiddenRole);

  contactOfRep = await harness.fixtures.createContact(tenantA, {
    ownerId: repA.userId,
    firstName: 'Anil',
    lastName: 'Sharma',
    email: 'anil@customer.example',
  });
  templateA = dataOf<Template>(await create(adminA.token, 'A welcome'));
  templateB = dataOf<Template>(await create(adminB.token, 'B welcome'));
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes'
     where tenant_id = any($1::uuid[])`,
    [[tenantA, tenantB]],
  );
});

describe('(d) unauthenticated requests get 401', () => {
  it('rejects every template and signature route with no credentials, or a made-up token', async () => {
    const id = crypto.randomUUID();
    const routes = [
      { method: 'GET', url: '/email-templates' },
      { method: 'POST', url: '/email-templates', body: { name: 'x', subject: 'x', body: 'x' } },
      { method: 'PATCH', url: `/email-templates/${id}`, body: { name: 'x', version: 1 } },
      { method: 'DELETE', url: `/email-templates/${id}?version=1` },
      { method: 'GET', url: '/email-signature' },
      { method: 'PATCH', url: '/email-signature', body: { text: 'x' } },
    ] as const;
    for (const route of routes) {
      const body = 'body' in route ? route.body : undefined;
      expect((await call(undefined, route.method, route.url, body)).status, route.url).toBe(401);
      expect(
        (await call('not-a-real-session-token-but-long-enough', route.method, route.url, body))
          .status,
        route.url,
      ).toBe(401);
    }
  });
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('never lists another workspace’s templates', async () => {
    const mine = dataOf<Template[]>(await call(adminA.token, 'GET', '/email-templates'));
    expect(mine.map((t) => t.id)).toContain(templateA.id);
    expect(mine.map((t) => t.id)).not.toContain(templateB.id);
    const theirs = dataOf<Template[]>(await call(adminB.token, 'GET', '/email-templates'));
    expect(theirs.map((t) => t.name)).toEqual(['B welcome']);
  });

  it('answers 404 to changing or removing another workspace’s template, as for one that never existed', async () => {
    const patch = await call(adminA.token, 'PATCH', `/email-templates/${templateB.id}`, {
      name: 'Hijacked',
      version: templateB.version,
    });
    expect(patch.status).toBe(404);
    const del = await call(
      adminA.token,
      'DELETE',
      `/email-templates/${templateB.id}?version=${templateB.version}`,
    );
    expect(del.status).toBe(404);
    const never = await call(
      adminA.token,
      'DELETE',
      `/email-templates/${crypto.randomUUID()}?version=1`,
    );
    expect(never.status).toBe(404);
    const stillThere = dataOf<Template[]>(await call(adminB.token, 'GET', '/email-templates'));
    expect(stillThere).toEqual([expect.objectContaining({ name: 'B welcome', version: 1 })]);
  });

  it('keeps a name free in each workspace: the same name in another one is not a clash', async () => {
    expect((await create(adminB.token, 'A welcome')).status).toBe(201);
  });

  it('keeps signatures to their own workspace and person', async () => {
    await call(repA.token, 'PATCH', '/email-signature', { text: 'Rep A, Acme' });
    await call(repB.token, 'PATCH', '/email-signature', { text: 'Rep B, Rival' });
    expect(dataOf<{ text: string }>(await call(repA.token, 'GET', '/email-signature')).text).toBe(
      'Rep A, Acme',
    );
    expect(dataOf<{ text: string }>(await call(repB.token, 'GET', '/email-signature')).text).toBe(
      'Rep B, Rival',
    );
  });
});

describe('(b) what a role may do', () => {
  it('lets a person with own scope read the templates and use them, and not change them', async () => {
    const listed = dataOf<Template[]>(await call(repA.token, 'GET', '/email-templates'));
    expect(listed.map((t) => t.id)).toContain(templateA.id);
    expect((await create(repA.token, 'Rep made')).status).toBe(403);
    expect(
      (
        await call(repA.token, 'PATCH', `/email-templates/${templateA.id}`, {
          name: 'Renamed by a rep',
          version: templateA.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          repA.token,
          'DELETE',
          `/email-templates/${templateA.id}?version=${templateA.version}`,
        )
      ).status,
    ).toBe(403);
    const unchanged = dataOf<Template[]>(await call(adminA.token, 'GET', '/email-templates'));
    expect(unchanged.find((t) => t.id === templateA.id)?.name).toBe('A welcome');
  });

  it('gives a Read-only role no access to templates or a signature', async () => {
    expect((await call(readOnlyA.token, 'GET', '/email-templates')).status).toBe(403);
    expect((await create(readOnlyA.token, 'Nope')).status).toBe(403);
    expect((await call(readOnlyA.token, 'GET', '/email-signature')).status).toBe(403);
    expect((await call(readOnlyA.token, 'PATCH', '/email-signature', { text: 'x' })).status).toBe(
      403,
    );
  });

  it('never shows or lets one person change another’s signature', async () => {
    await call(repA.token, 'PATCH', '/email-signature', { text: 'Rep A, Acme', version: 1 });
    expect(dataOf<{ text: string }>(await call(repA2.token, 'GET', '/email-signature')).text).toBe(
      '',
    );
    // Nothing in the request names a person, so there is nothing to forge; an attempt is refused.
    const forged = await call(repA2.token, 'PATCH', '/email-signature', {
      text: 'Mine now',
      userId: repA.userId,
    });
    expect(forged.status).toBe(422);
    expect(dataOf<{ text: string }>(await call(repA.token, 'GET', '/email-signature')).text).toBe(
      'Rep A, Acme',
    );
  });

  it('puts the sender’s own signature on their emails, never somebody else’s', async () => {
    await call(repA.token, 'PATCH', '/email-signature', { text: 'Rep A, Acme', version: 2 });
    const mail = dataOf<Email>(
      await call(adminA.token, 'POST', '/emails', {
        objectType: 'contact',
        recordId: contactOfRep,
        subject: 'Hi',
        body: 'Hello',
      }),
    );
    expect(mail.body).toBe('Hello');
    expect(mail.body).not.toContain('Rep A');
  });
});

describe('(c) hidden fields and what the client may not say', () => {
  it('fills a hidden field exactly as an empty one, with nothing to tell them apart', async () => {
    const response = await call(hiddenNameA.token, 'POST', '/emails', {
      objectType: 'contact',
      recordId: contactOfRep,
      subject: 'Dear {{contact.first_name}}',
      body: 'Hello {{contact.first_name}} {{contact.last_name}}',
    });
    expect(response.status).toBe(202);
    const mail = dataOf<Email>(response);
    expect(mail.subject).toBe('Dear');
    expect(mail.body).toBe('Hello  Sharma');
    expect(JSON.stringify(mail)).not.toContain('Anil');

    const context = dataOf<{ mergeValues: Record<string, string> }>(
      await call(
        hiddenNameA.token,
        'GET',
        `/emails/context?objectType=contact&recordId=${contactOfRep}`,
      ),
    );
    expect(context.mergeValues['contact.first_name']).toBe('');
    expect(JSON.stringify(context)).not.toContain('Anil');
  });

  it('rejects a template or signature request that names its own owner, id, author or version bump', async () => {
    for (const extra of [
      { id: crypto.randomUUID() },
      { createdBy: adminA.userId },
      { tenantId: tenantB },
      { deletedAt: '2026-01-01T00:00:00Z' },
    ]) {
      const response = await call(adminA.token, 'POST', '/email-templates', {
        name: `Strict ${Math.random()}`,
        subject: 'Hi',
        body: 'Hello',
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
    const noop = await call(adminA.token, 'PATCH', `/email-templates/${templateA.id}`, {
      version: templateA.version,
    });
    expect(noop.status).toBe(422);
  });

  it('refuses a template whose words use a field the sender cannot be given', async () => {
    const response = await call(adminA.token, 'POST', '/email-templates', {
      name: 'Phone template',
      subject: 'Hi',
      body: 'Call {{contact.phone}}',
    });
    expect(response.status).toBe(422);
  });
});
