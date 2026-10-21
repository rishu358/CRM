import { newId } from '@crm/core';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { auditLogs, outboxEvents } from '../schema/index.js';
import { descriptorFor, hardDelete, removeReferences } from '../recycle-bin/index.js';
import { lockSampleData, type SampleCounts } from './sample-data.js';

/**
 * Removing sample data (MVP_SPEC M2, ADR-0037).
 *
 * "Remove sample data deletes only seeded records." The registry says what was
 * seeded; this decides which of those the company has since made its own.
 *
 * ## The rule
 *
 * A sample record is **kept** when anyone has built on it, and is deleted when
 * nobody has:
 *
 *   1. it was edited (its `version` moved on from 1); or
 *   2. something that is **not** sample data refers to it — a deal, contact,
 *      account or lead somebody created, or a note, task, tag or file somebody
 *      attached; or
 *   3. a record that is being kept refers to it. A kept deal keeps its account
 *      and its contacts, and a kept contact keeps its account, because
 *      otherwise deleting them would hollow out something the company owns.
 *
 * The third rule is what makes this a closure and not a filter, and it repeats
 * until nothing more is added.
 *
 * ## Why the graph has to be complete
 *
 * Almost every reference to these tables is `ON DELETE SET NULL` (an account
 * deleted under a deal leaves the deal with no account) or `CASCADE` (a contact
 * deleted from under a deal takes its link row), and the polymorphic ones —
 * activity links, tags, attachments — have no foreign key at all (ADR-0005). So a
 * reference this function failed to notice would not make the delete fail, which
 * would be loud and safe. It would quietly null a column or drop a link on
 * something the user owns. Every edge is therefore named below and has a test.
 *
 * A record the user already deleted is in the Recycle Bin, which owns it from
 * there. It is left alone, released from the registry, and — because it can be
 * restored — treated like a kept record when deciding what it holds on to.
 *
 * ## Why this runs in the worker
 *
 * The cleanup removes search and timeline rows as well as the records, and the
 * application's database role is deliberately unable to write those. It is the
 * same code the Recycle Bin's retention sweep runs, shared from this package.
 */

type Kind = 'account' | 'contact' | 'lead' | 'deal' | 'activity';

const KINDS: readonly Kind[] = ['account', 'contact', 'lead', 'deal', 'activity'];

/** Children before the things they point at, so no delete runs into a parent. */
const DELETE_ORDER: readonly Kind[] = ['activity', 'deal', 'lead', 'contact', 'account'];

/**
 * Closed, and never built from input: table names come from this map keyed by a
 * `Kind`, and are passed through `sql.identifier` (CLAUDE.md section 5.7).
 */
const TABLE: Readonly<Record<Kind, string>> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

function emptyCounts(): { -readonly [K in keyof SampleCounts]: number } {
  return { accounts: 0, contacts: 0, leads: 0, deals: 0, activities: 0 };
}

const COUNT_KEY: Readonly<Record<Kind, keyof SampleCounts>> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
  activity: 'activities',
};

export interface SampleRemovalContext {
  readonly tenantId: string;
  /** Who asked, recorded on every audit row this writes. */
  readonly actorId: string | null;
}

export interface SampleRemovalResult {
  readonly removed: SampleCounts;
  readonly kept: SampleCounts;
}

function uuidList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** One reference: `from` holds on to `to`. */
interface Reference {
  readonly from: string;
  /** False for a row that is not itself a record we know about: a tag, a file. */
  readonly fromIsSample: boolean;
  readonly to: string;
}

export async function removeSampleData(
  tx: Tx,
  ctx: SampleRemovalContext,
): Promise<SampleRemovalResult> {
  const { tenantId, actorId } = ctx;
  await lockSampleData(tx, tenantId);

  // ---- 1. what is registered ------------------------------------------------
  const registered = (
    await tx.execute(
      sql`select object_type, record_id::text as record_id
          from sample_records where tenant_id = ${tenantId}::uuid`,
    )
  ).rows as unknown as { object_type: Kind; record_id: string }[];

  if (registered.length === 0) return { removed: emptyCounts(), kept: emptyCounts() };

  const idsByKind = new Map<Kind, string[]>(KINDS.map((kind) => [kind, []]));
  for (const row of registered) idsByKind.get(row.object_type)?.push(row.record_id);
  const sampleKeys = new Set(registered.map((row) => keyOf(row.object_type, row.record_id)));
  const allIds = registered.map((row) => row.record_id);

  // ---- 2. what became of each ----------------------------------------------
  const live = new Set<string>(); // exists, not in the Bin
  const kept = new Set<string>(); // edited, or in the Bin (it holds on to things)
  for (const kind of KINDS) {
    const ids = idsByKind.get(kind) ?? [];
    if (ids.length === 0) continue;
    const rows = (
      await tx.execute(sql`
        select id::text as id, version, deleted_at is not null as deleted
        from ${sql.identifier(TABLE[kind])}
        where tenant_id = ${tenantId}::uuid and id in (${uuidList(ids)})
      `)
    ).rows as unknown as { id: string; version: number; deleted: boolean }[];
    for (const row of rows) {
      const key = keyOf(kind, row.id);
      if (row.deleted) {
        // The Recycle Bin owns it now. Left alone, but not forgotten: a restore
        // must find what it pointed at still there.
        kept.add(key);
        continue;
      }
      live.add(key);
      if (row.version > 1) kept.add(key); // edited
    }
  }

  // ---- 3. every reference to a registered record ----------------------------
  const references: Reference[] = [];
  const isSample = (kind: string, id: string): boolean => sampleKeys.has(keyOf(kind, id));
  const accountIds = idsByKind.get('account') ?? [];
  const contactIds = idsByKind.get('contact') ?? [];
  const dealIds = idsByKind.get('deal') ?? [];

  type Row = Record<string, string | null>;
  const rowsOf = async (query: SQL): Promise<Row[]> =>
    (await tx.execute(query)).rows as unknown as Row[];

  if (accountIds.length > 0) {
    // account -> parent account (SET NULL)
    for (const row of await rowsOf(sql`
      select id::text as id, parent_account_id::text as to_id from accounts
      where tenant_id = ${tenantId}::uuid and parent_account_id in (${uuidList(accountIds)})`)) {
      references.push({
        from: keyOf('account', row['id']!),
        fromIsSample: isSample('account', row['id']!),
        to: keyOf('account', row['to_id']!),
      });
    }
    // contact -> account (SET NULL)
    for (const row of await rowsOf(sql`
      select id::text as id, account_id::text as to_id from contacts
      where tenant_id = ${tenantId}::uuid and account_id in (${uuidList(accountIds)})`)) {
      references.push({
        from: keyOf('contact', row['id']!),
        fromIsSample: isSample('contact', row['id']!),
        to: keyOf('account', row['to_id']!),
      });
    }
  }

  if (accountIds.length > 0 || contactIds.length > 0) {
    // deal -> account, deal -> primary contact (SET NULL)
    const accountMatch =
      accountIds.length > 0 ? sql`account_id in (${uuidList(accountIds)})` : sql`false`;
    const contactMatch =
      contactIds.length > 0 ? sql`primary_contact_id in (${uuidList(contactIds)})` : sql`false`;
    for (const row of await rowsOf(sql`
      select id::text as id, account_id::text as account_id,
             primary_contact_id::text as contact_id
      from deals where tenant_id = ${tenantId}::uuid and (${accountMatch} or ${contactMatch})`)) {
      const fromIsSample = isSample('deal', row['id']!);
      if (row['account_id'] !== null && isSample('account', row['account_id']!)) {
        references.push({
          from: keyOf('deal', row['id']!),
          fromIsSample,
          to: keyOf('account', row['account_id']!),
        });
      }
      if (row['contact_id'] !== null && isSample('contact', row['contact_id']!)) {
        references.push({
          from: keyOf('deal', row['id']!),
          fromIsSample,
          to: keyOf('contact', row['contact_id']!),
        });
      }
    }
  }

  if (contactIds.length > 0) {
    // deal -> contact through deal_contacts (CASCADE)
    for (const row of await rowsOf(sql`
      select deal_id::text as deal_id, contact_id::text as contact_id from deal_contacts
      where tenant_id = ${tenantId}::uuid and contact_id in (${uuidList(contactIds)})`)) {
      references.push({
        from: keyOf('deal', row['deal_id']!),
        fromIsSample: isSample('deal', row['deal_id']!),
        to: keyOf('contact', row['contact_id']!),
      });
    }
  }

  if (accountIds.length + contactIds.length + dealIds.length > 0) {
    // lead -> the contact, account and deal it was converted into (SET NULL)
    const match = (column: string, ids: readonly string[]) =>
      ids.length > 0 ? sql`${sql.identifier(column)} in (${uuidList(ids)})` : sql`false`;
    for (const row of await rowsOf(sql`
      select id::text as id, converted_contact_id::text as contact_id,
             converted_account_id::text as account_id, converted_deal_id::text as deal_id
      from leads where tenant_id = ${tenantId}::uuid
        and (${match('converted_contact_id', contactIds)}
          or ${match('converted_account_id', accountIds)}
          or ${match('converted_deal_id', dealIds)})`)) {
      const from = keyOf('lead', row['id']!);
      const fromIsSample = isSample('lead', row['id']!);
      for (const [kind, id] of [
        ['contact', row['contact_id']],
        ['account', row['account_id']],
        ['deal', row['deal_id']],
      ] as const) {
        if (id !== null && id !== undefined && isSample(kind, id)) {
          references.push({ from, fromIsSample, to: keyOf(kind, id) });
        }
      }
    }
  }

  // Polymorphic references, which have no foreign key at all (ADR-0005).
  // A task about a record: sample tasks are ours, anything else is somebody's.
  for (const row of await rowsOf(sql`
    select activity_id::text as activity_id, object_type, record_id::text as record_id
    from activity_links
    where tenant_id = ${tenantId}::uuid and record_id in (${uuidList(allIds)})`)) {
    if (!isSample(row['object_type']!, row['record_id']!)) continue;
    references.push({
      from: keyOf('activity', row['activity_id']!),
      fromIsSample: isSample('activity', row['activity_id']!),
      to: keyOf(row['object_type']!, row['record_id']!),
    });
  }
  // Tags and attachments: sample data never creates either, so any that exist
  // were put there by a person.
  for (const table of ['record_tags', 'attachments'] as const) {
    for (const row of await rowsOf(sql`
      select object_type, record_id::text as record_id from ${sql.identifier(table)}
      where tenant_id = ${tenantId}::uuid and record_id in (${uuidList(allIds)})`)) {
      if (!isSample(row['object_type']!, row['record_id']!)) continue;
      references.push({
        from: `${table}:${row['record_id']}`,
        fromIsSample: false,
        to: keyOf(row['object_type']!, row['record_id']!),
      });
    }
  }

  // ---- 4. who is kept ---------------------------------------------------------
  // Rule 2: referred to by something that is not sample data.
  for (const ref of references) {
    if (!ref.fromIsSample && live.has(ref.to)) kept.add(ref.to);
  }
  // Rule 3: referred to by something that is being kept — repeated to a fixpoint,
  // because a kept deal keeps an account, which may keep its parent.
  for (let changed = true; changed;) {
    changed = false;
    for (const ref of references) {
      if (kept.has(ref.from) && live.has(ref.to) && !kept.has(ref.to)) {
        kept.add(ref.to);
        changed = true;
      }
    }
  }

  const toRemove = new Map<Kind, string[]>(KINDS.map((kind) => [kind, []]));
  for (const key of live) {
    if (kept.has(key)) continue;
    const [kind, id] = key.split(':') as [Kind, string];
    toRemove.get(kind)?.push(id);
  }

  // ---- 5. mark, then purge, children first --------------------------------------
  //
  // `hardDelete` refuses a row that is not already soft-deleted, so that a bug
  // upstream cannot turn the purge into a way to delete live data. That guard is
  // right and stays. These records are live, so they are marked deleted first, in
  // this same transaction, and the existing purge is handed exactly the ids that
  // were marked.
  //
  // The mark carries `version = 1`: if somebody edits a record between the
  // classification above and this statement, it no longer matches, is not marked,
  // and is therefore not deleted — closing the race without holding row locks.
  // The cleanup of what points at a record runs only for the ids that were marked,
  // so an edited record never has its links or timeline removed from under it.
  const removed = emptyCounts();
  const purged: { kind: Kind; id: string }[] = [];
  for (const kind of DELETE_ORDER) {
    const candidates = toRemove.get(kind) ?? [];
    if (candidates.length === 0) continue;

    const marked = (
      await tx.execute(sql`
        update ${sql.identifier(TABLE[kind])}
        set deleted_at = clock_timestamp()
        where tenant_id = ${tenantId}::uuid
          and id in (${uuidList(candidates)})
          and version = 1
          and deleted_at is null
        returning id::text as id
      `)
    ).rows as unknown as { id: string }[];
    const ids = marked.map((row) => row.id);
    if (ids.length === 0) continue;

    await removeReferences(tx, tenantId, kind, ids);
    removed[COUNT_KEY[kind]] = await hardDelete(tx, tenantId, descriptorFor(kind), ids);
    for (const id of ids) purged.push({ kind, id });
  }

  // ---- 6. the trail --------------------------------------------------------------
  if (purged.length > 0) {
    await tx.insert(auditLogs).values(
      purged.map((record) => ({
        id: newId(),
        tenantId,
        actorId,
        action: 'purge',
        objectType: record.kind,
        recordId: record.id,
        changes: {},
      })),
    );
    // What the Recycle Bin's sweep also publishes, so the search index and the
    // attachment cleanup hear that these records are gone.
    await tx.insert(outboxEvents).values(
      purged.map((record) => ({
        id: newId(),
        tenantId,
        eventType: `${record.kind}.purged.v1`,
        objectType: record.kind,
        recordId: record.id,
        ...(actorId === null ? {} : { actorId }),
      })),
    );
  }

  // Kept is what was live and is still here. Counted from what actually went,
  // not from what was planned, so a record skipped by the version guard is
  // reported as kept rather than vanishing from both numbers.
  const keptCounts = emptyCounts();
  for (const key of live) {
    const [kind] = key.split(':') as [Kind];
    keptCounts[COUNT_KEY[kind]] += 1;
  }
  for (const kind of KINDS) keptCounts[COUNT_KEY[kind]] -= removed[COUNT_KEY[kind]];

  await tx.insert(auditLogs).values({
    id: newId(),
    tenantId,
    actorId,
    action: 'sample_data_removed',
    objectType: 'tenant',
    recordId: tenantId,
    changes: { removed: { new: removed }, kept: { new: keptCounts } },
  });

  // Whatever was registered is released: removed rows were cleared with their
  // references above, and the rest are the company's records now.
  await tx.execute(sql`delete from sample_records where tenant_id = ${tenantId}::uuid`);

  return { removed, kept: keptCounts };
}
