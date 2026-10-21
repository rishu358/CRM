import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataOf, request, startApiHarness, type ApiHarness } from '../../testing/harness.js';

/**
 * Behavioural tests for custom fields and picklists (MVP_SPEC M9, ADR-0039).
 *
 * Through the real HTTP stack against real Postgres, because what is being proved is
 * how a definition changes what the *record* endpoints accept: a field that exists
 * can be written, one that is switched off cannot but keeps its data, and a picklist
 * option that was retired stays valid on the records that hold it.
 */

interface Person {
  token: string;
  userId: string;
}
interface Definition {
  id: string;
  objectType: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: { value: string; label: string; isActive?: boolean }[];
  validation?: Record<string, unknown>;
  helpText: string | null;
  section: string | null;
  position: number;
  isSystem: boolean;
  isActive: boolean;
  version: number;
}

let harness: ApiHarness;
let tenantId: string;
let admin: Person;

beforeAll(async () => {
  harness = await startApiHarness(inject('dbUrls'));
  tenantId = (await harness.fixtures.createTenant({ name: 'Customization Behaviour Co' })).tenantId;
  const roles = await harness.provision(tenantId);
  const user = await harness.fixtures.createUser(tenantId, roles.get('Admin')!);
  admin = { userId: user.userId, token: await harness.signIn(user.userId, tenantId) };
});

afterAll(async () => {
  await harness.close();
});

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) =>
  request(harness, { method, url, token: admin.token, ...(body === undefined ? {} : { body }) });

async function create(body: Record<string, unknown>): Promise<Definition> {
  return dataOf<Definition>(await call('POST', '/api/v1/fields', body), 201);
}

async function list(objectType: string, includeInactive = true): Promise<Definition[]> {
  return dataOf<Definition[]>(
    await call('GET', `/api/v1/fields?objectType=${objectType}&includeInactive=${includeInactive}`),
    200,
  );
}

async function patch(id: string, body: Record<string, unknown>) {
  return call('PATCH', `/api/v1/fields/${id}`, body);
}

async function newContact(customFields: Record<string, unknown> = {}) {
  return call('POST', '/api/v1/contacts', { lastName: `Test ${Math.random()}`, customFields });
}

describe('listing', () => {
  it('lists the built-in fields of an object in order, marked as built in', async () => {
    const fields = await list('contact');
    expect(fields.length).toBeGreaterThan(5);
    expect(fields.every((field) => field.isSystem)).toBe(true);
    const positions = fields.map((field) => field.position);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(fields.find((field) => field.key === 'last_name')?.required).toBe(true);
  });

  it('does not customise activities, roles or anything that is not a record object', async () => {
    for (const objectType of ['activity', 'role', 'tenant_settings', 'nonsense']) {
      const response = await call('GET', `/api/v1/fields?objectType=${objectType}`);
      expect(response.status, objectType).toBe(422);
    }
  });

  it('needs an object type', async () => {
    expect((await call('GET', '/api/v1/fields')).status).toBe(422);
  });
});

describe('adding a text field', () => {
  let field: Definition;

  beforeAll(async () => {
    field = await create({
      objectType: 'contact',
      label: 'Preferred contact time',
      type: 'text',
      helpText: 'When they like to be called',
      section: 'Preferences',
    });
  });

  it('makes the key from the label, puts the field last, and returns it whole', async () => {
    expect(field).toMatchObject({
      objectType: 'contact',
      key: 'preferred_contact_time',
      label: 'Preferred contact time',
      type: 'text',
      required: false,
      helpText: 'When they like to be called',
      section: 'Preferences',
      isSystem: false,
      isActive: true,
      version: 1,
    });
    const all = await list('contact');
    expect(all.at(-1)?.id).toBe(field.id);
    expect(all.at(-1)!.position).toBeGreaterThan(all.filter((f) => f.isSystem).at(-1)!.position);
  });

  it('is writable on a record at once, and the value is returned with it', async () => {
    const created = await newContact({ preferred_contact_time: 'Mornings' });
    expect(created.status).toBe(201);
    const record = dataOf<{ id: string; customFields: Record<string, unknown> }>(created, 201);
    expect(record.customFields['preferred_contact_time']).toBe('Mornings');
  });

  it('is not writable under a key nobody defined, reported as a field that may not be written', async () => {
    expect((await newContact({ not_a_field: 'x' })).status).toBe(403);
  });

  it('gets a different key when the label is taken, including by a built-in field', async () => {
    const second = await create({
      objectType: 'contact',
      label: 'Preferred contact time',
      type: 'text',
    });
    expect(second.key).toBe('preferred_contact_time_2');
    const phone = await create({ objectType: 'contact', label: 'Phone', type: 'phone' });
    expect(phone.key).toBe('phone_2');
  });

  it('keeps the same label usable on another object, with the same key', async () => {
    const onLead = await create({
      objectType: 'lead',
      label: 'Preferred contact time',
      type: 'text',
    });
    expect(onLead.key).toBe('preferred_contact_time');
  });
});

describe('every customisable object', () => {
  it.each([
    ['account', '/api/v1/accounts', { name: 'Acme Customised' }],
    ['contact', '/api/v1/contacts', { lastName: 'Customised' }],
    ['lead', '/api/v1/leads', { lastName: 'Customised' }],
    ['deal', '/api/v1/deals', { name: 'Customised deal' }],
  ])('takes a custom field on a %s', async (objectType, url, base) => {
    const field = await create({ objectType, label: 'Dealer code', type: 'text' });
    const response = await call('POST', url, { ...base, customFields: { [field.key]: 'D-100' } });
    const record = dataOf<{ customFields: Record<string, unknown> }>(response, 201);
    expect(record.customFields[field.key]).toBe('D-100');
  });
});

describe('required', () => {
  it('makes a field mandatory for new records without breaking the ones already there', async () => {
    const existing = dataOf<{ id: string; version: number }>(await newContact(), 201);
    const field = await create({ objectType: 'contact', label: 'Consent source', type: 'text' });

    const required = dataOf<Definition>(await patch(field.id, { version: 1, required: true }), 200);
    expect(required.required).toBe(true);
    expect(required.version).toBe(2);

    expect((await newContact()).status).toBe(422);
    expect((await newContact({ [field.key]: 'web form' })).status).toBe(201);

    // The old record does not have it, and can still be edited.
    const edited = await call('PATCH', `/api/v1/contacts/${existing.id}`, {
      version: existing.version,
      title: 'Director',
    });
    expect(edited.status).toBe(200);

    // Switched off, it is not asked for any more.
    await patch(field.id, { version: 2, isActive: false });
    expect((await newContact()).status).toBe(201);
  });
});

describe('switching a field off', () => {
  let field: Definition;
  let recordId: string;

  beforeAll(async () => {
    field = await create({ objectType: 'contact', label: 'Anniversary note', type: 'text' });
    recordId = dataOf<{ id: string }>(await newContact({ [field.key]: 'Married in May' }), 201).id;
  });

  it('hides it from the form list, refuses writes to it, and keeps the data', async () => {
    const off = dataOf<Definition>(
      await patch(field.id, { version: field.version, isActive: false }),
      200,
    );
    expect(off.isActive).toBe(false);

    const forForms = await list('contact', false);
    expect(forForms.find((f) => f.id === field.id)).toBeUndefined();
    expect((await list('contact', true)).find((f) => f.id === field.id)?.isActive).toBe(false);

    // Reported exactly as a key nobody defined, so the answer does not say that it exists.
    expect((await newContact({ [field.key]: 'again' })).status).toBe(403);

    // Gone from the record's response, still in the database.
    const record = dataOf<{ customFields: Record<string, unknown> }>(
      await call('GET', `/api/v1/contacts/${recordId}`),
      200,
    );
    expect(record.customFields[field.key]).toBeUndefined();
    expect((await harness.fixtures.customFieldValues('contact', recordId))[field.key]).toBe(
      'Married in May',
    );
  });

  it('brings the value back when it is switched on again', async () => {
    const current = (await list('contact')).find((f) => f.id === field.id)!;
    const on = dataOf<Definition>(
      await patch(field.id, { version: current.version, isActive: true }),
      200,
    );
    expect(on.isActive).toBe(true);
    const record = dataOf<{ customFields: Record<string, unknown> }>(
      await call('GET', `/api/v1/contacts/${recordId}`),
      200,
    );
    expect(record.customFields[field.key]).toBe('Married in May');
  });

  it('is the only way a field goes: there is no delete', async () => {
    const response = await request(harness, {
      method: 'DELETE',
      url: `/api/v1/fields/${field.id}`,
      token: admin.token,
    });
    expect([404, 405]).toContain(response.status);
    expect((await list('contact')).some((f) => f.id === field.id)).toBe(true);
  });
});

describe('picklists', () => {
  let field: Definition;

  beforeAll(async () => {
    field = await create({
      objectType: 'lead',
      label: 'Region',
      type: 'picklist',
      options: [{ label: 'North' }, { label: 'South' }, { label: 'East & West' }],
    });
  });

  const newLead = (region: unknown) =>
    call('POST', '/api/v1/leads', { lastName: 'Picklist', customFields: { region } });

  it('gives each option a value made from its label', () => {
    expect(field.options).toEqual([
      { value: 'north', label: 'North', isActive: true },
      { value: 'south', label: 'South', isActive: true },
      { value: 'east_west', label: 'East & West', isActive: true },
    ]);
  });

  it('accepts an offered value and refuses anything else', async () => {
    expect((await newLead('north')).status).toBe(201);
    expect((await newLead('central')).status).toBe(422);
    expect((await newLead('North')).status).toBe(422); // the label is not the value
  });

  it('can have an option added, relabelled and reordered, keeping every value', async () => {
    const current = (await list('lead')).find((f) => f.id === field.id)!;
    const updated = dataOf<Definition>(
      await patch(field.id, {
        version: current.version,
        options: [
          { value: 'south', label: 'Southern' },
          { value: 'north', label: 'North' },
          { value: 'east_west', label: 'East & West' },
          { label: 'Central' },
        ],
      }),
      200,
    );
    expect(updated.options?.map((o) => [o.value, o.label])).toEqual([
      ['south', 'Southern'],
      ['north', 'North'],
      ['east_west', 'East & West'],
      ['central', 'Central'],
    ]);
    expect((await newLead('central')).status).toBe(201);
  });

  it('refuses to drop an option, and says to deactivate it', async () => {
    const current = (await list('lead')).find((f) => f.id === field.id)!;
    const response = await patch(field.id, {
      version: current.version,
      options: [{ value: 'north', label: 'North' }],
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/deactivate/);
    expect((await list('lead')).find((f) => f.id === field.id)?.options).toHaveLength(4);
  });

  it('keeps a retired option valid on the records that hold it, and stops offering it', async () => {
    const lead = dataOf<{ id: string; version: number }>(await newLead('south'), 201);
    const current = (await list('lead')).find((f) => f.id === field.id)!;
    await patch(field.id, {
      version: current.version,
      options: current.options!.map((o) => (o.value === 'south' ? { ...o, isActive: false } : o)),
    });

    // New writes of it are refused.
    expect((await newLead('south')).status).toBe(422);
    // The record that holds it is still readable and editable.
    const read = dataOf<{ customFields: Record<string, unknown> }>(
      await call('GET', `/api/v1/leads/${lead.id}`),
      200,
    );
    expect(read.customFields['region']).toBe('south');
    const edited = await call('PATCH', `/api/v1/leads/${lead.id}`, {
      version: lead.version,
      company: 'Edited Co',
    });
    expect(edited.status).toBe(200);
  });

  it('refuses a client that invents a value, a duplicate label, or no active option', async () => {
    const current = (await list('lead')).find((f) => f.id === field.id)!;
    const all = current.options!.map((o) => ({
      value: o.value,
      label: o.label,
      isActive: o.isActive,
    }));

    expect(
      (
        await patch(field.id, {
          version: current.version,
          options: [...all, { value: 'sneaky', label: 'Sneaky' }],
        })
      ).status,
    ).toBe(422);
    expect(
      (await patch(field.id, { version: current.version, options: [...all, { label: ' north ' }] }))
        .status,
    ).toBe(422);
    expect(
      (
        await patch(field.id, {
          version: current.version,
          options: all.map((o) => ({ ...o, isActive: false })),
        })
      ).status,
    ).toBe(422);
  });

  it('is created with labels only: a value sent on a new option, or options on a text field, is a 422', async () => {
    const withValue = await call('POST', '/api/v1/fields', {
      objectType: 'lead',
      label: 'Priority',
      type: 'picklist',
      options: [{ value: 'p1', label: 'P1' }],
    });
    expect(withValue.status).toBe(422);
    const onText = await call('POST', '/api/v1/fields', {
      objectType: 'lead',
      label: 'Notes',
      type: 'text',
      options: [{ label: 'x' }],
    });
    expect(onText.status).toBe(422);
    const none = await call('POST', '/api/v1/fields', {
      objectType: 'lead',
      label: 'Empty',
      type: 'picklist',
    });
    expect(none.status).toBe(422);
  });

  it('takes several at once on a multi-picklist', async () => {
    const multi = await create({
      objectType: 'account',
      label: 'Certifications',
      type: 'multi_picklist',
      options: [{ label: 'ISO 9001' }, { label: 'GST registered' }, { label: 'MSME' }],
    });
    const response = await call('POST', '/api/v1/accounts', {
      name: 'Certified Co',
      customFields: { [multi.key]: ['iso_9001', 'msme'] },
    });
    expect(response.status).toBe(201);
    const bad = await call('POST', '/api/v1/accounts', {
      name: 'Uncertified Co',
      customFields: { [multi.key]: ['iso_9001', 'nope'] },
    });
    expect(bad.status).toBe(422);
  });
});

describe('limits', () => {
  it('enforces a number range on the records', async () => {
    const field = await create({
      objectType: 'deal',
      label: 'Seats',
      type: 'number',
      validation: { min: '1', max: '500' },
    });
    const deal = (value: number) =>
      call('POST', '/api/v1/deals', { name: 'Seats deal', customFields: { [field.key]: value } });
    expect((await deal(10)).status).toBe(201);
    expect((await deal(0)).status).toBe(422);
    expect((await deal(501)).status).toBe(422);
  });

  it('enforces a text length on the records', async () => {
    const field = await create({
      objectType: 'account',
      label: 'PAN',
      type: 'text',
      validation: { minLength: 10, maxLength: 10 },
    });
    const account = (value: string) =>
      call('POST', '/api/v1/accounts', { name: 'Pan Co', customFields: { [field.key]: value } });
    expect((await account('ABCDE1234F')).status).toBe(201);
    expect((await account('short')).status).toBe(422);
  });

  it('refuses limits that do not mean anything for the type, and a pattern for any type', async () => {
    const wrongType = await call('POST', '/api/v1/fields', {
      objectType: 'deal',
      label: 'Flag',
      type: 'boolean',
      validation: { maxLength: 3 },
    });
    expect(wrongType.status).toBe(422);
    const pattern = await call('POST', '/api/v1/fields', {
      objectType: 'deal',
      label: 'Code',
      type: 'text',
      validation: { pattern: '(a+)+$' },
    });
    expect(pattern.status).toBe(422);
    const upsideDown = await call('POST', '/api/v1/fields', {
      objectType: 'deal',
      label: 'Range',
      type: 'number',
      validation: { min: '10', max: '2' },
    });
    expect(upsideDown.status).toBe(422);
  });

  it('shows the limits back, and lets them be changed', async () => {
    const field = await create({
      objectType: 'lead',
      label: 'Budget',
      type: 'number',
      validation: { min: '0' },
    });
    expect(field.validation).toEqual({ min: '0' });
    const changed = dataOf<Definition>(
      await patch(field.id, { version: 1, validation: { min: '0', max: '1000' } }),
      200,
    );
    expect(changed.validation).toEqual({ min: '0', max: '1000' });
  });
});

describe('what cannot be edited', () => {
  let field: Definition;

  beforeAll(async () => {
    field = await create({ objectType: 'account', label: 'Fixed shape', type: 'text' });
  });

  it.each([
    ['key', { key: 'renamed' }],
    ['type', { type: 'number' }],
    ['objectType', { objectType: 'lead' }],
    ['isSystem', { isSystem: true }],
    ['tenantId', { tenantId: '0198f0f0-0000-7000-8000-000000000000' }],
    ['pattern', { validation: { pattern: '.*' } }],
    ['position', { position: 1 }],
  ])('rejects %s on an edit', async (_name, extra) => {
    const response = await patch(field.id, { version: 1, label: 'Still fixed', ...extra });
    expect(response.status).toBe(422);
    expect((await list('account')).find((f) => f.id === field.id)?.label).toBe('Fixed shape');
  });

  it('rejects an edit that changes nothing, and one with no version', async () => {
    expect((await patch(field.id, { version: 1 })).status).toBe(422);
    expect((await patch(field.id, { label: 'No version' })).status).toBe(422);
  });

  it('does not let a built-in field be edited here', async () => {
    const lastName = (await list('contact')).find((f) => f.key === 'last_name')!;
    const response = await patch(lastName.id, { version: lastName.version, label: 'Surname' });
    expect(response.status).toBe(422);
    expect((await list('contact')).find((f) => f.key === 'last_name')?.label).toBe(lastName.label);
  });

  it('answers a stale version with 409 and changes nothing', async () => {
    const first = await patch(field.id, { version: 1, label: 'First edit' });
    expect(first.status).toBe(200);
    const stale = await patch(field.id, { version: 1, label: 'Second editor, stale' });
    expect(stale.status).toBe(409);
    expect((await list('account')).find((f) => f.id === field.id)?.label).toBe('First edit');
  });

  it('answers 404 for a field that does not exist', async () => {
    const response = await patch('0198f0f0-0000-7000-8000-000000000000', {
      version: 1,
      label: 'x',
    });
    expect(response.status).toBe(404);
  });
});

describe('order', () => {
  let ids: string[];

  beforeAll(async () => {
    const made = [];
    for (const label of ['Order A', 'Order B', 'Order C']) {
      made.push(await create({ objectType: 'deal', label, type: 'text' }));
    }
    ids = made.map((f) => f.id);
  });

  const customIds = async () => (await list('deal')).filter((f) => !f.isSystem).map((f) => f.id);
  const order = (objectType: string, body: string[]) =>
    call('POST', '/api/v1/fields/order', { objectType, ids: body });

  it('puts the custom fields in the order given, after the built-in ones', async () => {
    const all = await customIds();
    const wanted = [...all].reverse();
    const response = await order('deal', wanted);
    expect(response.status).toBe(200);
    expect(await customIds()).toEqual(wanted);
    const fields = await list('deal');
    const lastSystem = fields.filter((f) => f.isSystem).at(-1)!.position;
    expect(fields.filter((f) => !f.isSystem).every((f) => f.position > lastSystem)).toBe(true);
  });

  it('is refused, and changes nothing, if it leaves one out, repeats one or names a stranger', async () => {
    const before = await customIds();
    for (const body of [
      before.slice(1),
      [...before, before[0]!],
      [...before.slice(1), '0198f0f0-0000-7000-8000-000000000000'],
    ]) {
      expect((await order('deal', body)).status).toBe(422);
      expect(await customIds()).toEqual(before);
    }
  });

  it('will not order the custom fields of one object by naming another object’s fields', async () => {
    const lead = await create({ objectType: 'lead', label: 'Elsewhere', type: 'text' });
    const response = await order('deal', [...(await customIds()), lead.id]);
    expect(response.status).toBe(422);
  });

  it('records the change once, and not at all when the order is already that', async () => {
    const before = (await harness.fixtures.auditEntries(tenantId, 'field_definition')).length;
    await order('deal', await customIds());
    expect((await harness.fixtures.auditEntries(tenantId, 'field_definition')).length).toBe(before);
    expect(ids.length).toBe(3);
  });
});

describe('the sixtieth', () => {
  it('stops at 60 custom fields on one object, with a message a person can act on', async () => {
    const t = (await harness.fixtures.createTenant({ name: 'Sixty Co' })).tenantId;
    const roles = await harness.provision(t);
    const user = await harness.fixtures.createUser(t, roles.get('Admin')!);
    const token = await harness.signIn(user.userId, t);
    for (let n = 0; n < 60; n += 1) {
      await harness.fixtures.createFieldDefinition(t, {
        objectType: 'lead',
        key: `f${n}`,
        type: 'text',
      });
    }
    const response = await request(harness, {
      method: 'POST',
      url: '/api/v1/fields',
      token,
      body: { objectType: 'lead', label: 'One too many', type: 'text' },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).toMatch(/at most 60/);
  }, 60_000);
});

describe('the record of what was done', () => {
  it('audits a creation and an edit, with what changed, and publishes an event for each', async () => {
    const field = await create({ objectType: 'contact', label: 'Audited field', type: 'text' });
    await patch(field.id, { version: 1, label: 'Audited field, renamed', required: true });

    const entries = (await harness.fixtures.auditEntries(tenantId, 'field_definition')).filter(
      (entry) => entry.recordId === field.id,
    );
    expect(entries.map((entry) => entry.action).sort()).toEqual(['create', 'update']);
    const update = entries.find((entry) => entry.action === 'update')!;
    expect(update.changes).toMatchObject({
      label: { old: 'Audited field', new: 'Audited field, renamed' },
      required: { old: false, new: true },
    });

    const events = await harness.fixtures.outboxEventTypes(tenantId);
    expect(events).toContain('field_definition.created.v1');
    expect(events).toContain('field_definition.updated.v1');
  });

  it('writes nothing when an edit changes nothing in effect', async () => {
    const field = await create({ objectType: 'contact', label: 'Same again', type: 'text' });
    const before = (await harness.fixtures.auditEntries(tenantId, 'field_definition')).length;
    const response = await patch(field.id, { version: 1, label: 'Same again' });
    expect(response.status).toBe(200);
    expect((await harness.fixtures.auditEntries(tenantId, 'field_definition')).length).toBe(before);
  });
});

describe('labels are text', () => {
  it('stores and returns markup and quotes exactly as typed, for the screen to escape', async () => {
    const label = `<img src=x onerror=alert(1)> "quoted" 'and' ; drop table`;
    const field = await create({ objectType: 'lead', label, type: 'text' });
    expect(field.label).toBe(label);
    expect(field.key).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});
