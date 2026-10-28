import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { deriveFillTokenSecret, issueFillToken } from '@crm/core/lead-form-token';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The hard daily caps (ADR-0063 4.1), counted in the database so they hold without Redis, with small
 * ceilings so the tests can reach them: 5 leads a day per form, 8 per workspace.
 */

interface Issued {
  form: { id: string };
  key: string;
}

let harness: ApiHarness;
let superuser: pg.Pool;
let secret: Buffer;
let counter = 0;

const FIELDS = [
  { key: 'last_name', label: 'Name', required: true },
  { key: 'email', label: 'Email', required: false },
];

async function adminOf(name: string): Promise<{ token: string; tenantId: string }> {
  const tenantId = (await harness.fixtures.createTenant({ name })).tenantId;
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  return { tenantId, token: await harness.signIn(user.userId, tenantId) };
}

async function makeForm(token: string): Promise<Issued> {
  counter += 1;
  return dataOf<Issued>(
    await request(harness, {
      method: 'POST',
      url: '/api/v1/lead-forms',
      token,
      body: {
        name: `Capped ${counter} ${Math.random().toString(36).slice(2, 7)}`,
        fields: FIELDS,
        consentText: 'I agree that this company may contact me about my enquiry.',
        successMessage: 'Thanks.',
      },
    }),
    201,
  );
}

async function send(issued: Issued): Promise<{ status: number; retryAfter: string | undefined }> {
  counter += 1;
  const response = await harness.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/api/v1/public/forms/${issued.key}/submissions`,
      headers: { 'content-type': 'application/json' },
      remoteAddress: `10.30.${Math.floor(counter / 250)}.${(counter % 250) + 1}`,
      payload: JSON.stringify({
        last_name: 'Rao',
        email: `cap${counter}.${Math.random().toString(36).slice(2, 8)}@example.com`,
        consent: true,
        fillToken: issueFillToken(secret, issued.form.id, new Date(Date.now() - 10_000)),
      }),
    });
  const retry = response.headers['retry-after'];
  return {
    status: response.statusCode,
    retryAfter: retry === undefined ? undefined : String(retry),
  };
}

async function leadCount(tenantId: string): Promise<number> {
  const result = await superuser.query(
    `select count(*)::int as n from leads where tenant_id = $1 and source = 'web_form'`,
    [tenantId],
  );
  return (result.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, {
    LEAD_FORM_MAX_PER_FORM_PER_DAY: '5',
    LEAD_FORM_MAX_PER_TENANT_PER_DAY: '8',
  });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 2 });
  secret = deriveFillTokenSecret(harness.env.AUTH_SECRET);
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

describe('the daily caps', () => {
  it('stops a form at its cap, says when to come back, and makes no lead beyond it', async () => {
    const admin = await adminOf('Cap Form Co');
    const issued = await makeForm(admin.token);
    const statuses: number[] = [];
    let last: { status: number; retryAfter: string | undefined } | null = null;
    for (let i = 0; i < 7; i += 1) {
      last = await send(issued);
      statuses.push(last.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429, 429]);
    expect(Number(last!.retryAfter)).toBeGreaterThan(0);
    expect(Number(last!.retryAfter)).toBeLessThanOrEqual(86_400);
    expect(await leadCount(admin.tenantId)).toBe(5);
  });

  it('stops a workspace at its own cap across all its forms', async () => {
    const admin = await adminOf('Cap Tenant Co');
    const forms = [await makeForm(admin.token), await makeForm(admin.token)];
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) statuses.push((await send(forms[i % 2]!)).status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(8);
    expect(statuses.filter((status) => status === 429)).toHaveLength(4);
    expect(await leadCount(admin.tenantId)).toBe(8);
  });

  it('holds exactly under concurrent submissions', async () => {
    const admin = await adminOf('Cap Race Co');
    const issued = await makeForm(admin.token);
    const results = await Promise.all(Array.from({ length: 24 }, () => send(issued)));
    expect(results.filter((result) => result.status === 201)).toHaveLength(5);
    expect(results.filter((result) => result.status === 429)).toHaveLength(19);
    expect(await leadCount(admin.tenantId)).toBe(5);
  });

  it('does not let one workspace’s traffic use another’s allowance', async () => {
    const busy = await adminOf('Busy Co');
    const quiet = await adminOf('Quiet Co');
    const busyForm = await makeForm(busy.token);
    const quietForm = await makeForm(quiet.token);
    for (let i = 0; i < 7; i += 1) await send(busyForm);
    expect((await send(quietForm)).status).toBe(201);
  });
});
