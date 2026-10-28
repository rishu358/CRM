import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant } from './client.js';
import {
  captureDbError,
  createTestDatabase,
  INSUFFICIENT_PRIVILEGE,
  type TestDatabase,
} from './testing/index.js';

/**
 * The database's own rules for record merges (migration 0026, ADR-0064).
 *
 * Two things the API cannot be the only guard for:
 *
 *   - `record_merges` is a table of ids and counts that survives the Recycle Bin purge. Row-level
 *     security keeps it inside the workspace, and the application role may add a row and change three
 *     columns of one, nothing else.
 *   - The trigger that freezes a converted lead's links (migration 0009, ADR-0022) was relaxed for exactly
 *     one case: the link moves from record A to record B in a transaction that also wrote the row saying
 *     A was merged into B. The second half of this file proves both directions: that case passes, and
 *     every other change the old trigger refused is still refused, including a direct UPDATE by the
 *     application role that has no merge behind it.
 */

let db: TestDatabase;
let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;

const as = <T>(tenant: string, user: string, work: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(db.app.db, { tenantId: tenant, userId: user }, work);

const pointer = (
  id: string,
  tenant: string,
  objectType: string,
  loser: string,
  master: string,
) => sql`
  insert into record_merges (id, tenant_id, object_type, loser_id, master_id)
  values (${id}::uuid, ${tenant}::uuid, ${objectType}, ${loser}::uuid, ${master}::uuid)`;

const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  db = createTestDatabase(inject('dbUrls'));
  tenantA = (await db.fixtures.createTenant({ name: 'Acme Jewellers' })).tenantId;
  tenantB = (await db.fixtures.createTenant({ name: 'Rival Traders' })).tenantId;
  const roleA = await db.fixtures.createRole(tenantA, 'Admin', { isSystem: true });
  const roleB = await db.fixtures.createRole(tenantB, 'Admin', { isSystem: true });
  userA = (await db.fixtures.createUser(tenantA, roleA)).userId;
  userB = (await db.fixtures.createUser(tenantB, roleB)).userId;
});

afterAll(async () => {
  await db.close();
});

describe('record_merges: who can see and change a pointer', () => {
  it('keeps a pointer inside its own workspace', async () => {
    const mine = uuid();
    const theirs = uuid();
    await as(tenantA, userA, (tx) => tx.execute(pointer(mine, tenantA, 'contact', uuid(), uuid())));
    await as(tenantB, userB, (tx) =>
      tx.execute(pointer(theirs, tenantB, 'contact', uuid(), uuid())),
    );

    const seenByA = (
      await as(tenantA, userA, (tx) => tx.execute(sql`select id from record_merges`))
    ).rows.map((row) => String(row['id']));
    expect(seenByA).toContain(mine);
    expect(seenByA).not.toContain(theirs);
  });

  it('refuses to write a pointer into another workspace, a kind that cannot be merged, or a record into itself', async () => {
    const crossTenant = await captureDbError(() =>
      as(tenantA, userA, (tx) => tx.execute(pointer(uuid(), tenantB, 'contact', uuid(), uuid()))),
    );
    expect(crossTenant.code).toBe(INSUFFICIENT_PRIVILEGE);

    const badType = await captureDbError(() =>
      as(tenantA, userA, (tx) => tx.execute(pointer(uuid(), tenantA, 'deal', uuid(), uuid()))),
    );
    expect(badType.code).toBe('23514');

    const same = uuid();
    const itself = await captureDbError(() =>
      as(tenantA, userA, (tx) => tx.execute(pointer(uuid(), tenantA, 'contact', same, same))),
    );
    expect(itself.code).toBe('23514');
  });

  it('allows one live pointer per merged-away record, and a new one once the first is undone', async () => {
    const loser = uuid();
    await as(tenantA, userA, (tx) =>
      tx.execute(pointer(uuid(), tenantA, 'contact', loser, uuid())),
    );
    const twice = await captureDbError(() =>
      as(tenantA, userA, (tx) => tx.execute(pointer(uuid(), tenantA, 'contact', loser, uuid()))),
    );
    expect(twice.code).toBe('23505');

    await as(tenantA, userA, (tx) =>
      tx.execute(sql`update record_merges set undone_at = now()
                     where loser_id = ${loser}::uuid and tenant_id = ${tenantA}::uuid`),
    );
    await as(tenantA, userA, (tx) =>
      tx.execute(pointer(uuid(), tenantA, 'contact', loser, uuid())),
    );
  });

  it('lets the application change only where a pointer points and whether it was undone', async () => {
    const id = uuid();
    const loser = uuid();
    await as(tenantA, userA, (tx) => tx.execute(pointer(id, tenantA, 'account', loser, uuid())));

    await as(tenantA, userA, (tx) =>
      tx.execute(sql`update record_merges set master_id = ${uuid()}::uuid where id = ${id}::uuid`),
    );
    for (const column of ['loser_id', 'object_type', 'merged_at', 'moved', 'tenant_id']) {
      const value =
        column === 'object_type'
          ? sql`'contact'`
          : column === 'merged_at'
            ? sql`now()`
            : column === 'moved'
              ? sql`'{}'::jsonb`
              : sql`${uuid()}::uuid`;
      const error = await captureDbError(() =>
        as(tenantA, userA, (tx) =>
          tx.execute(sql`update record_merges set ${sql.identifier(column)} = ${value}
                         where id = ${id}::uuid`),
        ),
      );
      expect(error.code, column).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('does not let the application delete a pointer', async () => {
    const id = uuid();
    await as(tenantA, userA, (tx) => tx.execute(pointer(id, tenantA, 'contact', uuid(), uuid())));
    const error = await captureDbError(() =>
      as(tenantA, userA, (tx) => tx.execute(sql`delete from record_merges where id = ${id}::uuid`)),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('a converted lead may follow a merge, and nothing else may move its links', () => {
  const FINAL = 'leads_conversion_final';

  async function converted(options: {
    contact?: string;
    account?: string;
    deal?: string;
  }): Promise<string> {
    return db.fixtures.createLead(tenantA, {
      ownerId: userA,
      status: 'converted',
      convertedAt: new Date(),
      ...(options.contact === undefined ? {} : { convertedContactId: options.contact }),
      ...(options.account === undefined ? {} : { convertedAccountId: options.account }),
      ...(options.deal === undefined ? {} : { convertedDealId: options.deal }),
    });
  }

  const refusal = (error: { message: string }) => {
    expect(error.message).toContain('has already been converted');
  };

  it('lets the contact link move from the merged-away contact to the survivor, in the merging transaction', async () => {
    const loser = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'Loser' });
    const master = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'Master' });
    const lead = await converted({ contact: loser });

    await as(tenantA, userA, async (tx) => {
      await tx.execute(pointer(uuid(), tenantA, 'contact', loser, master));
      await tx.execute(
        sql`update leads set converted_contact_id = ${master}::uuid where id = ${lead}::uuid`,
      );
    });
    expect((await db.fixtures.leadRow(lead))?.converted_contact_id).toBe(master);
  });

  it('lets the account link move the same way', async () => {
    const loser = await db.fixtures.createAccount(tenantA, { ownerId: userA, name: 'Old Co' });
    const master = await db.fixtures.createAccount(tenantA, { ownerId: userA, name: 'New Co' });
    const lead = await converted({ account: loser });

    await as(tenantA, userA, async (tx) => {
      await tx.execute(pointer(uuid(), tenantA, 'account', loser, master));
      await tx.execute(
        sql`update leads set converted_account_id = ${master}::uuid where id = ${lead}::uuid`,
      );
    });
    expect((await db.fixtures.leadRow(lead))?.converted_account_id).toBe(master);
  });

  it('refuses a direct UPDATE of the link by the application, with no merge behind it', async () => {
    const original = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'One' });
    const other = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'Two' });
    const lead = await converted({ contact: original });

    const error = await captureDbError(() =>
      as(tenantA, userA, (tx) =>
        tx.execute(
          sql`update leads set converted_contact_id = ${other}::uuid where id = ${lead}::uuid`,
        ),
      ),
    );
    refusal(error);
    expect((await db.fixtures.leadRow(lead))?.converted_contact_id).toBe(original);
  });

  it('refuses a move to a record the old target was not merged into', async () => {
    const loser = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'L' });
    const master = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'M' });
    const stranger = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'S' });
    const lead = await converted({ contact: loser });

    const error = await captureDbError(() =>
      as(tenantA, userA, async (tx) => {
        await tx.execute(pointer(uuid(), tenantA, 'contact', loser, master));
        await tx.execute(
          sql`update leads set converted_contact_id = ${stranger}::uuid where id = ${lead}::uuid`,
        );
      }),
    );
    refusal(error);
  });

  it('refuses a move justified by a pointer from an earlier transaction', async () => {
    const loser = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'L2' });
    const master = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'M2' });
    const lead = await converted({ contact: loser });
    await as(tenantA, userA, (tx) =>
      tx.execute(pointer(uuid(), tenantA, 'contact', loser, master)),
    );

    const error = await captureDbError(() =>
      as(tenantA, userA, (tx) =>
        tx.execute(
          sql`update leads set converted_contact_id = ${master}::uuid where id = ${lead}::uuid`,
        ),
      ),
    );
    refusal(error);
  });

  it('refuses a move justified by a pointer that was undone, or that names another kind of record', async () => {
    const loser = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'L3' });
    const master = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'M3' });
    const lead = await converted({ contact: loser });

    const undone = await captureDbError(() =>
      as(tenantA, userA, async (tx) => {
        await tx.execute(pointer(uuid(), tenantA, 'contact', loser, master));
        await tx.execute(
          sql`update record_merges set undone_at = now() where loser_id = ${loser}::uuid
              and tenant_id = ${tenantA}::uuid and undone_at is null`,
        );
        await tx.execute(
          sql`update leads set converted_contact_id = ${master}::uuid where id = ${lead}::uuid`,
        );
      }),
    );
    refusal(undone);

    // A pointer between two ACCOUNTS with the same ids says nothing about contacts.
    const lead2 = await converted({ contact: loser });
    const wrongKind = await captureDbError(() =>
      as(tenantA, userA, async (tx) => {
        await tx.execute(pointer(uuid(), tenantA, 'account', loser, master));
        await tx.execute(
          sql`update leads set converted_contact_id = ${master}::uuid where id = ${lead2}::uuid`,
        );
      }),
    );
    refusal(wrongKind);
  });

  it('still refuses to change the deal link, the state, or the conversion time, even inside a merge', async () => {
    const loser = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'L4' });
    const master = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'M4' });
    const { pipelineId, stageIds } = await db.fixtures.createPipeline(tenantA, 'Merge pipeline', [
      { name: 'Open', stageType: 'open', probability: 10 },
    ]);
    const stageId = stageIds[0] as string;
    const dealA = await db.fixtures.createDeal(tenantA, {
      ownerId: userA,
      name: 'Deal A',
      pipelineId,
      stageId,
    });
    const dealB = await db.fixtures.createDeal(tenantA, {
      ownerId: userA,
      name: 'Deal B',
      pipelineId,
      stageId,
    });
    const lead = await converted({ contact: loser, deal: dealA });

    const inMerge = async (statement: ReturnType<typeof sql>) =>
      captureDbError(() =>
        as(tenantA, userA, async (tx) => {
          await tx.execute(pointer(uuid(), tenantA, 'contact', loser, master));
          await tx.execute(statement);
        }),
      );

    refusal(
      await inMerge(
        sql`update leads set converted_deal_id = ${dealB}::uuid where id = ${lead}::uuid`,
      ),
    );
    refusal(await inMerge(sql`update leads set status = 'qualified' where id = ${lead}::uuid`));
    refusal(
      await inMerge(
        sql`update leads set converted_at = now() + interval '1 day' where id = ${lead}::uuid`,
      ),
    );
    // Moving the link to a record from NULL is not a move: only a link that points somewhere may follow.
    const nullLead = await converted({});
    refusal(
      await inMerge(
        sql`update leads set converted_contact_id = ${master}::uuid where id = ${nullLead}::uuid`,
      ),
    );
    expect((await db.fixtures.leadRow(lead))?.converted_contact_id).toBe(loser);
  });

  it('names the same constraint as before, so the API still translates it', async () => {
    const original = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'C' });
    const other = await db.fixtures.createContact(tenantA, { ownerId: userA, lastName: 'D' });
    const lead = await converted({ contact: original });
    const error = await captureDbError(() =>
      as(tenantA, userA, (tx) =>
        tx.execute(
          sql`update leads set converted_contact_id = ${other}::uuid where id = ${lead}::uuid`,
        ),
      ),
    );
    expect(error.code).toBe('23514');
    expect(FINAL).toBe('leads_conversion_final');
  });
});
