import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Email templates, merge fields and signatures through the real HTTP stack (ADR-0074): what an
 * administrator can keep, what a person can start from, what is filled in and from where, and what a
 * signature does. The security suites for the same routes are in `emails.templates.security.spec.ts`.
 */

interface Person {
  token: string;
  userId: string;
}
interface Template {
  id: string;
  name: string;
  subject: string;
  body: string;
  version: number;
}
interface Email {
  id: string;
  status: string;
  subject: string;
  body: string;
  failureCode: string | null;
}
interface Signature {
  text: string;
  version: number | null;
}

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantId: string;
let admin: Person;
let rep: Person;
let rep2: Person;
let contactId: string;
let leadId: string;
let dealId: string;

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: Record<string, unknown>,
) => request(harness, { method, url: `/api/v1${url}`, token, body });

const send = (token: string, body: Record<string, unknown>) => call(token, 'POST', '/emails', body);

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, { EMAIL_OUTREACH_FROM: 'mail@send.example' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });

  tenantId = (await harness.fixtures.createTenant({ name: 'Template Traders' })).tenantId;
  const roles = await harness.provision(tenantId);
  const make = async (roleName: string, name: string) => {
    const user = await harness.fixtures.createUser(tenantId, roles.get(roleName)!, { name });
    return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
  };
  admin = await make('Admin', 'Asha Admin');
  rep = await make('Sales Rep', 'Priya Rep');
  rep2 = await make('Sales Rep', 'Ravi Rep');

  const account = await harness.fixtures.createAccount(tenantId, {
    ownerId: rep.userId,
    name: 'Sharma Steel Ltd',
  });
  contactId = await harness.fixtures.createContact(tenantId, {
    ownerId: rep.userId,
    firstName: 'Anil',
    lastName: 'Sharma',
    email: 'anil@customer.example',
    accountId: account,
  });
  leadId = await harness.fixtures.createLead(tenantId, {
    ownerId: rep.userId,
    firstName: 'Meera',
    lastName: 'Verma',
    company: 'Verma Textiles',
    email: 'meera@prospect.example',
  });
  const pipeline = (await harness.fixtures.pipelinesFor(tenantId))[0]!;
  dealId = await harness.fixtures.createDeal(tenantId, {
    ownerId: rep.userId,
    pipelineId: pipeline.id,
    stageId: pipeline.stages[0]!.id,
    name: 'Steel order 2026',
    primaryContactId: contactId,
  });
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

// The ten-a-minute limit has its own test in emails.spec.ts; here several emails go out within seconds.
afterEach(async () => {
  await superuser.query(
    `update email_messages set created_at = created_at - interval '10 minutes' where tenant_id = $1`,
    [tenantId],
  );
});

const toContact = (subject: string, body: string) => ({
  objectType: 'contact',
  recordId: contactId,
  subject,
  body,
});

describe('templates', () => {
  it('lets an administrator keep templates and anyone who may send read them', async () => {
    const created = await call(admin.token, 'POST', '/email-templates', {
      name: 'Follow-up after demo',
      subject: 'Thanks, {{contact.first_name}}',
      body: 'Hello {{contact.first_name}},\n\nThank you for your time.\n\n{{sender.name}}',
    });
    expect(created.status).toBe(201);
    const template = dataOf<Template>(created);
    expect(template).toMatchObject({ name: 'Follow-up after demo', version: 1 });

    const listed = dataOf<Template[]>(await call(rep.token, 'GET', '/email-templates'));
    expect(listed.map((t) => t.id)).toContain(template.id);

    const updated = dataOf<Template>(
      await call(admin.token, 'PATCH', `/email-templates/${template.id}`, {
        name: 'Follow-up after the demo',
        version: template.version,
      }),
    );
    expect(updated).toMatchObject({ name: 'Follow-up after the demo', version: 2 });

    const stale = await call(admin.token, 'PATCH', `/email-templates/${template.id}`, {
      subject: 'Late edit',
      version: template.version,
    });
    expect(stale.status).toBe(409);

    const removed = await call(
      admin.token,
      'DELETE',
      `/email-templates/${template.id}?version=${updated.version}`,
    );
    expect(removed.status).toBe(204);
    const after = dataOf<Template[]>(await call(rep.token, 'GET', '/email-templates'));
    expect(after.map((t) => t.id)).not.toContain(template.id);
  });

  it('keeps a name unique among the templates in use, ignoring case', async () => {
    const body = { subject: 'Hi', body: 'Hello' };
    const first = await call(admin.token, 'POST', '/email-templates', { name: 'Welcome', ...body });
    expect(first.status).toBe(201);
    const same = await call(admin.token, 'POST', '/email-templates', { name: 'WELCOME', ...body });
    expect(same.status).toBe(409);

    // A removed template gives its name back.
    const made = dataOf<Template>(first);
    await call(admin.token, 'DELETE', `/email-templates/${made.id}?version=${made.version}`);
    expect(
      (await call(admin.token, 'POST', '/email-templates', { name: 'welcome', ...body })).status,
    ).toBe(201);
  });

  it('refuses a field that is not on the list, in the subject or the message', async () => {
    const attempt = (subject: string, body: string) =>
      call(admin.token, 'POST', '/email-templates', {
        name: `Bad ${Math.random()}`,
        subject,
        body,
      });
    expect((await attempt('Hi {{contact.email}}', 'Hello')).status).toBe(422);
    expect((await attempt('Hi', 'Hello {{ Contact Name }}')).status).toBe(422);
    expect((await attempt('Hi {{contact.first_name}}', 'Hello {{contact.last_name}}')).status).toBe(
      201,
    );
  });

  it('stops at one hundred templates', async () => {
    const tenant = (await harness.fixtures.createTenant({ name: 'Template Cap Traders' })).tenantId;
    const roles = await harness.provision(tenant);
    const user = await harness.fixtures.createUser(tenant, roles.get('Admin')!);
    const token = await harness.signIn(user.userId, tenant);
    await superuser.query(
      `insert into email_templates (id, tenant_id, name, subject, body_text)
       select gen_random_uuid(), $1, 'T' || n, 's', 'b' from generate_series(1, 100) n`,
      [tenant],
    );
    const response = await call(token, 'POST', '/email-templates', {
      name: 'One too many',
      subject: 's',
      body: 'b',
    });
    expect(response.status).toBe(409);
  });

  it('writes an audit entry for each change, naming the template and never its words', async () => {
    const made = dataOf<Template>(
      await call(admin.token, 'POST', '/email-templates', {
        name: 'Audited template',
        subject: 'Secret subject words',
        body: 'Secret body words',
      }),
    );
    await call(admin.token, 'PATCH', `/email-templates/${made.id}`, {
      body: 'More secret body words',
      version: made.version,
    });
    const entries = await harness.fixtures.auditEntries(tenantId, 'email_template');
    const mine = entries.filter((entry) => entry.recordId === made.id);
    expect(mine.map((entry) => entry.action).sort()).toEqual(['create', 'update']);
    expect(JSON.stringify(mine)).not.toContain('secret');
    expect(JSON.stringify(mine)).not.toContain('Secret');
  });
});

describe('merge fields', () => {
  it('fills the fields from the records and from who is sending, once, as text', async () => {
    const email = dataOf<Email>(
      await send(
        rep.token,
        toContact(
          'For {{contact.first_name}} at {{account.name}}',
          'Dear {{contact.first_name}} {{contact.last_name}},\n\nFrom {{sender.name}}, {{company.name}}.',
        ),
      ),
    );
    expect(email.subject).toBe('For Anil at Sharma Steel Ltd');
    expect(email.body).toBe('Dear Anil Sharma,\n\nFrom Priya Rep, Template Traders.');
    const stored = (
      await superuser.query<{ subject: string; body_text: string }>(
        `select subject, body_text from email_messages where id = $1`,
        [email.id],
      )
    ).rows[0]!;
    expect(stored.subject).toBe('For Anil at Sharma Steel Ltd');
    expect(stored.body_text).not.toContain('{{');
  });

  it('uses a lead’s company, and a deal’s name when writing from a deal', async () => {
    const lead = dataOf<Email>(
      await send(rep.token, {
        objectType: 'lead',
        recordId: leadId,
        subject: 'Hello {{contact.first_name}}',
        body: 'About {{account.name}}',
      }),
    );
    expect(lead).toMatchObject({ subject: 'Hello Meera', body: 'About Verma Textiles' });

    const deal = dataOf<Email>(
      await send(rep.token, {
        objectType: 'deal',
        recordId: dealId,
        contactId,
        subject: 'Re: {{deal.name}}',
        body: 'Hello {{contact.first_name}}',
      }),
    );
    expect(deal).toMatchObject({ subject: 'Re: Steel order 2026', body: 'Hello Anil' });
  });

  it('leaves a field blank when the record has nothing, and says so beforehand', async () => {
    const bare = await harness.fixtures.createContact(tenantId, {
      ownerId: rep.userId,
      lastName: 'Bare',
      email: 'bare@customer.example',
    });
    const context = dataOf<{ mergeValues: Record<string, string> }>(
      await call(rep.token, 'GET', `/emails/context?objectType=contact&recordId=${bare}`),
    );
    expect(context.mergeValues).toMatchObject({
      'contact.first_name': '',
      'contact.last_name': 'Bare',
      'account.name': '',
      'sender.name': 'Priya Rep',
      'company.name': 'Template Traders',
    });
    const email = dataOf<Email>(
      await send(rep.token, {
        objectType: 'contact',
        recordId: bare,
        subject: 'Hello{{contact.first_name}}',
        body: 'Of {{account.name}}.',
      }),
    );
    expect(email).toMatchObject({ subject: 'Hello', body: 'Of .' });
  });

  it('does not look inside a value: braces in a name are sent as they are', async () => {
    const tricky = await harness.fixtures.createContact(tenantId, {
      ownerId: rep.userId,
      lastName: '{{sender.name}}',
      email: 'tricky@customer.example',
    });
    const email = dataOf<Email>(
      await send(rep.token, {
        objectType: 'contact',
        recordId: tricky,
        subject: 'Hi',
        body: 'Dear {{contact.last_name}}',
      }),
    );
    expect(email.body).toBe('Dear {{sender.name}}');
  });

  it('refuses an email that uses a field that is not on the list', async () => {
    for (const [subject, body] of [
      ['Hi {{contact.email}}', 'Hello'],
      ['Hi', 'Hello {{contact.phone}}'],
      ['Hi', 'Hello {{ Contact Name }}'],
    ] as const) {
      expect((await send(rep.token, toContact(subject, body))).status).toBe(422);
    }
  });

  it('refuses a subject that is empty once its fields are filled in', async () => {
    const bare = await harness.fixtures.createContact(tenantId, {
      ownerId: rep.userId,
      lastName: 'Nofirst',
      email: 'nofirst@customer.example',
    });
    const response = await send(rep.token, {
      objectType: 'contact',
      recordId: bare,
      subject: '{{contact.first_name}}',
      body: 'Hello',
    });
    expect(response.status).toBe(422);
  });
});

describe('signatures', () => {
  it('starts empty, is saved by its owner only, and is the owner’s alone', async () => {
    const initial = dataOf<Signature>(await call(rep.token, 'GET', '/email-signature'));
    expect(initial).toEqual({ text: '', version: null });

    const saved = await call(rep.token, 'PATCH', '/email-signature', {
      text: 'Priya Rep\nSharma Steel, Pune',
    });
    expect(saved.status).toBe(200);
    expect(dataOf<Signature>(saved)).toEqual({ text: 'Priya Rep\nSharma Steel, Pune', version: 1 });

    // Another person sees nothing of it.
    expect(dataOf<Signature>(await call(rep2.token, 'GET', '/email-signature'))).toEqual({
      text: '',
      version: null,
    });

    // A second save needs the version it read.
    expect((await call(rep.token, 'PATCH', '/email-signature', { text: 'x' })).status).toBe(409);
    const again = await call(rep.token, 'PATCH', '/email-signature', {
      text: 'Priya Rep\nSharma Steel, Pune',
      version: 1,
    });
    expect(dataOf<Signature>(again).version).toBe(2);

    const entries = await harness.fixtures.auditEntries(tenantId, 'email_signature');
    expect(JSON.stringify(entries)).not.toContain('Pune');
  });

  it('is added below the message, and not added a second time on a retry', async () => {
    const email = dataOf<Email>(await send(rep.token, toContact('With signature', 'Hello Anil')));
    expect(email.body).toBe('Hello Anil\n\nPriya Rep\nSharma Steel, Pune');

    await superuser.query(
      `update email_messages set status = 'failed', failure_code = 'timeout', failed_at = now() where id = $1`,
      [email.id],
    );
    const retried = dataOf<Email>(await call(rep.token, 'POST', `/emails/${email.id}/retry`));
    expect(retried.body).toBe(email.body);
    expect(retried.body.match(/Sharma Steel, Pune/g)).toHaveLength(1);
  });

  it('shows the signature in the dialog’s context, and an email from someone with none has none', async () => {
    const mine = dataOf<{ signature: string }>(
      await call(rep.token, 'GET', `/emails/context?objectType=contact&recordId=${contactId}`),
    );
    expect(mine.signature).toBe('Priya Rep\nSharma Steel, Pune');
    const none = dataOf<Email>(await send(admin.token, toContact('No signature', 'Hello')));
    expect(none.body).toBe('Hello');
  });

  it('refuses a signature that is too long', async () => {
    const response = await call(rep2.token, 'PATCH', '/email-signature', { text: 'x'.repeat(501) });
    expect(response.status).toBe(422);
  });
});
