import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { deriveFillTokenSecret, issueFillToken } from '@crm/core/lead-form-token';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Website lead forms, end to end through the real HTTP stack (ADR-0063): the administration, and the
 * public door a stranger uses. The security suites are in `lead-forms.security.spec.ts`; this file is
 * what the feature does when everything is as it should be, and what it does with awkward input.
 */

interface Person {
  token: string;
  userId: string;
}
interface Form {
  id: string;
  name: string;
  status: string;
  version: number;
  consentVersion: number;
  keyHint: string | null;
  previousKeyRetiresAt: string | null;
  allowedOrigins: string[];
  stats: { today: number; last7Days: number; total: number; lastSubmittedAt: string | null };
}
interface Issued {
  form: Form;
  key: string;
  link: string;
  snippet: string;
}
interface Lead {
  id: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: string;
  ownerId: string | null;
  customFields: Record<string, unknown>;
}

let harness: ApiHarness;
let superuser: pg.Pool;
let tenantA: string;
let tenantB: string;
let adminA: Person;
let adminB: Person;
let adminC: Person;
let secondAdminA: Person;
let repA: Person;
let secret: Buffer;
let addressCounter = 0;

const FIELDS = [
  { key: 'last_name', label: 'Your name', required: true },
  { key: 'email', label: 'Email', required: false },
  { key: 'phone', label: 'Phone', required: false },
  { key: 'city', label: 'City', required: false },
];

async function person(tenantId: string, roleId: string): Promise<Person> {
  const user = await harness.fixtures.createUser(tenantId, roleId);
  return { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
}

const as = (
  who: Person | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) =>
  request(harness, {
    method,
    url: `/api/v1${url}`,
    ...(who === null ? {} : { token: who.token }),
    ...(body === undefined ? {} : { body }),
  });

/** A fresh address per call, so one test's traffic never counts against another's. */
function nextAddress(): string {
  addressCounter += 1;
  return `10.20.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

async function createForm(who: Person, overrides: Record<string, unknown> = {}): Promise<Issued> {
  return dataOf<Issued>(
    await as(who, 'POST', '/lead-forms', {
      name: `Contact us ${Math.random().toString(36).slice(2, 8)}`,
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thank you, we will be in touch.',
      allowedOrigins: [],
      phoneCountryCode: '91',
      ...overrides,
    }),
    201,
  );
}

interface PublicResponse {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Send a request to the public routes exactly as a browser or a script would. */
async function publicRequest(
  method: 'GET' | 'POST',
  url: string,
  options: {
    body?: unknown;
    rawBody?: string;
    contentType?: string | null;
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
): Promise<PublicResponse> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const contentType =
    options.contentType === undefined
      ? options.body !== undefined || options.rawBody !== undefined
        ? 'application/json'
        : null
      : options.contentType;
  if (contentType !== null) headers['content-type'] = contentType;

  const response = await harness.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url: `/api/v1/public/forms${url}`,
      headers,
      remoteAddress: options.remoteAddress ?? nextAddress(),
      ...(options.rawBody !== undefined
        ? { payload: options.rawBody }
        : options.body === undefined
          ? {}
          : { payload: JSON.stringify(options.body) }),
    });

  let parsed: Record<string, unknown>;
  try {
    parsed = response.json<Record<string, unknown>>();
  } catch {
    parsed = { text: response.body };
  }
  const outgoing: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    outgoing[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return { status: response.statusCode, body: parsed, headers: outgoing };
}

/** A fill token for this form, issued some seconds ago (a real page waits for a person to type). */
function tokenFor(formId: string, ageSeconds = 10): string {
  return issueFillToken(secret, formId, new Date(Date.now() - ageSeconds * 1000));
}

let emailCounter = 0;
function uniqueEmail(): string {
  emailCounter += 1;
  return `visitor${emailCounter}.${Math.random().toString(36).slice(2, 8)}@example.com`;
}

function submission(formId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    last_name: 'Rao',
    email: uniqueEmail(),
    consent: true,
    fillToken: tokenFor(formId),
    ...extra,
  };
}

async function leadsOf(who: Person): Promise<Lead[]> {
  return dataOf<Lead[]>(await as(who, 'GET', '/leads?limit=100'), 200);
}

async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T> {
  const result = await superuser.query(text, params);
  return result.rows[0] as T;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  // A generous form limit: this file makes many forms in one workspace, and the limit itself is tested
  // on a workspace of its own below.
  harness = await startApiHarness(urls, { LEAD_FORMS_MAX_PER_TENANT: '80' });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  secret = deriveFillTokenSecret(harness.env.AUTH_SECRET);

  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Forms' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Forms' })).tenantId;
  const rolesB = await harness.provision(tenantB);
  adminA = await person(tenantA, rolesA.get('Admin')!);
  repA = await person(tenantA, rolesA.get('Sales Rep')!);
  adminB = await person(tenantB, rolesB.get('Admin')!);
  secondAdminA = await person(tenantA, rolesA.get('Admin')!);
  const tenantC = (await harness.fixtures.createTenant({ name: 'Cap Forms' })).tenantId;
  const rolesC = await harness.provision(tenantC);
  adminC = await person(tenantC, rolesC.get('Admin')!);

  // A custom field a company added, which the form can ask for.
  for (const tenantId of [tenantA, tenantB, tenantC]) {
    await superuser.query(
      `insert into field_definitions (id, tenant_id, object_type, key, label, type, required, is_system, is_active, position)
       values (gen_random_uuid(), $1, 'lead', 'city', 'City', 'text', false, false, true, 100)`,
      [tenantId],
    );
  }
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

describe('building a form', () => {
  it('makes a form and shows its key, link and snippet exactly once', async () => {
    const issued = await createForm(adminA, { name: 'Homepage enquiry' });

    expect(issued.key).toMatch(/^lfk_[A-Za-z0-9_-]{43}$/);
    expect(issued.link).toBe(`${harness.env.WEB_URL.replace(/\/+$/, '')}/f/${issued.key}`);
    expect(issued.snippet).toContain('<iframe');
    expect(issued.snippet).toContain(issued.link);
    expect(issued.form.keyHint).toBe(issued.key.slice(-4));
    expect(issued.form.consentVersion).toBe(1);
    expect(issued.form.status).toBe('enabled');
    expect(issued.form.stats.total).toBe(0);

    // Every later read has the hint and never the key.
    const listed = await as(adminA, 'GET', '/lead-forms');
    expect(JSON.stringify(listed.body)).not.toContain(issued.key);
    const read = await as(adminA, 'GET', `/lead-forms/${issued.form.id}`);
    expect(JSON.stringify(read.body)).not.toContain(issued.key);
    expect(dataOf<Form>(read, 200).keyHint).toBe(issued.key.slice(-4));

    // The database holds a 32-byte digest and not the key.
    const stored = await one<{ key_hash: Buffer; hint: string }>(
      `select key_hash, hint from lead_form_keys where form_id = $1`,
      [issued.form.id],
    );
    expect(stored.key_hash).toHaveLength(32);
    expect(stored.key_hash.toString('utf8')).not.toContain(issued.key);
    expect(stored.hint).toBe(issued.key.slice(-4));
  });

  it('keeps the first wording of the consent, and every later one, by version', async () => {
    const issued = await createForm(adminA);
    const updated = dataOf<Form>(
      await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
        consentText: 'A newer wording: you agree we may reply to your enquiry by phone or email.',
        version: issued.form.version,
      }),
      200,
    );
    expect(updated.consentVersion).toBe(2);

    const texts = await superuser.query(
      `select version, text from lead_form_consent_texts where form_id = $1 order by version`,
      [issued.form.id],
    );
    expect(texts.rows.map((row: { version: number }) => row.version)).toEqual([1, 2]);
    expect((texts.rows[0] as { text: string }).text).toBe(
      'I agree that this company may contact me about my enquiry.',
    );

    // The same wording again is not a new version.
    const same = dataOf<Form>(
      await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
        consentText: 'A newer wording: you agree we may reply to your enquiry by phone or email.',
        version: updated.version,
      }),
      200,
    );
    expect(same.consentVersion).toBe(2);
  });

  it.each([
    ['no surname', { fields: [{ key: 'email', label: 'Email', required: true }] }],
    [
      'no way to reach the person',
      { fields: [{ key: 'last_name', label: 'Name', required: true }] },
    ],
    [
      'a field a form may not offer',
      { fields: [...FIELDS, { key: 'status', label: 'Status', required: false }] },
    ],
    [
      'an owner field',
      { fields: [...FIELDS, { key: 'owner_id', label: 'Owner', required: false }] },
    ],
    ['an unknown field', { fields: [...FIELDS, { key: 'nope', label: 'x', required: false }] }],
    [
      'the same field twice',
      { fields: [...FIELDS, { key: 'email', label: 'Again', required: false }] },
    ],
    ['an origin with a path', { allowedOrigins: ['https://example.com/contact'] }],
    ['an http origin', { allowedOrigins: ['http://example.com'] }],
    ['a wildcard origin', { allowedOrigins: ['https://*.example.com'] }],
    ['a redirect off the allowed origins', { successRedirectUrl: 'https://other.example/thanks' }],
    [
      'a redirect that is not https',
      { allowedOrigins: ['https://shop.example'], successRedirectUrl: 'http://shop.example/t' },
    ],
    ['a privacy link that is not https', { privacyUrl: 'http://example.com/privacy' }],
    ['a consent text that is too short', { consentText: 'Yes.' }],
  ])('refuses a form with %s', async (_label, overrides) => {
    const response = await as(adminA, 'POST', '/lead-forms', {
      name: `Bad ${Math.random().toString(36).slice(2, 8)}`,
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
      ...overrides,
    });
    expect(response.status).toBe(422);
  });

  it('refuses unknown properties', async () => {
    const response = await as(adminA, 'POST', '/lead-forms', {
      name: 'Extra',
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
      tenantId: tenantB,
      keyHash: 'x',
    });
    expect(response.status).toBe(422);
  });

  it('accepts a redirect to a page on an allowed origin and normalises the origins', async () => {
    const issued = await createForm(adminA, {
      allowedOrigins: ['https://Shop.Example.com/', 'https://shop.example.com'],
      successRedirectUrl: 'https://shop.example.com/thank-you',
    });
    expect(issued.form.allowedOrigins).toEqual(['https://shop.example.com']);
  });

  it('refuses a second form with the same name, ignoring case', async () => {
    const first = await createForm(adminA, { name: 'Unique Name Form' });
    expect(first.form.name).toBe('Unique Name Form');
    const again = await as(adminA, 'POST', '/lead-forms', {
      name: 'unique name form',
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
    });
    expect(again.status).toBe(409);
  });

  it('answers a stale edit with 409 and an edit of a missing form with 404', async () => {
    const issued = await createForm(adminA);
    dataOf(
      await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
        name: 'Renamed form one',
        version: issued.form.version,
      }),
      200,
    );
    const stale = await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
      name: 'Renamed again',
      version: issued.form.version,
    });
    expect(stale.status).toBe(409);
    const missing = await as(adminA, 'PATCH', '/lead-forms/0198f0f0-0000-7000-8000-000000000000', {
      name: 'x',
      version: 1,
    });
    expect(missing.status).toBe(404);
  });

  it('writes an audit entry and an event for every change, and neither carries a key', async () => {
    const issued = await createForm(adminA, { name: 'Audited form' });
    const rotated = dataOf<Issued>(
      await as(adminA, 'POST', `/lead-forms/${issued.form.id}/key/rotate`, {
        graceHours: 24,
        version: issued.form.version,
      }),
      200,
    );
    dataOf(
      await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
        status: 'disabled',
        version: rotated.form.version,
      }),
      200,
    );

    const audit = await superuser.query(
      `select action, changes from audit_logs where tenant_id = $1 and object_type = 'lead_form' and record_id = $2 order by occurred_at`,
      [tenantA, issued.form.id],
    );
    expect(audit.rows.map((row: { action: string }) => row.action)).toEqual([
      'create',
      'update',
      'update',
    ]);

    const events = await superuser.query(
      `select event_type, payload from outbox_events where tenant_id = $1 and record_id = $2 order by created_at`,
      [tenantA, issued.form.id],
    );
    expect(events.rows.map((row: { event_type: string }) => row.event_type)).toEqual([
      'lead_form.created.v1',
      'lead_form.key_rotated.v1',
      'lead_form.updated.v1',
      'lead_form.disabled.v1',
    ]);

    const everything = JSON.stringify([audit.rows, events.rows]);
    for (const key of [issued.key, rotated.key]) expect(everything).not.toContain(key);
    expect(everything).not.toContain('key_hash');
    expect(everything).not.toContain('keyHash');
  });

  it('refuses a form beyond the workspace limit', async () => {
    const max = harness.env.LEAD_FORMS_MAX_PER_TENANT;
    for (let i = 0; i < max; i += 1) await createForm(adminC);
    const over = await as(adminC, 'POST', '/lead-forms', {
      name: 'One too many',
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
    });
    expect(over.status).toBe(409);
  });
});

describe('the keys', () => {
  it('lets the old key work through its grace window, then not', async () => {
    const issued = await createForm(adminA);
    const rotated = dataOf<Issued>(
      await as(adminA, 'POST', `/lead-forms/${issued.form.id}/key/rotate`, {
        graceHours: 24,
        version: issued.form.version,
      }),
      200,
    );
    expect(rotated.key).not.toBe(issued.key);
    expect(rotated.form.previousKeyRetiresAt).not.toBeNull();

    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(200);
    expect((await publicRequest('GET', `/${rotated.key}`)).status).toBe(200);

    await superuser.query(
      `update lead_form_keys set retires_at = now() - interval '1 second' where form_id = $1 and hint = $2`,
      [issued.form.id, issued.key.slice(-4)],
    );
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(404);
    expect((await publicRequest('GET', `/${rotated.key}`)).status).toBe(200);
  });

  it('retires the old key at once when the grace is zero', async () => {
    const issued = await createForm(adminA);
    dataOf(
      await as(adminA, 'POST', `/lead-forms/${issued.form.id}/key/rotate`, {
        graceHours: 0,
        version: issued.form.version,
      }),
      200,
    );
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(404);
  });

  it('never has more than two live keys', async () => {
    const issued = await createForm(adminA);
    let form = issued.form;
    const keys = [issued.key];
    for (let i = 0; i < 3; i += 1) {
      const next = dataOf<Issued>(
        await as(adminA, 'POST', `/lead-forms/${form.id}/key/rotate`, {
          graceHours: 24,
          version: form.version,
        }),
        200,
      );
      form = next.form;
      keys.push(next.key);
    }
    const statuses = [];
    for (const key of keys) statuses.push((await publicRequest('GET', `/${key}`)).status);
    expect(statuses).toEqual([404, 404, 200, 200]);
  });

  it('revokes every key at once, and rotating then issues a working one', async () => {
    const issued = await createForm(adminA);
    const revoked = dataOf<Form>(
      await as(adminA, 'POST', `/lead-forms/${issued.form.id}/key/revoke`, {
        version: issued.form.version,
      }),
      200,
    );
    expect(revoked.keyHint).toBeNull();
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(404);

    const fresh = dataOf<Issued>(
      await as(adminA, 'POST', `/lead-forms/${issued.form.id}/key/rotate`, {
        graceHours: 0,
        version: revoked.version,
      }),
      200,
    );
    expect((await publicRequest('GET', `/${fresh.key}`)).status).toBe(200);
  });

  it('stops a deleted form for good, and keeps the leads it made', async () => {
    const issued = await createForm(adminA);
    const sent = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id),
    });
    expect(sent.status).toBe(201);

    const current = dataOf<Form>(await as(adminA, 'GET', `/lead-forms/${issued.form.id}`), 200);
    const removed = await as(
      adminA,
      'DELETE',
      `/lead-forms/${issued.form.id}?version=${current.version}`,
    );
    expect(removed.status).toBe(204);

    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(404);
    expect((await as(adminA, 'GET', `/lead-forms/${issued.form.id}`)).status).toBe(404);
    expect((await leadsOf(adminA)).some((lead) => lead.source === 'web_form')).toBe(true);
  });
});

describe('the hosted page asks for the definition', () => {
  it('gives the fields, the wording and a fill token, and nothing else about the company', async () => {
    const issued = await createForm(adminA, { allowedOrigins: ['https://shop.example.com'] });
    const response = await publicRequest('GET', `/${issued.key}`);
    expect(response.status).toBe(200);

    const data = response.body['data'] as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'allowedOrigins',
        'consentText',
        'fields',
        'fillToken',
        'name',
        'privacyUrl',
        'successMessage',
        'successRedirectUrl',
      ].sort(),
    );
    expect((data['fields'] as { key: string }[]).map((field) => field.key)).toEqual([
      'last_name',
      'email',
      'phone',
      'city',
    ]);
    expect(data['allowedOrigins']).toEqual(['https://shop.example.com']);
    expect(String(data['fillToken'])).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    const text = JSON.stringify(response.body);
    for (const secretish of [tenantA, issued.form.id, 'tenant', 'key_hash']) {
      expect(text).not.toContain(secretish);
    }
  });

  it('sends no cookie, no cross-origin approval, and forbids caching', async () => {
    const issued = await createForm(adminA);
    const response = await publicRequest('GET', `/${issued.key}`, {
      headers: {
        origin: 'https://evil.example',
        cookie: 'crm_session=abc',
        authorization: 'Bearer abc',
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('answers a preflight with no approval', async () => {
    const issued = await createForm(adminA);
    const response = await harness.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'OPTIONS',
        url: `/api/v1/public/forms/${issued.key}/submissions`,
        headers: {
          origin: 'https://evil.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a query string', async () => {
    const issued = await createForm(adminA);
    expect((await publicRequest('GET', `/${issued.key}?tenant=${tenantB}`)).status).toBe(422);
  });
});

describe('a submission', () => {
  it('makes one lead in the form’s own workspace, from the web form, with an owner', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const response = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, {
        last_name: '  Asha Rao ',
        email: email.toUpperCase(),
        phone: '98765 43210',
        city: 'Kolkata',
      }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { received: true } });

    const leads = await leadsOf(adminA);
    const lead = leads.find((candidate) => candidate.email === email)!;
    expect(lead).toBeDefined();
    expect(lead.lastName).toBe('Asha Rao');
    expect(lead.phone).toBe('+919876543210');
    expect(lead.source).toBe('web_form');
    expect(lead.status).toBe('new');
    expect(lead.customFields['city']).toBe('Kolkata');
    // The form's creator can work leads, so the lead is theirs.
    expect(lead.ownerId).toBe(adminA.userId);

    // It is in no other workspace.
    expect((await leadsOf(adminB)).some((candidate) => candidate.email === email)).toBe(false);

    const stored = await one<{
      tenant_id: string;
      consent_version: number;
      consent_at: Date;
      source: string;
      form_id: string;
    }>(
      `select tenant_id, consent_version, consent_at, source, form_id from lead_form_submissions where lead_id = $1`,
      [lead.id],
    );
    expect(stored.tenant_id).toBe(tenantA);
    expect(stored.consent_version).toBe(1);
    expect(stored.source).toBe('web_form');
    expect(stored.form_id).toBe(issued.form.id);
    expect(Math.abs(Date.now() - stored.consent_at.getTime())).toBeLessThan(60_000);

    // The form's counters moved.
    const form = dataOf<Form>(await as(adminA, 'GET', `/lead-forms/${issued.form.id}`), 200);
    expect(form.stats.total).toBe(1);
    expect(form.stats.today).toBe(1);
  });

  it('records the lead creation without the visitor’s address or browser', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const remoteAddress = '203.0.113.77';
    await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
      remoteAddress,
      headers: { 'user-agent': 'Visitor-Browser/1.0 (secret-marker)' },
    });
    const lead = (await leadsOf(adminA)).find((candidate) => candidate.email === email)!;

    const audit = await one<{
      ip_address: string | null;
      user_agent: string | null;
      actor_id: string | null;
      action: string;
    }>(
      `select ip_address, user_agent, actor_id, action from audit_logs where tenant_id = $1 and object_type = 'lead' and record_id = $2`,
      [tenantA, lead.id],
    );
    expect(audit.action).toBe('create');
    expect(audit.ip_address).toBeNull();
    expect(audit.user_agent).toBeNull();
    expect(audit.actor_id).toBeNull();

    // Nowhere in what the database holds about this lead or this submission is the address or the browser.
    const everything = JSON.stringify([
      (await superuser.query(`select * from lead_form_submissions where lead_id = $1`, [lead.id]))
        .rows,
      (await superuser.query(`select * from leads where id = $1`, [lead.id])).rows,
      (await superuser.query(`select * from audit_logs where record_id = $1`, [lead.id])).rows,
      (await superuser.query(`select * from outbox_events where record_id = $1`, [lead.id])).rows,
    ]);
    expect(everything).not.toContain(remoteAddress);
    expect(everything).not.toContain('secret-marker');
  });

  it('announces the lead with its source and form, once', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
    });
    const lead = (await leadsOf(adminA)).find((candidate) => candidate.email === email)!;
    const events = await superuser.query(
      `select event_type, payload from outbox_events where record_id = $1`,
      [lead.id],
    );
    expect(events.rows).toHaveLength(1);
    const event = events.rows[0] as { event_type: string; payload: Record<string, unknown> };
    expect(event.event_type).toBe('lead.created.v1');
    expect(event.payload).toMatchObject({
      source: 'web_form',
      formId: issued.form.id,
      ownerId: adminA.userId,
    });
  });

  it('gives the lead to someone who can work it when the form maker no longer can', async () => {
    const issued = await createForm(adminA);
    await harness.fixtures.setMembershipStatus(tenantA, adminA.userId, 'suspended');
    try {
      const email = uniqueEmail();
      const response = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id, { email }),
      });
      expect(response.status).toBe(201);
      const stored = await one<{ owner_id: string | null }>(
        `select owner_id from leads where tenant_id = $1 and email = $2`,
        [tenantA, email],
      );
      // Not the suspended maker, and not a sales rep (no lead_form grant): the other admin.
      expect(stored.owner_id).toBe(secondAdminA.userId);
    } finally {
      await harness.fixtures.setMembershipStatus(tenantA, adminA.userId, 'active');
    }
  });

  it('answers a visitor the same whether or not they matched someone, and flags the match inside', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const existingId = await harness.fixtures.createLead(tenantA, {
      lastName: 'Existing',
      email,
      ownerId: repA.userId,
    });

    const first = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
    });
    const second = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body).toEqual(second.body);

    const flagged = await one<{ duplicate_of_type: string; duplicate_of_id: string }>(
      `select s.duplicate_of_type, s.duplicate_of_id from lead_form_submissions s
         join leads l on l.id = s.lead_id and l.tenant_id = s.tenant_id
        where s.tenant_id = $1 and l.email = $2 and l.id <> $3`,
      [tenantA, email, existingId],
    );
    expect(flagged.duplicate_of_type).toBe('lead');
    expect(flagged.duplicate_of_id).toBe(existingId);

    const events = await superuser.query(
      `select payload from outbox_events where tenant_id = $1 and event_type = 'lead.web_form_duplicate.v1'`,
      [tenantA],
    );
    expect(
      events.rows.some(
        (row: { payload: { matchedId: string; matchedOwnerId: string } }) =>
          row.payload.matchedId === existingId && row.payload.matchedOwnerId === repA.userId,
      ),
    ).toBe(true);
  });

  it('is visible to its owner and an admin, and not to a rep who does not own it', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
    });
    const lead = (await leadsOf(adminA)).find((candidate) => candidate.email === email)!;
    expect(lead.ownerId).toBe(adminA.userId);

    // The lead was made with no user, so nothing about it depends on one: scope is applied to whoever reads.
    expect((await as(secondAdminA, 'GET', `/leads/${lead.id}`)).status).toBe(200);
    expect((await as(repA, 'GET', `/leads/${lead.id}`)).status).toBe(404);
    expect((await leadsOf(repA)).some((candidate) => candidate.id === lead.id)).toBe(false);
  });

  it('answers a repeat with the same Idempotency-Key and makes no second lead', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const headers = { 'idempotency-key': `page-${Math.random().toString(36).slice(2)}` };
    const first = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
      headers,
    });
    const again = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
      headers,
    });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect((await leadsOf(adminA)).filter((lead) => lead.email === email)).toHaveLength(1);
  });

  it('makes one lead when two requests with one Idempotency-Key arrive together', async () => {
    const issued = await createForm(adminA);
    const headers = { 'idempotency-key': `race-${Math.random().toString(36).slice(2)}` };
    const email = uniqueEmail();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        publicRequest('POST', `/${issued.key}/submissions`, {
          body: submission(issued.form.id, { email }),
          headers,
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(Array(6).fill(201));
    expect((await leadsOf(adminA)).filter((lead) => lead.email === email)).toHaveLength(1);
  });

  it('treats the same person twice within a minute as one submission', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const first = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
    });
    const second = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
    });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await leadsOf(adminA)).filter((lead) => lead.email === email)).toHaveLength(1);
  });

  it('refuses a key on a form that does not ask for what was sent', async () => {
    const issued = await createForm(adminA, {
      fields: [
        { key: 'last_name', label: 'Name', required: true },
        { key: 'phone', label: 'Phone', required: true },
      ],
    });
    const response = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { phone: '9876543210' }),
    });
    // `email` is not a field of this form.
    expect(response.status).toBe(422);
  });
});

describe('what a stranger cannot do', () => {
  it('cannot choose the workspace, the user, the owner, the status or the source', async () => {
    const issued = await createForm(adminA);
    for (const injected of [
      { tenantId: tenantB },
      { tenant_id: tenantB },
      { userId: adminB.userId },
      { ownerId: adminB.userId },
      { owner_id: adminB.userId },
      { status: 'converted' },
      { source: 'referral' },
      { version: 99 },
      { id: '0198f0f0-0000-7000-8000-000000000000' },
    ]) {
      const body: unknown = JSON.parse(
        JSON.stringify({ ...submission(issued.form.id), ...injected }),
      );
      const response = await publicRequest('POST', `/${issued.key}/submissions`, { body });
      expect(response.status, JSON.stringify(injected)).toBe(422);
    }
    const sneaky = await publicRequest('POST', `/${issued.key}/submissions`, {
      rawBody: `{"consent":true,"fillToken":"${tokenFor(issued.form.id)}","last_name":"Rao","email":"${uniqueEmail()}","__proto__":{"tenantId":"${tenantB}"}}`,
    });
    // The server refuses a body with a `__proto__` key before the schema sees it (400), which is
    // stronger than the schema's own refusal (422). Either way, nothing is made.
    expect([400, 422]).toContain(sneaky.status);
    expect(
      (await leadsOf(adminB)).some((lead) => lead.lastName === 'Rao' && lead.source === 'web_form'),
    ).toBe(false);
  });

  it('is not moved by a tenant header, a bearer token, a cookie or a query string', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const response = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email }),
      headers: {
        'x-tenant-id': tenantB,
        authorization: `Bearer ${adminB.token}`,
        cookie: `crm_session=${adminB.token}`,
      },
    });
    expect(response.status).toBe(201);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await leadsOf(adminA)).some((lead) => lead.email === email)).toBe(true);
    expect((await leadsOf(adminB)).some((lead) => lead.email === email)).toBe(false);

    const withQuery = await publicRequest(
      'POST',
      `/${issued.key}/submissions?tenantId=${tenantB}`,
      {
        body: submission(issued.form.id),
      },
    );
    expect(withQuery.status).toBe(422);
  });

  it('cannot use a key from one workspace against another workspace’s data', async () => {
    const formA = await createForm(adminA);
    const formB = await createForm(adminB);
    const email = uniqueEmail();
    expect(
      (
        await publicRequest('POST', `/${formB.key}/submissions`, {
          body: submission(formB.form.id, { email }),
        })
      ).status,
    ).toBe(201);
    // Form B's token against form A's key is no token at all.
    const crossed = await publicRequest('POST', `/${formA.key}/submissions`, {
      body: submission(formB.form.id),
    });
    expect(crossed.status).toBe(422);
    expect((await leadsOf(adminB)).some((lead) => lead.email === email)).toBe(true);
    expect((await leadsOf(adminA)).some((lead) => lead.email === email)).toBe(false);
  });

  it('is told the same thing about every key that does not work', async () => {
    const live = await createForm(adminA);
    const disabled = await createForm(adminA);
    dataOf(
      await as(adminA, 'PATCH', `/lead-forms/${disabled.form.id}`, {
        status: 'disabled',
        version: disabled.form.version,
      }),
      200,
    );
    const revoked = await createForm(adminA);
    dataOf(
      await as(adminA, 'POST', `/lead-forms/${revoked.form.id}/key/revoke`, {
        version: revoked.form.version,
      }),
      200,
    );
    const deleted = await createForm(adminA);
    await as(adminA, 'DELETE', `/lead-forms/${deleted.form.id}?version=${deleted.form.version}`);

    const malformed = ['lfk_short', 'x', `lfk_${'A'.repeat(43)}`, `lfk_${'!'.repeat(43)}`];
    const unknownKey = `lfk_${'Z'.repeat(43)}`;

    const shapes = new Set<string>();
    const answers: PublicResponse[] = [];
    for (const key of [unknownKey, ...malformed, disabled.key, revoked.key, deleted.key]) {
      answers.push(await publicRequest('GET', `/${key}`));
      answers.push(
        await publicRequest('POST', `/${key}/submissions`, { body: submission(live.form.id) }),
      );
    }
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      const error = answer.body['error'] as Record<string, unknown>;
      shapes.add(
        JSON.stringify({
          code: error['code'],
          message: error['message'],
          details: error['details'],
        }),
      );
      expect(answer.headers['retry-after']).toBeUndefined();
    }
    expect(shapes.size).toBe(1);

    expect((await publicRequest('GET', `/${live.key}`)).status).toBe(200);
  });

  it('goes quiet when the feature is withdrawn from the workspace, with the same answer', async () => {
    const issued = await createForm(adminA);
    const unknown = await publicRequest('GET', `/lfk_${'Y'.repeat(43)}`);
    await superuser.query(
      `insert into tenant_entitlements (id, tenant_id, feature, enabled, reason)
       values (gen_random_uuid(), $1, 'web_forms', false, 'withdrawn for a test')`,
      [tenantA],
    );
    try {
      const withdrawn = await publicRequest('GET', `/${issued.key}`);
      expect(withdrawn.status).toBe(404);
      expect({ ...(withdrawn.body['error'] as object), requestId: '' }).toEqual({
        ...(unknown.body['error'] as object),
        requestId: '',
      });
      const post = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id),
      });
      expect(post.status).toBe(404);
      // Making a new form is refused with the plan's own answer: that is the company's own screen.
      const create = await as(adminA, 'POST', '/lead-forms', {
        name: 'No entitlement',
        fields: FIELDS,
        consentText: 'I agree that this company may contact me about my enquiry.',
        successMessage: 'Thanks.',
      });
      expect(create.status).toBe(402);
    } finally {
      await superuser.query(
        `delete from tenant_entitlements where tenant_id = $1 and feature = 'web_forms'`,
        [tenantA],
      );
    }
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(200);
  });

  it('goes quiet when the workspace pauses every form, and wakes when it resumes', async () => {
    const issued = await createForm(adminA);
    const paused = dataOf<{ paused: boolean }>(
      await as(adminA, 'POST', '/lead-forms/pause', { paused: true }),
      200,
    );
    expect(paused.paused).toBe(true);
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(404);
    expect(
      (
        await publicRequest('POST', `/${issued.key}/submissions`, {
          body: submission(issued.form.id),
        })
      ).status,
    ).toBe(404);
    dataOf(await as(adminA, 'POST', '/lead-forms/pause', { paused: false }), 200);
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(200);
  });

  it('goes quiet when the workspace is suspended', async () => {
    const issued = await createForm(adminB);
    await superuser.query(`update tenants set status = 'suspended' where id = $1`, [tenantB]);
    try {
      expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(404);
    } finally {
      await superuser.query(`update tenants set status = 'active' where id = $1`, [tenantB]);
    }
    expect((await publicRequest('GET', `/${issued.key}`)).status).toBe(200);
  });

  it('is turned away when the page was drawn too recently, too long ago, or never', async () => {
    const issued = await createForm(adminA);
    for (const fillToken of [
      issueFillToken(secret, issued.form.id, new Date()),
      issueFillToken(secret, issued.form.id, new Date(Date.now() - 5 * 3600 * 1000)),
      issueFillToken(secret, '0198f0f0-0000-7000-8000-000000000000', new Date(Date.now() - 10_000)),
      'forged',
      '',
    ]) {
      const response = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id, { fillToken }),
      });
      expect(response.status).toBe(422);
      expect((response.body['error'] as { code: string }).code).toBe('FORM_EXPIRED');
    }
    const missing = submission(issued.form.id);
    delete missing['fillToken'];
    expect(
      (await publicRequest('POST', `/${issued.key}/submissions`, { body: missing })).status,
    ).toBe(422);
  });

  it('is told it worked when it fills the hidden field, and nothing is made', async () => {
    const issued = await createForm(adminA);
    const email = uniqueEmail();
    const response = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, { email, website_url: 'http://spam.example' }),
    });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { received: true } });
    expect((await leadsOf(adminA)).some((lead) => lead.email === email)).toBe(false);
  });

  it('must give consent', async () => {
    const issued = await createForm(adminA);
    for (const consent of [false, 'true', 1, null]) {
      const response = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id, { consent }),
      });
      expect(response.status).toBe(422);
    }
    const none = submission(issued.form.id);
    delete none['consent'];
    expect((await publicRequest('POST', `/${issued.key}/submissions`, { body: none })).status).toBe(
      422,
    );
  });

  it('refuses any content type but JSON, and never parses it', async () => {
    const issued = await createForm(adminA);
    const form = submission(issued.form.id);
    const encoded = new URLSearchParams(
      Object.entries(form).map(([k, v]) => [k, String(v)]),
    ).toString();
    for (const [contentType, rawBody] of [
      ['text/plain', JSON.stringify(form)],
      ['application/x-www-form-urlencoded', encoded],
      [
        'multipart/form-data; boundary=x',
        `--x\r\nContent-Disposition: form-data; name="last_name"\r\n\r\nRao\r\n--x--\r\n`,
      ],
      ['application/xml', '<a/>'],
      ['text/html', '<b>x</b>'],
    ] as const) {
      const response = await publicRequest('POST', `/${issued.key}/submissions`, {
        rawBody,
        contentType,
      });
      expect([415, 400], contentType).toContain(response.status);
    }
    const none = await publicRequest('POST', `/${issued.key}/submissions`, {
      rawBody: JSON.stringify(form),
      contentType: null,
    });
    expect([415, 400]).toContain(none.status);
    expect((await leadsOf(adminA)).some((lead) => lead.email === form['email'])).toBe(false);
  });

  it('refuses a body that is not an object', async () => {
    const issued = await createForm(adminA);
    for (const rawBody of ['[]', 'null', '"x"', '12', '{"a":', '']) {
      const response = await publicRequest('POST', `/${issued.key}/submissions`, { rawBody });
      expect([400, 422], rawBody).toContain(response.status);
    }
  });

  it('refuses a body over 16 KB before reading it, declared or not', async () => {
    const issued = await createForm(adminA);
    const big = JSON.stringify({ ...submission(issued.form.id), last_name: 'a'.repeat(17 * 1024) });
    const declared = await publicRequest('POST', `/${issued.key}/submissions`, { rawBody: big });
    expect(declared.status).toBe(413);
    expect(JSON.stringify(declared.body)).not.toContain('aaaa');
  });

  it('refuses a value of 10,000 characters in every field', async () => {
    const issued = await createForm(adminA);
    const huge = 'x'.repeat(10_000);
    for (const key of ['last_name', 'email', 'phone', 'city']) {
      const response = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id, { [key]: huge }),
      });
      expect(response.status, key).toBe(422);
      expect(JSON.stringify(response.body)).not.toContain('xxxx');
    }
  });

  it('never repeats what it was sent when it refuses', async () => {
    const issued = await createForm(adminA);
    const marker = 'MARKER-9f3a7c';
    const response = await publicRequest('POST', `/${issued.key}/submissions`, {
      body: submission(issued.form.id, {
        email: marker,
        [marker]: marker,
        last_name: marker.repeat(40),
      }),
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain(marker);
  });

  it('stores markup as text and shows it as text everywhere it is read back', async () => {
    const issued = await createForm(adminA);
    const attacks = [
      '<script>alert(1)</script>',
      '"><img src=x onerror=alert(1)>',
      "'; DROP TABLE leads; --",
      '=HYPERLINK("http://evil.example","x")',
      '${7*7}{{7*7}}',
      '<svg/onload=alert(1)>',
    ];
    for (const attack of attacks) {
      const email = uniqueEmail();
      const response = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id, { email, last_name: attack, city: attack }),
      });
      expect(response.status, attack).toBe(201);

      const lead = (await leadsOf(adminA)).find((candidate) => candidate.email === email)!;
      expect(lead.lastName).toBe(attack);
      expect(lead.customFields['city']).toBe(attack);
      const detail = dataOf<Lead>(await as(adminA, 'GET', `/leads/${lead.id}`), 200);
      expect(detail.lastName).toBe(attack);
    }
    // Still there: the injection attempt did nothing.
    expect((await leadsOf(adminA)).length).toBeGreaterThan(0);
    await harness.indexForSearch(tenantA);
    const found = await as(adminA, 'GET', `/search?q=${encodeURIComponent('onerror')}`);
    expect(found.status).toBe(200);
  });
});

describe('limits', () => {
  it('turns an address away after ten attempts at one form in a window, with Retry-After', async () => {
    const issued = await createForm(adminA);
    const remoteAddress = nextAddress();
    const statuses: number[] = [];
    let last: PublicResponse | null = null;
    for (let i = 0; i < 12; i += 1) {
      last = await publicRequest('POST', `/${issued.key}/submissions`, {
        body: submission(issued.form.id),
        remoteAddress,
      });
      statuses.push(last.status);
    }
    expect(
      statuses
        .slice(0, harness.env.PUBLIC_FORM_RATE_PER_ADDRESS_FORM)
        .every((status) => status === 201),
    ).toBe(true);
    expect(statuses.slice(-2)).toEqual([429, 429]);
    expect(last!.headers['retry-after']).toMatch(/^\d+$/);
    // The answer says whose budget it is and not how big it is.
    expect(JSON.stringify(last!.body)).not.toMatch(/\b10\b/);
    expect(last!.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('throttles a guesser of keys harder than a visitor', async () => {
    const remoteAddress = nextAddress();
    const max = harness.env.PUBLIC_FORM_RATE_BAD_KEY_PER_ADDRESS;
    const statuses: number[] = [];
    for (let i = 0; i < max + 3; i += 1) {
      statuses.push(
        (await publicRequest('GET', `/lfk_${String(i).padStart(43, 'Q')}`, { remoteAddress }))
          .status,
      );
    }
    expect(statuses.slice(0, max).every((status) => status === 404)).toBe(true);
    expect(statuses.slice(max)).toEqual([429, 429, 429]);
  });

  it('does not spend the staff’s own budget', async () => {
    const issued = await createForm(adminA);
    await publicRequest('POST', `/${issued.key}/submissions`, { body: submission(issued.form.id) });
    // The staff budget is a `user:` and a `tenant:` key; the public limits have their own kinds, so a
    // flood of the public routes cannot make the signed-in API answer 429.
    expect((await as(adminA, 'GET', '/lead-forms')).status).toBe(200);
  });
});
