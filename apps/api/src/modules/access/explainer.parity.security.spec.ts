import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * The explainer against reality (ADR-0031).
 *
 * The explainer is only worth having if it is right, and "right" has one
 * definition: it says what the API does. So this suite does **not** assert the
 * explainer against a hand-written table of expected answers — that would test
 * the explainer against what its author believed, which is exactly the
 * belief that might be wrong. For every record and every member it asks the
 * explainer what it claims and then **asks the real HTTP API the same question
 * as that member**, with that member's own session, and compares:
 *
 *   - the explainer says they can open the record  ⇔  `GET /<objects>/:id` is 200
 *     (and 404 otherwise — never 403, which would confirm the id exists);
 *   - the set of records it says they can see      ⇔  the ids their list endpoint pages through;
 *   - a field it says is hidden from them           ⇔  absent from the body they receive;
 *   - the number of records it says they can read   ⇔  the length of that list.
 *
 * The data is built to include every shape the matcher distinguishes: records
 * they own, a teammate's, a stranger's, an unowned one, one owned by somebody
 * in *two* teams, one owned by a suspended member, a role that reads everything
 * but hides a field, and a role with no grant on the object at all.
 *
 * Team scope is in here for a reason: before ADR-0031 the record endpoints
 * ignored it, so a teammate's record was in the list and a 404 when opened.
 * This is the test that would have said so.
 */
let harness: ApiHarness;
let tenantId: string;

interface Member {
  readonly name: string;
  readonly userId: string;
  readonly token: string;
}

const members: Record<string, Member> = {};
let adminToken: string;

const OBJECTS = ['contact', 'account', 'lead', 'deal', 'activity'] as const;
type ObjectKey = (typeof OBJECTS)[number];

const PATH: Record<ObjectKey, string> = {
  contact: 'contacts',
  account: 'accounts',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

/** record id → owner label, per object. */
const records: Record<ObjectKey, { id: string; owner: string }[]> = {
  contact: [],
  account: [],
  lead: [],
  deal: [],
  activity: [],
};

let otherTenantRecordId: string;
let otherTenantUserId: string;

function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

async function member(name: string, roleId: string, teams: string[] = []): Promise<Member> {
  const created = await harness.fixtures.createUser(tenantId, roleId, {
    name,
    email: `${name.toLowerCase().replace(/\W+/g, '-')}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  });
  void teams;
  const token = await harness.signIn(created.userId, tenantId);
  const made = { name, userId: created.userId, token };
  members[name] = made;
  return made;
}

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  const seeded = await harness.fixtures.createTenant({ name: 'Parity Traders' });
  tenantId = seeded.tenantId;
  const roles = await harness.provision(tenantId);

  // Custom roles that exercise the corners.
  const noPhone = await harness.fixtures.createRole(tenantId, 'Reads all, no phone');
  const dealsOnly = await harness.fixtures.createRole(tenantId, 'Deals only');
  const teamReader = await harness.fixtures.createRole(tenantId, 'Team reader');
  for (const object of OBJECTS) {
    await harness.fixtures.grant(tenantId, noPhone, object, 'read', 'all');
    await harness.fixtures.grant(tenantId, teamReader, object, 'read', 'team');
  }
  await harness.fixtures.setFieldPermission(tenantId, noPhone, 'contact', 'phone', 'hidden');
  await harness.fixtures.setFieldPermission(tenantId, noPhone, 'account', 'phone', 'hidden');
  await harness.fixtures.setFieldPermission(tenantId, teamReader, 'contact', 'email', 'hidden');
  await harness.fixtures.grant(tenantId, dealsOnly, 'deal', 'read', 'all');

  const admin = await member('Admin Anita', roles.get('Admin')!);
  adminToken = admin.token;
  await member('Manager Rahul', roles.get('Manager')!);
  await member('Manager Meera', roles.get('Manager')!);
  await member('Rep Priya', roles.get('Sales Rep')!);
  await member('Rep Bhavin', roles.get('Sales Rep')!);
  await member('Reader Rohan', roles.get('Read-only')!);
  await member('No Phone Nisha', noPhone);
  await member('Deals Only Dev', dealsOnly);
  await member('Team Reader Tara', teamReader);
  const suspended = await member('Suspended Sam', roles.get('Sales Rep')!);
  await harness.fixtures.setMembershipStatus(tenantId, suspended.userId, 'suspended');

  // Teams: Rahul + Priya + Tara share T1; Meera + Bhavin + Tara share T2.
  // Tara is in two, so a record owned by her is "in" both teams.
  await harness.fixtures.createTeam(tenantId, 'North', [
    members['Manager Rahul']!.userId,
    members['Rep Priya']!.userId,
    members['Team Reader Tara']!.userId,
  ]);
  await harness.fixtures.createTeam(tenantId, 'South', [
    members['Manager Meera']!.userId,
    members['Rep Bhavin']!.userId,
    members['Team Reader Tara']!.userId,
  ]);

  const owners: [string, string | null][] = [
    ['Rep Priya', members['Rep Priya']!.userId],
    ['Rep Bhavin', members['Rep Bhavin']!.userId],
    ['Manager Rahul', members['Manager Rahul']!.userId],
    ['Manager Meera', members['Manager Meera']!.userId],
    ['Admin Anita', members['Admin Anita']!.userId],
    ['Team Reader Tara', members['Team Reader Tara']!.userId],
    ['Suspended Sam', suspended.userId],
    ['nobody', null],
  ];

  const [pipeline] = await harness.fixtures.pipelinesFor(tenantId);
  const stage = pipeline!.stages.find((candidate) => candidate.stageType === 'open')!;

  for (const [label, ownerId] of owners) {
    const tag = label.replace(/\W+/g, '');
    records.contact.push({
      id: await harness.fixtures.createContact(tenantId, {
        ownerId,
        lastName: `C-${tag}`,
        email: `c-${tag}@x.io`,
        phone: '+919800000001',
      }),
      owner: label,
    });
    records.account.push({
      id: await harness.fixtures.createAccount(tenantId, {
        ownerId,
        name: `A-${tag}`,
        phone: '+919800000002',
        email: `a-${tag}@x.io`,
      }),
      owner: label,
    });
    records.lead.push({
      id: await harness.fixtures.createLead(tenantId, {
        ownerId,
        lastName: `L-${tag}`,
        email: `l-${tag}@x.io`,
        phone: '+919800000003',
      }),
      owner: label,
    });
    records.deal.push({
      id: await harness.fixtures.createDeal(tenantId, {
        pipelineId: pipeline!.id,
        stageId: stage.id,
        ownerId,
        name: `D-${tag}`,
        amountMinor: 100000n,
        currency: 'INR',
      }),
      owner: label,
    });
    records.activity.push({
      id: await harness.fixtures.createActivity(tenantId, {
        assignedTo: ownerId,
        subject: `T-${tag}`,
      }),
      owner: label,
    });
  }

  // A second workspace, with a user and a record that must never surface.
  const other = await harness.fixtures.createTenant({ name: 'Rival Traders' });
  const otherRoles = await harness.provision(other.tenantId);
  const stranger = await harness.fixtures.createUser(other.tenantId, otherRoles.get('Owner')!);
  otherTenantUserId = stranger.userId;
  otherTenantRecordId = await harness.fixtures.createContact(other.tenantId, {
    ownerId: stranger.userId,
    lastName: 'Rival',
  });
}, 240_000);

afterAll(async () => {
  await harness.close();
});

interface Explained {
  allowed: boolean;
  name: string;
  userId: string;
  basis: string;
  hiddenFields: string[];
  readOnlyFields: string[];
}

async function explain(object: ObjectKey, id: string) {
  const response = await request(harness, {
    method: 'GET',
    url: `/api/v1/access/records/${object}/${id}`,
    token: adminToken,
  });
  expect(response.status).toBe(200);
  const data = response.body['data'] as {
    people: Explained[];
    fields: { key: string; label: string }[];
    truncated: boolean;
  };
  return data;
}

async function open(object: ObjectKey, id: string, token: string) {
  return request(harness, { method: 'GET', url: `/api/v1/${PATH[object]}/${id}`, token });
}

describe.each(OBJECTS)('the explainer agrees with the API: %s', (object) => {
  it('says a member can open a record exactly when the record endpoint returns it', async () => {
    const disagreements: string[] = [];
    let checked = 0;

    for (const record of records[object]) {
      const explained = await explain(object, record.id);
      const byUser = new Map(explained.people.map((person) => [person.userId, person]));

      for (const person of Object.values(members)) {
        const claim = byUser.get(person.userId);
        if (person.name === 'Suspended Sam') {
          // Suspended members cannot act, so the explainer must not list them…
          expect(claim, 'a suspended member must not be listed').toBeUndefined();
          // …and the API must refuse them.
          expect((await open(object, record.id, person.token)).status).toBeGreaterThanOrEqual(401);
          continue;
        }
        expect(claim, `${person.name} missing from the explanation`).toBeDefined();

        const real = await open(object, record.id, person.token);
        checked += 1;

        const says = claim!.allowed;
        const did = real.status === 200;
        if (says !== did) {
          disagreements.push(
            `${object} owned by ${record.owner}, as ${person.name}: explainer says ` +
              `${says ? 'can' : 'cannot'} (${claim!.basis}), API returned ${real.status}`,
          );
        }
        // A refusal on a record is a 404 whenever the member has *any* reach to
        // the object — a 403 would confirm the id exists (CLAUDE.md §5.5).
        if (!did && claim!.basis !== 'no_grant') {
          expect(real.status, `${person.name} / ${record.owner}`).toBe(404);
        }
      }
    }

    expect(disagreements, disagreements.join('\n')).toEqual([]);
    expect(checked).toBeGreaterThan(40);
  });

  it('says a member sees a set of records exactly when their list returns that set', async () => {
    const claimed = new Map<string, Set<string>>();
    for (const record of records[object]) {
      const explained = await explain(object, record.id);
      for (const person of explained.people) {
        const set = claimed.get(person.userId) ?? new Set<string>();
        if (person.allowed) set.add(record.id);
        claimed.set(person.userId, set);
      }
    }

    for (const person of Object.values(members)) {
      if (person.name === 'Suspended Sam') continue;
      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/${PATH[object]}?limit=100`,
        token: person.token,
      });

      const expected = [...(claimed.get(person.userId) ?? new Set<string>())].sort();
      if (response.status === 403) {
        // No grant on the object: the list is refused, and the explainer must
        // have said nobody-record for them.
        expect(expected, `${person.name} is refused the list`).toEqual([]);
        continue;
      }
      expect(response.status, person.name).toBe(200);
      const ids = (response.body['data'] as { id: string }[])
        .map((row) => row.id)
        .filter((id) => records[object].some((record) => record.id === id))
        .sort();
      expect(ids, `${person.name} / ${object} list`).toEqual(expected);
    }
  });

  it('says a field is hidden from a member exactly when it is missing from what they receive', async () => {
    const reference = records[object][0]!;
    const adminBody = (await open(object, reference.id, adminToken)).body['data'] as Record<
      string,
      unknown
    >;
    const explainedFields = (await explain(object, reference.id)).fields;
    const surfaced = explainedFields.filter((field) => camel(field.key) in adminBody);
    expect(surfaced.length, 'the admin should see some fields to compare against').toBeGreaterThan(2);

    const disagreements: string[] = [];
    for (const record of records[object]) {
      const explained = await explain(object, record.id);
      for (const claim of explained.people) {
        if (!claim.allowed) continue;
        const person = members[claim.name]!;
        const real = await open(object, record.id, person.token);
        if (real.status !== 200) continue; // covered by the first test
        const body = real.body['data'] as Record<string, unknown>;

        for (const field of surfaced) {
          const present = camel(field.key) in body;
          const hidden = claim.hiddenFields.includes(field.key);
          if (present === hidden) {
            disagreements.push(
              `${object}.${field.key} as ${claim.name}: explainer says ` +
                `${hidden ? 'hidden' : 'visible'}, response ${present ? 'has' : 'lacks'} it`,
            );
          }
        }
      }
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);
  });
});

describe('what a member can reach agrees with the API', () => {
  it('reports the number of records `read` reaches as the length of their list', async () => {
    for (const person of Object.values(members)) {
      if (person.name === 'Suspended Sam') continue;

      const response = await request(harness, {
        method: 'GET',
        url: `/api/v1/access/members/${person.userId}`,
        token: adminToken,
      });
      expect(response.status, person.name).toBe(200);
      const reach = response.body['data'] as {
        objects: {
          objectType: string;
          kind: string;
          readableRecords: number | null;
          actions: { action: string; allowed: boolean; scope: string | null }[];
        }[];
      };

      for (const object of OBJECTS) {
        const entry = reach.objects.find((candidate) => candidate.objectType === object)!;
        const read = entry.actions.find((action) => action.action === 'read')!;

        const list = await request(harness, {
          method: 'GET',
          url: `/api/v1/${PATH[object]}?limit=100`,
          token: person.token,
        });

        if (!read.allowed) {
          expect(list.status, `${person.name} / ${object}`).toBe(403);
          expect(entry.readableRecords).toBeNull();
          continue;
        }
        expect(list.status, `${person.name} / ${object}`).toBe(200);
        expect(entry.readableRecords, `${person.name} / ${object}`).toBe(
          (list.body['data'] as unknown[]).length,
        );
      }
    }
  });

  it('reports whether a member may create as the API treats an actual create', async () => {
    // Create is the action with the plainest observable refusal: a valid body
    // is either accepted (201) or refused by `can()` (403).
    let created = 0;
    for (const person of Object.values(members)) {
      if (person.name === 'Suspended Sam') continue;
      const reach = (
        await request(harness, {
          method: 'GET',
          url: `/api/v1/access/members/${person.userId}`,
          token: adminToken,
        })
      ).body['data'] as {
        objects: { objectType: string; actions: { action: string; allowed: boolean }[] }[];
      };

      const bodies = {
        contact: (tag: string) => ({ lastName: `Probe ${tag}` }),
        account: (tag: string) => ({ name: `Probe ${tag}` }),
        lead: (tag: string) => ({ lastName: `Probe ${tag}` }),
      } as const;

      for (const object of ['contact', 'account', 'lead'] as const) {
        const create = reach.objects
          .find((entry) => entry.objectType === object)!
          .actions.find((action) => action.action === 'create')!;
        const tag = `${person.userId.slice(-8)}-${object}-${Math.random().toString(36).slice(2, 8)}`;
        const response = await request(harness, {
          method: 'POST',
          url: `/api/v1/${PATH[object]}`,
          token: person.token,
          body: bodies[object](tag),
        });
        if (create.allowed) {
          expect(response.status, `${person.name} may create ${object}`).toBe(201);
          created += 1;
        } else {
          expect(response.status, `${person.name} may not create ${object}`).toBe(403);
        }
      }
    }
    expect(created).toBeGreaterThan(5);
  });
});

describe('the explanation contains only this workspace', () => {
  it('never names a person or a record from another workspace', async () => {
    const reference = records.contact[0]!;
    const body = JSON.stringify((await explain('contact', reference.id)).people);
    expect(body).not.toContain(otherTenantUserId);

    // Nor will it explain one of their records, or confirm it exists.
    const foreign = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/records/contact/${otherTenantRecordId}`,
      token: adminToken,
    });
    expect(foreign.status).toBe(404);

    const foreignPerson = await request(harness, {
      method: 'GET',
      url: `/api/v1/access/members/${otherTenantUserId}`,
      token: adminToken,
    });
    expect(foreignPerson.status).toBe(404);
  });

  it('lists every active member exactly once, and nobody else', async () => {
    const explained = await explain('contact', records.contact[0]!.id);
    const ids = explained.people.map((person) => person.userId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      Object.values(members)
        .filter((person) => person.name !== 'Suspended Sam')
        .map((person) => person.userId)
        .sort(),
    );
    expect(explained.truncated).toBe(false);
  });
});
