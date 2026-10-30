import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { deriveFillTokenSecret, issueFillToken } from '@crm/core/lead-form-token';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Lead assignment rules (ADR-0065 10), through the real HTTP stack: the administration, and what the
 * rules do to the leads a website form makes, including fairness under concurrency and the promise
 * that a broken rule never costs a lead.
 */

interface Person {
  token: string;
  userId: string;
}
interface Rule {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  version: number;
  action: Record<string, unknown>;
}
interface Overview {
  rules: Rule[];
  settings: { defaultOwnerId: string | null; defaultOwnerEligible: boolean; version: number };
  fields: { key: string; label: string; type: string }[];
  people: { id: string; name: string }[];
  teams: { id: string; name: string; eligibleMembers: number }[];
  maxRules: number;
}
interface Issued {
  form: { id: string; version: number };
  key: string;
}

let harness: ApiHarness;
let superuser: pg.Pool;
let secret: Buffer;
let tenantId: string;
let owner: Person;
let admins: Person[];
let rep: Person;
let readOnly: Person;
let teamId: string;
let counter = 0;

const FIELDS = [
  { key: 'last_name', label: 'Your name', required: true },
  { key: 'email', label: 'Email', required: false },
  { key: 'city', label: 'City', required: false },
];

async function person(roleId: string): Promise<Person> {
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

const overview = async (): Promise<Overview> =>
  dataOf<Overview>(await as(owner, 'GET', '/lead-assignment'), 200);

async function clearRules(): Promise<void> {
  for (const rule of (await overview()).rules) {
    await as(owner, 'DELETE', `/lead-assignment/rules/${rule.id}?version=${rule.version}`);
  }
  const current = await overview();
  await as(owner, 'PATCH', '/lead-assignment/settings', {
    defaultOwnerId: null,
    version: current.settings.version,
  });
}

async function addRule(body: Record<string, unknown>): Promise<Rule> {
  const after = dataOf<Overview>(
    await as(owner, 'POST', '/lead-assignment/rules', { name: `Rule ${++counter}`, ...body }),
    201,
  );
  return after.rules[after.rules.length - 1]!;
}

async function makeForm(): Promise<Issued> {
  return dataOf<Issued>(
    await as(owner, 'POST', '/lead-forms', {
      name: `Assigned ${++counter} ${Math.random().toString(36).slice(2, 7)}`,
      fields: FIELDS,
      consentText: 'I agree that this company may contact me about my enquiry.',
      successMessage: 'Thanks.',
    }),
    201,
  );
}

async function submit(
  issued: Issued,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; email: string }> {
  counter += 1;
  const email = `rr${counter}.${Math.random().toString(36).slice(2, 8)}@example.com`;
  const response = await harness.app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: 'POST',
      url: `/api/v1/public/forms/${issued.key}/submissions`,
      headers: { 'content-type': 'application/json' },
      remoteAddress: `10.40.${Math.floor(counter / 250)}.${(counter % 250) + 1}`,
      payload: JSON.stringify({
        last_name: 'Rao',
        email,
        consent: true,
        fillToken: issueFillToken(secret, issued.form.id, new Date(Date.now() - 10_000)),
        ...extra,
      }),
    });
  return { status: response.statusCode, email };
}

async function ownerOf(email: string): Promise<string | null> {
  const result = await superuser.query(
    `select owner_id from leads where tenant_id = $1 and email = $2`,
    [tenantId, email],
  );
  return (result.rows[0] as { owner_id: string | null } | undefined)?.owner_id ?? null;
}

beforeAll(async () => {
  const urls = inject('dbUrls');
  harness = await startApiHarness(urls, {
    PUBLIC_FORM_RATE_PER_ADDRESS_FORM: '1000',
    PUBLIC_FORM_RATE_PER_FORM: '5000',
    PUBLIC_FORM_RATE_PER_TENANT_HOUR: '50000',
    LEAD_FORM_MAX_PER_FORM_PER_DAY: '5000',
    LEAD_FORM_MAX_PER_TENANT_PER_DAY: '5000',
  });
  superuser = new pg.Pool({ connectionString: urls.superuser, max: 3 });
  secret = deriveFillTokenSecret(harness.env.AUTH_SECRET);

  tenantId = (await harness.fixtures.createTenant({ name: 'Rules Co' })).tenantId;
  const roles = await harness.provision(tenantId);
  owner = await person(roles.get('Owner')!);
  admins = [
    await person(roles.get('Admin')!),
    await person(roles.get('Admin')!),
    await person(roles.get('Admin')!),
  ];
  rep = await person(roles.get('Sales Rep')!);
  readOnly = await person(roles.get('Read-only')!);
  teamId = await harness.fixtures.createTeam(
    tenantId,
    'Closers',
    admins.map((admin) => admin.userId),
  );
  await superuser.query(
    `insert into field_definitions (id, tenant_id, object_type, key, label, type, required, is_system, is_active, position)
     values (gen_random_uuid(), $1, 'lead', 'city', 'City', 'text', false, false, true, 100)`,
    [tenantId],
  );
});

afterAll(async () => {
  await superuser.end();
  await harness.close();
});

describe('the administration', () => {
  it('shows what the editor can offer: fields, people who can take leads, teams', async () => {
    await clearRules();
    const view = await overview();
    expect(view.rules).toEqual([]);
    expect(view.maxRules).toBe(50);
    expect(view.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining(['city', 'source', 'form_id']),
    );
    const ids = view.people.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([owner.userId, ...admins.map((admin) => admin.userId), rep.userId]),
    );
    // A read-only person cannot update a lead, so is not offered.
    expect(ids).not.toContain(readOnly.userId);
    expect(view.teams).toEqual([{ id: teamId, name: 'Closers', eligibleMembers: 3 }]);
  });

  it('adds, edits, orders and removes rules, with an audit entry and an event each time', async () => {
    await clearRules();
    const first = await addRule({
      action: { type: 'user', userId: admins[0]!.userId },
      conditions: [{ field: 'city', operator: 'equals', value: 'Pune' }],
    });
    const second = await addRule({ action: { type: 'default_owner' } });
    expect(first.position).toBeLessThan(second.position);

    dataOf(
      await as(owner, 'POST', '/lead-assignment/rules/order', { ruleIds: [second.id, first.id] }),
      200,
    );
    const ordered = (await overview()).rules.map((rule) => rule.id);
    expect(ordered).toEqual([second.id, first.id]);

    const renamed = dataOf<Rule>(
      await as(owner, 'PATCH', `/lead-assignment/rules/${first.id}`, {
        name: 'Pune to Arun',
        enabled: false,
        version: first.version,
      }),
      200,
    );
    expect(renamed.name).toBe('Pune to Arun');
    expect(renamed.enabled).toBe(false);
    expect(renamed.version).toBe(first.version + 1);

    expect(
      (await as(owner, 'DELETE', `/lead-assignment/rules/${second.id}?version=${second.version}`))
        .status,
    ).toBe(204);

    const events = await superuser.query(
      `select event_type from outbox_events where tenant_id = $1 and event_type like 'lead_assignment%' order by created_at`,
      [tenantId],
    );
    const types = events.rows.map((row: { event_type: string }) => row.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        'lead_assignment_rule.created.v1',
        'lead_assignment_rules.ordered.v1',
        'lead_assignment_rule.updated.v1',
        'lead_assignment_rule.deleted.v1',
      ]),
    );
    const audit = await superuser.query(
      `select count(*)::int as n from audit_logs where tenant_id = $1 and object_type = 'lead_assignment'`,
      [tenantId],
    );
    expect((audit.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(5);
  });

  it('refuses a stale edit with 409, a missing rule with 404, and a repeated name', async () => {
    await clearRules();
    const rule = await addRule({ name: 'Unique rule', action: { type: 'default_owner' } });
    dataOf(
      await as(owner, 'PATCH', `/lead-assignment/rules/${rule.id}`, {
        enabled: false,
        version: rule.version,
      }),
      200,
    );
    expect(
      (
        await as(owner, 'PATCH', `/lead-assignment/rules/${rule.id}`, {
          enabled: true,
          version: rule.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await as(owner, 'PATCH', '/lead-assignment/rules/0198f0f0-0000-7000-8000-000000000000', {
          enabled: true,
          version: 1,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await as(owner, 'POST', '/lead-assignment/rules', {
          name: 'unique RULE',
          action: { type: 'default_owner' },
        })
      ).status,
    ).toBe(409);
  });

  it.each([
    ['an unknown field', { conditions: [{ field: 'nope', operator: 'equals', value: 'x' }] }],
    ['a missing value', { conditions: [{ field: 'city', operator: 'equals' }] }],
    ['an unknown operator', { conditions: [{ field: 'city', operator: 'matches', value: '.*' }] }],
    [
      'a person who cannot take leads',
      { action: { type: 'user', userId: '0198f0f0-0000-7000-8000-000000000001' } },
    ],
    ['a read-only person', { action: { type: 'user', userId: 'READONLY' } }],
    [
      'a team that does not exist',
      { action: { type: 'team_round_robin', teamId: '0198f0f0-0000-7000-8000-000000000002' } },
    ],
    ['an unknown action', { action: { type: 'script', code: 'x' } }],
    [
      'too many conditions',
      {
        conditions: Array.from({ length: 11 }, () => ({
          field: 'city',
          operator: 'equals',
          value: 'x',
        })),
      },
    ],
  ])('refuses a rule with %s', async (_label, change) => {
    const body = JSON.parse(
      JSON.stringify({ name: 'Bad rule', action: { type: 'default_owner' }, ...change }).replace(
        'READONLY',
        readOnly.userId,
      ),
    ) as unknown;
    expect((await as(owner, 'POST', '/lead-assignment/rules', body)).status).toBe(422);
  });

  it('chooses a default owner only among people who can take leads', async () => {
    await clearRules();
    const current = await overview();
    expect(
      (
        await as(owner, 'PATCH', '/lead-assignment/settings', {
          defaultOwnerId: readOnly.userId,
          version: current.settings.version,
        })
      ).status,
    ).toBe(422);
    const set = dataOf<Overview>(
      await as(owner, 'PATCH', '/lead-assignment/settings', {
        defaultOwnerId: admins[1]!.userId,
        version: current.settings.version,
      }),
      200,
    );
    expect(set.settings).toMatchObject({
      defaultOwnerId: admins[1]!.userId,
      defaultOwnerEligible: true,
    });
    expect(
      (
        await as(owner, 'PATCH', '/lead-assignment/settings', {
          defaultOwnerId: null,
          version: current.settings.version,
        })
      ).status,
    ).toBe(409);
  });

  it('stops at fifty rules', async () => {
    await clearRules();
    for (let i = 0; i < 50; i += 1)
      await addRule({ name: `Cap ${i}`, action: { type: 'default_owner' } });
    expect(
      (
        await as(owner, 'POST', '/lead-assignment/rules', {
          name: 'Fifty-first',
          action: { type: 'default_owner' },
        })
      ).status,
    ).toBe(409);
    await clearRules();
  });

  it('refuses an order that leaves a rule out or names one twice', async () => {
    await clearRules();
    const a = await addRule({ action: { type: 'default_owner' } });
    const b = await addRule({ action: { type: 'default_owner' } });
    expect(
      (await as(owner, 'POST', '/lead-assignment/rules/order', { ruleIds: [a.id] })).status,
    ).toBe(409);
    expect(
      (await as(owner, 'POST', '/lead-assignment/rules/order', { ruleIds: [a.id, a.id] })).status,
    ).toBe(409);
    expect(
      (
        await as(owner, 'POST', '/lead-assignment/rules/order', {
          ruleIds: [a.id, b.id, '0198f0f0-0000-7000-8000-000000000003'],
        })
      ).status,
    ).toBe(409);
  });
});

describe('testing a sample lead', () => {
  it('says who would get it and by which rule, and takes no turn', async () => {
    await clearRules();
    const rule = await addRule({
      name: 'Closers by city',
      conditions: [{ field: 'city', operator: 'equals', value: 'Pune' }],
      action: { type: 'team_round_robin', teamId },
    });

    const tried = [];
    for (let i = 0; i < 5; i += 1) {
      tried.push(
        dataOf<{ ownerId: string; reason: string; ruleName: string }>(
          await as(owner, 'POST', '/lead-assignment/test', { fields: { city: ' pune ' } }),
          200,
        ),
      );
    }
    // Five tests, and the same answer each time: nobody's turn moved.
    expect(new Set(tried.map((answer) => answer.ownerId)).size).toBe(1);
    expect(tried[0]).toMatchObject({ reason: 'rule', ruleName: 'Closers by city' });

    const elsewhere = dataOf<{ reason: string; ruleId: string | null }>(
      await as(owner, 'POST', '/lead-assignment/test', { fields: { city: 'Delhi' } }),
      200,
    );
    expect(elsewhere.reason).toBe('fallback');
    expect(elsewhere.ruleId).toBeNull();

    // And the real first lead still goes to the first in turn.
    const form = await makeForm();
    const real = await submit(form, { city: 'Pune' });
    expect(real.status).toBe(201);
    expect(await ownerOf(real.email)).toBe(tried[0]!.ownerId);
    expect(rule.id).toBeDefined();
  });
});

describe('the leads a form makes', () => {
  it('goes to the person a matching rule names, and says why in the lead’s history', async () => {
    await clearRules();
    await addRule({
      name: 'Pune to Arun',
      conditions: [{ field: 'city', operator: 'equals', value: 'Pune' }],
      action: { type: 'user', userId: admins[2]!.userId },
    });
    const form = await makeForm();
    const hit = await submit(form, { city: 'Pune' });
    const miss = await submit(form, { city: 'Delhi' });
    expect(await ownerOf(hit.email)).toBe(admins[2]!.userId);
    // No rule matched: the form's maker.
    expect(await ownerOf(miss.email)).toBe(owner.userId);

    const audit = await superuser.query(
      `select a.changes from audit_logs a join leads l on l.id = a.record_id
        where l.email = $1 and a.object_type = 'lead' and a.action = 'update'`,
      [hit.email],
    );
    expect(JSON.stringify(audit.rows)).toContain('rule: Pune to Arun');
  });

  it('goes round a team in turn, and each gets the same share when submissions arrive together', async () => {
    await clearRules();
    await addRule({ name: 'Round the closers', action: { type: 'team_round_robin', teamId } });
    const form = await makeForm();

    const sequential = [];
    for (let i = 0; i < 6; i += 1) sequential.push(await submit(form));
    const first = await Promise.all(sequential.map((entry) => ownerOf(entry.email)));
    const sixOrdered = [...first];
    expect(new Set(sixOrdered.slice(0, 3)).size).toBe(3);
    expect(sixOrdered.slice(0, 3)).toEqual(sixOrdered.slice(3, 6));

    const together = await Promise.all(Array.from({ length: 30 }, () => submit(form)));
    expect(together.every((entry) => entry.status === 201)).toBe(true);
    const owners = await Promise.all(together.map((entry) => ownerOf(entry.email)));
    const shares = new Map<string | null, number>();
    for (const id of owners) shares.set(id, (shares.get(id) ?? 0) + 1);
    expect([...shares.values()].sort()).toEqual([10, 10, 10]);
    expect([...shares.keys()].sort()).toEqual(admins.map((admin) => admin.userId).sort());
  });

  it('skips a person who has left, and a rule that cannot be carried out, rather than stopping there', async () => {
    await clearRules();
    await addRule({
      name: 'To a person who left',
      action: { type: 'user', userId: admins[0]!.userId },
    });
    await addRule({ name: 'Then to Bela', action: { type: 'user', userId: admins[1]!.userId } });
    const form = await makeForm();

    await harness.fixtures.setMembershipStatus(tenantId, admins[0]!.userId, 'suspended');
    try {
      const sent = await submit(form);
      expect(await ownerOf(sent.email)).toBe(admins[1]!.userId);
    } finally {
      await harness.fixtures.setMembershipStatus(tenantId, admins[0]!.userId, 'active');
    }
  });

  it('never loses a lead when the rules cannot answer: it goes to the fallback, and the failure is audited', async () => {
    await clearRules();
    const rule = await addRule({
      name: 'Locked rule',
      action: { type: 'team_round_robin', teamId },
    });
    const form = await makeForm();
    // One real submission, so the rule's turn-keeper exists.
    expect((await submit(form)).status).toBe(201);

    // Somebody else holds the turn-keeper for longer than a submission is willing to wait.
    const holder = await superuser.connect();
    await holder.query('begin');
    await holder.query(
      `select 1 from lead_assignment_pointers where tenant_id = $1 and rule_id = $2 for update`,
      [tenantId, rule.id],
    );
    try {
      const started = Date.now();
      const stuck = await submit(form);
      expect(stuck.status).toBe(201);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
      // The form's maker, by the fallback.
      expect(await ownerOf(stuck.email)).toBe(owner.userId);
    } finally {
      await holder.query('rollback');
      holder.release();
    }

    const failure = await superuser.query(
      `select count(*)::int as n from audit_logs where tenant_id = $1 and object_type = 'lead_form' and changes::text like '%rules failed%'`,
      [tenantId],
    );
    expect((failure.rows[0] as { n: number }).n).toBe(1);
  }, 60_000);

  it('leaves the lead with nobody, and says so, when nobody at all can take it', async () => {
    await clearRules();
    const form = await makeForm();
    const everyone = [owner, ...admins];
    for (const person of everyone)
      await harness.fixtures.setMembershipStatus(tenantId, person.userId, 'suspended');
    try {
      const sent = await submit(form);
      expect(sent.status).toBe(201);
      expect(await ownerOf(sent.email)).toBeNull();
    } finally {
      for (const person of everyone)
        await harness.fixtures.setMembershipStatus(tenantId, person.userId, 'active');
    }
  });
});
