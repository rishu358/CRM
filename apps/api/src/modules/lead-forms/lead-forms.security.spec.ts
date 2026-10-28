import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { API_ROUTES } from '@crm/contracts';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The mandatory per-module security suites (CLAUDE.md §10) for website lead forms (ADR-0063), and the
 * test that keeps the one deliberate exception to "unauthenticated requests get 401" the size it was
 * agreed to be. Through the real HTTP stack, with the production guards, pipes and database roles.
 *
 *   (a) tenant A cannot list, read, change, rotate, revoke or delete tenant B's forms
 *   (b) only the `lead_form` grant manages forms; each action is its own grant
 *   (c) nothing secret is in any response: no key after the first, no digest, no wording history
 *   (d) unauthenticated requests get 401: every route that is not on the frozen public list
 */

interface Person {
  token: string;
  userId: string;
}
interface Form {
  id: string;
  version: number;
}
interface Issued {
  form: Form;
  key: string;
}

let harness: ApiHarness;
let tenantA: string;
let tenantB: string;
let adminA: Person;
let adminB: Person;
let repA: Person;
let readerA: Person;
let creatorA: Person;
let formB: Issued;

const MISSING = '0198f0f0-0000-7000-8000-000000000000';
const FIELDS = [
  { key: 'last_name', label: 'Name', required: true },
  { key: 'email', label: 'Email', required: false },
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

async function customRole(
  tenantId: string,
  name: string,
  grants: [string, 'read' | 'create' | 'update' | 'delete', 'own' | 'team' | 'all'][],
): Promise<Person> {
  const roleId = await harness.fixtures.createRole(tenantId, name);
  for (const [objectType, action, scope] of grants) {
    await harness.fixtures.grant(tenantId, roleId, objectType, action, scope);
  }
  return person(tenantId, roleId);
}

async function make(who: Person, name: string): Promise<Issued> {
  return dataOf<Issued>(
    await as(who, 'POST', '/lead-forms', {
      name,
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
    }),
    201,
  );
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantA = (await harness.fixtures.createTenant({ name: 'Acme Security Forms' })).tenantId;
  const rolesA = await harness.provision(tenantA);
  tenantB = (await harness.fixtures.createTenant({ name: 'Rival Security Forms' })).tenantId;
  const rolesB = await harness.provision(tenantB);

  adminA = await person(tenantA, rolesA.get('Admin')!);
  repA = await person(tenantA, rolesA.get('Sales Rep')!);
  adminB = await person(tenantB, rolesB.get('Admin')!);
  readerA = await customRole(tenantA, 'Form reader', [['lead_form', 'read', 'all']]);
  creatorA = await customRole(tenantA, 'Form creator', [
    ['lead_form', 'read', 'all'],
    ['lead_form', 'create', 'all'],
  ]);
  formB = await make(adminB, 'Rival private form');
});

afterAll(async () => {
  await harness.close();
});

describe('(a) tenant A cannot reach tenant B', () => {
  it('does not list B’s forms', async () => {
    await make(adminA, 'Acme own form');
    const list = dataOf<{ id: string; name: string }[]>(
      await as(adminA, 'GET', '/lead-forms'),
      200,
    );
    expect(list.some((form) => form.id === formB.form.id)).toBe(false);
    expect(JSON.stringify(list)).not.toContain('Rival private form');
  });

  it.each([
    ['reads', 'GET', ''],
    ['edits', 'PATCH', ''],
    ['deletes', 'DELETE', '?version=1'],
    ['rotates the key of', 'POST', '/key/rotate'],
    ['revokes the keys of', 'POST', '/key/revoke'],
  ] as const)('answers 404 when A %s B’s form', async (_label, method, suffix) => {
    const body =
      method === 'PATCH'
        ? { name: 'Hijacked', version: formB.form.version }
        : method === 'POST'
          ? { version: formB.form.version, graceHours: 0 }
          : undefined;
    const response = await as(adminA, method, `/lead-forms/${formB.form.id}${suffix}`, body);
    expect(response.status).toBe(404);

    // Nothing of B's was touched.
    const still = dataOf<{ name: string; keyHint: string | null; status: string }>(
      await as(adminB, 'GET', `/lead-forms/${formB.form.id}`),
      200,
    );
    expect(still.name).toBe('Rival private form');
    expect(still.keyHint).toBe(formB.key.slice(-4));
    expect(still.status).toBe('enabled');
  });

  it('keeps B’s pause switch and A’s apart', async () => {
    dataOf(await as(adminA, 'POST', '/lead-forms/pause', { paused: true }), 200);
    const b = dataOf<{ paused: boolean }>(await as(adminB, 'GET', '/lead-forms/setup'), 200);
    expect(b.paused).toBe(false);
    dataOf(await as(adminA, 'POST', '/lead-forms/pause', { paused: false }), 200);
  });
});

describe('(b) only the lead_form grant manages forms', () => {
  it('refuses a sales rep every administration route with 403', async () => {
    const own = await make(adminA, 'Rep target form');
    for (const [method, url, body] of [
      ['GET', '/lead-forms', undefined],
      ['GET', '/lead-forms/setup', undefined],
      ['GET', `/lead-forms/${own.form.id}`, undefined],
      [
        'POST',
        '/lead-forms',
        {
          name: 'x',
          fields: FIELDS,
          consentText: 'I agree that this company may contact me.',
          successMessage: 'x',
        },
      ],
      ['PATCH', `/lead-forms/${own.form.id}`, { name: 'x', version: own.form.version }],
      ['DELETE', `/lead-forms/${own.form.id}?version=${own.form.version}`, undefined],
      [
        'POST',
        `/lead-forms/${own.form.id}/key/rotate`,
        { graceHours: 0, version: own.form.version },
      ],
      ['POST', `/lead-forms/${own.form.id}/key/revoke`, { version: own.form.version }],
      ['POST', '/lead-forms/pause', { paused: true }],
    ] as const) {
      const response = await as(repA, method, url, body);
      expect(response.status, `${method} ${url}`).toBe(403);
    }
  });

  it('makes each action its own grant', async () => {
    const own = await make(adminA, 'Grant target form');
    // A reader reads and nothing else.
    expect((await as(readerA, 'GET', '/lead-forms')).status).toBe(200);
    expect((await as(readerA, 'GET', `/lead-forms/${own.form.id}`)).status).toBe(200);
    for (const [method, url, body] of [
      ['PATCH', `/lead-forms/${own.form.id}`, { name: 'x', version: own.form.version }],
      ['DELETE', `/lead-forms/${own.form.id}?version=${own.form.version}`, undefined],
      [
        'POST',
        `/lead-forms/${own.form.id}/key/rotate`,
        { graceHours: 0, version: own.form.version },
      ],
      ['POST', '/lead-forms/pause', { paused: true }],
    ] as const) {
      expect((await as(readerA, method, url, body)).status, `${method} ${url}`).toBe(403);
    }
    // A creator creates, and still cannot edit, rotate or delete.
    const created = await as(creatorA, 'POST', '/lead-forms', {
      name: 'Made by a creator',
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
    });
    expect(created.status).toBe(201);
    expect(
      (
        await as(creatorA, 'PATCH', `/lead-forms/${own.form.id}`, {
          name: 'x',
          version: own.form.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await as(creatorA, 'POST', `/lead-forms/${own.form.id}/key/rotate`, {
          graceHours: 0,
          version: own.form.version,
        })
      ).status,
    ).toBe(403);
  });

  it('does not let any lead permission stand in for it', async () => {
    const leadAdmin = await customRole(tenantA, 'Lead boss', [
      ['lead', 'read', 'all'],
      ['lead', 'create', 'all'],
      ['lead', 'update', 'all'],
      ['lead', 'delete', 'all'],
    ]);
    expect((await as(leadAdmin, 'GET', '/lead-forms')).status).toBe(403);
    expect((await as(leadAdmin, 'POST', '/lead-forms/pause', { paused: true })).status).toBe(403);
  });
});

describe('(c) nothing secret is in an answer', () => {
  it('returns the key once, and never a digest, a hash or the wording history', async () => {
    const issued = await make(adminA, 'Secrecy form');
    const dump = JSON.stringify([
      await as(adminA, 'GET', '/lead-forms'),
      await as(adminA, 'GET', `/lead-forms/${issued.form.id}`),
      await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
        name: 'Secrecy form renamed',
        version: issued.form.version,
      }),
    ]);
    expect(dump).not.toContain(issued.key);
    for (const word of ['key_hash', 'keyHash', 'digest', 'consentTexts', 'idempotency']) {
      expect(dump).not.toContain(word);
    }
  });

  it('rejects a write that names a key, a digest or another workspace', async () => {
    const issued = await make(adminA, 'Write guard form');
    for (const extra of [
      { keyHash: 'abcd' },
      { key: 'lfk_x' },
      { tenantId: tenantB },
      { createdBy: adminB.userId },
      { consentVersion: 99 },
      { deletedAt: '2020-01-01T00:00:00Z' },
    ]) {
      const response = await as(adminA, 'PATCH', `/lead-forms/${issued.form.id}`, {
        name: 'Still mine',
        version: issued.form.version,
        ...extra,
      });
      expect(response.status, JSON.stringify(extra)).toBe(422);
    }
  });
});

describe('(d) unauthenticated requests get 401, except the two public routes', () => {
  /**
   * The routes a stranger may reach (ADR-0063 1). Frozen on purpose: adding a `@Public()` handler
   * without adding it here, and to the ADR, must fail this test.
   */
  const PUBLIC_ROUTES: readonly string[] = [
    'GET /health',
    'GET /health/ready',
    'GET /openapi.json',
    'GET /public/forms/{key}',
    'POST /public/forms/{key}/submissions',
    // The sign-in family and invitations: public by nature, each guarded by its own credential.
    'POST /auth/sign-up',
    'POST /auth/sign-in',
    'POST /auth/forgot-password',
    'POST /auth/reset-password',
    'POST /auth/verify-email',
    'POST /auth/resend-verification',
    'POST /auth/mfa/verify',
    'GET /auth/google',
    'GET /auth/google/callback',
    'GET /invitations/accept',
    'POST /invitations/accept',
  ];

  const routes = API_ROUTES.map((route) => `${route.method} ${route.path}`);

  it('lists as public exactly the routes on the frozen list, and no others', () => {
    const marked = API_ROUTES.filter((route) => route.auth === 'public').map(
      (route) => `${route.method} ${route.path}`,
    );
    const unlisted = marked.filter((route) => !PUBLIC_ROUTES.includes(route));
    expect(unlisted).toEqual([]);
    // The two this feature adds are in the registry as public.
    expect(marked).toContain('GET /public/forms/{key}');
    expect(marked).toContain('POST /public/forms/{key}/submissions');
  });

  it('answers 401 to every other route when no credential is sent', async () => {
    const guarded = API_ROUTES.filter((route) => route.auth === 'session');
    expect(guarded.length).toBeGreaterThan(50);
    const refused: string[] = [];
    for (const route of guarded) {
      const url = route.path.replace(/\{[^}]+\}/g, MISSING);
      const method = route.method as 'GET' | 'POST' | 'PATCH' | 'DELETE';
      const response = await as(
        null,
        method,
        url,
        method === 'GET' || method === 'DELETE' ? undefined : {},
      );
      if (response.status !== 401)
        refused.push(`${route.method} ${route.path} -> ${response.status}`);
    }
    expect(refused).toEqual([]);
    expect(routes.length).toBeGreaterThan(guarded.length);
  });

  it('answers the public routes only with their strict schema', async () => {
    const issued = await make(adminA, 'Strict schema form');
    const post = (body: unknown) =>
      harness.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'POST',
          url: `/api/v1/public/forms/${issued.key}/submissions`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(body),
          remoteAddress: '198.51.100.9',
        });
    expect((await post({ anything: 'else' })).statusCode).toBe(422);
    expect((await post({})).statusCode).toBe(422);
  });
});
