import type { MergeableObjectType, RecordConstraint } from '@crm/core';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { constraintToSql } from '../record-scope.js';

/**
 * The statements a record merge needs against tables that are not its own (ADR-0064, CLAUDE.md §3).
 *
 * The same arrangement as `bulk/index.ts` and `access/reassign.ts`: a closed catalogue in the db package,
 * because the module boundary says the merge module may not read the activities, deals, leads or
 * attachments tables, and the facts it needs are the same for a contact and an account. Table and column
 * names are constants below, quoted with `sql.identifier`, never request values (CLAUDE.md §5.7). Every
 * statement names the tenant as well as relying on row-level security.
 *
 * What "everything that points at the record" means is decided here, in one place, and is the list a
 * reviewer should check against the schema:
 *
 *   contact:  deals.primary_contact_id, deal_contacts.contact_id, leads.converted_contact_id
 *   account:  contacts.account_id, deals.account_id, accounts.parent_account_id,
 *             leads.converted_account_id
 *   both:     the polymorphic `(object_type, record_id)` rows: activity_links (calls, meetings, tasks
 *             and notes: a note is an activity), attachments, record_tags, timeline_events,
 *             record_views
 *   kept:     audit_logs and outbox_events (history; they name the old id and stay true),
 *             saved views (a stored condition may carry the loser's id as text: left alone)
 *   cleared:  search_documents (a projection: the loser's rows go with its delete event)
 */

const TABLES: Readonly<Record<MergeableObjectType, string>> = {
  contact: 'contacts',
  account: 'accounts',
};

export interface MergeRowRef {
  readonly id: string;
  readonly ownerId: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * Lock both records of a pair, always in id order, and read what the checks need.
 *
 * Ordered, so two merges of the same two records in opposite directions (A into B and B into A) lock
 * in the same sequence and one waits for the other instead of deadlocking. The caller judges each row
 * against `can()`; nothing here applies record scope, and what it returns is never sent to a client.
 */
export async function lockMergePair(
  tx: Tx,
  tenantId: string,
  objectType: MergeableObjectType,
  ids: readonly [string, string],
): Promise<Map<string, MergeRowRef>> {
  const table = sql.identifier(TABLES[objectType]);
  const result = await tx.execute(sql`
    select id, owner_id, version, deleted_at, created_at
    from ${table}
    where tenant_id = ${tenantId}::uuid
      and id in (${ids[0]}::uuid, ${ids[1]}::uuid)
    order by id
    for update
  `);
  const rows = new Map<string, MergeRowRef>();
  for (const row of result.rows as unknown as {
    id: string;
    owner_id: string | null;
    version: number;
    deleted_at: Date | string | null;
    created_at: Date | string;
  }[]) {
    rows.set(row.id, {
      id: row.id,
      ownerId: row.owner_id,
      version: row.version,
      deletedAt: row.deleted_at === null ? null : new Date(row.deleted_at),
      createdAt: new Date(row.created_at),
    });
  }
  return rows;
}

/** Where a merged-away record went, if it was merged and the merge has not been undone. */
export async function findMergePointer(
  tx: Tx,
  tenantId: string,
  objectType: MergeableObjectType,
  loserId: string,
): Promise<{ readonly masterId: string; readonly loserOwnerId: string | null } | null> {
  const table = sql.identifier(TABLES[objectType]);
  // Left join: after the Recycle Bin purge the loser's row is gone and the pointer still answers.
  const result = await tx.execute(sql`
    select rm.master_id, t.owner_id, t.id is not null as loser_exists
    from record_merges rm
    left join ${table} t on t.tenant_id = rm.tenant_id and t.id = rm.loser_id
    where rm.tenant_id = ${tenantId}::uuid
      and rm.object_type = ${objectType}
      and rm.loser_id = ${loserId}::uuid
      and rm.undone_at is null
    limit 1
  `);
  const row = result.rows[0] as
    { master_id: string; owner_id: string | null; loser_exists: boolean } | undefined;
  if (row === undefined) return null;
  return { masterId: row.master_id, loserOwnerId: row.loser_exists ? row.owner_id : null };
}

/** True when `descendantId` sits somewhere under `ancestorId` in the account hierarchy. */
export async function isAccountDescendantOf(
  tx: Tx,
  tenantId: string,
  descendantId: string,
  ancestorId: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    with recursive ancestors as (
      select a.parent_account_id as id, 1 as depth
      from accounts a
      where a.tenant_id = ${tenantId}::uuid and a.id = ${descendantId}::uuid
      union all
      select a.parent_account_id, ancestors.depth + 1
      from accounts a
      join ancestors on a.id = ancestors.id
      where a.tenant_id = ${tenantId}::uuid and a.parent_account_id is not null and ancestors.depth < 64
    )
    select exists (select 1 from ancestors where id = ${ancestorId}::uuid) as found
  `);
  return (result.rows[0] as { found: boolean }).found;
}

/** An erasure request that has not finished for this person: merging would race it (ADR-0032). */
export async function hasOpenErasure(
  tx: Tx,
  tenantId: string,
  objectType: MergeableObjectType,
  id: string,
): Promise<boolean> {
  if (objectType !== 'contact') return false;
  const result = await tx.execute(sql`
    select exists (
      select 1 from erasure_requests
      where tenant_id = ${tenantId}::uuid
        and subject_object_type = 'contact'
        and subject_record_id = ${id}::uuid
        and status in ('pending', 'processing')
    ) as found
  `);
  return (result.rows[0] as { found: boolean }).found;
}

/* -------------------------------------------------------------------------- */
/* Counting                                                                     */
/* -------------------------------------------------------------------------- */

export interface MergeWork {
  /** Every row a merge would touch, for the cap. Not scoped to anybody: it is the work, not a report. */
  readonly totalRows: number;
}

/**
 * How many rows merging `loserId` away would touch, across every table in the catalogue.
 *
 * Counted before anything is moved, so a merge that is too large refuses without having done any of it.
 */
export async function countMergeWork(
  tx: Tx,
  tenantId: string,
  objectType: MergeableObjectType,
  loserId: string,
): Promise<MergeWork> {
  const t = sql`${tenantId}::uuid`;
  const l = sql`${loserId}::uuid`;
  const polymorphic = sql`
    (select count(*) from activity_links where tenant_id = ${t} and object_type = ${objectType} and record_id = ${l})
    + (select count(*) from attachments where tenant_id = ${t} and object_type = ${objectType} and record_id = ${l})
    + (select count(*) from record_tags where tenant_id = ${t} and object_type = ${objectType} and record_id = ${l})
    + (select count(*) from timeline_events where tenant_id = ${t} and object_type = ${objectType} and record_id = ${l})
    + (select count(*) from record_views where tenant_id = ${t} and object_type = ${objectType} and record_id = ${l})
  `;
  const direct =
    objectType === 'contact'
      ? sql`
        (select count(*) from deals where tenant_id = ${t} and primary_contact_id = ${l})
        + (select count(*) from deal_contacts where tenant_id = ${t} and contact_id = ${l})
        + (select count(*) from leads where tenant_id = ${t} and converted_contact_id = ${l})
      `
      : sql`
        (select count(*) from contacts where tenant_id = ${t} and account_id = ${l})
        + (select count(*) from deals where tenant_id = ${t} and account_id = ${l})
        + (select count(*) from accounts where tenant_id = ${t} and parent_account_id = ${l})
        + (select count(*) from leads where tenant_id = ${t} and converted_account_id = ${l})
      `;
  const result = await tx.execute(sql`select ((${polymorphic}) + (${direct}))::int as total`);
  return { totalRows: (result.rows[0] as { total: number }).total };
}

export interface MergeScopes {
  /** The caller's read scope per kind of linked record; `null`: may not read that kind at all. */
  readonly activity: RecordConstraint | null;
  readonly deal: RecordConstraint | null;
  readonly contact: RecordConstraint | null;
  readonly account: RecordConstraint | null;
  readonly lead: RecordConstraint | null;
}

export interface VisibleMergeCounts {
  readonly activities: number | null;
  readonly notes: number | null;
  readonly files: number;
  readonly deals: number | null;
  readonly contacts: number | null;
  readonly childAccounts: number | null;
  readonly leads: number | null;
  readonly tags: number;
}

function scoped(constraint: RecordConstraint, owner: SQL): SQL {
  return constraintToSql(constraint, owner) ?? sql`true`;
}

async function countOf(tx: Tx, query: SQL): Promise<number> {
  const result = await tx.execute(sql`select count(*)::int as n from (${query}) counted`);
  return (result.rows[0] as { n: number }).n;
}

/**
 * What the preview tells the caller will move: counts of live records, each kind **limited to what this
 * caller may read** (`null` when they may read none of that kind), because a count of records somebody
 * cannot see is information about them. The rows move either way.
 */
export async function countVisibleMerge(
  tx: Tx,
  tenantId: string,
  objectType: MergeableObjectType,
  loserId: string,
  masterId: string,
  scopes: MergeScopes,
): Promise<VisibleMergeCounts> {
  const t = sql`${tenantId}::uuid`;
  const l = sql`${loserId}::uuid`;

  const linkedActivities = (type: 'note' | 'other', constraint: RecordConstraint) => sql`
    select a.id
    from activity_links k
    join activities a on a.tenant_id = k.tenant_id and a.id = k.activity_id
    where k.tenant_id = ${t} and k.object_type = ${objectType} and k.record_id = ${l}
      and a.deleted_at is null
      and ${type === 'note' ? sql`a.type = 'note'` : sql`a.type <> 'note'`}
      and ${scoped(constraint, sql`a.assigned_to`)}
  `;

  const files = await countOf(
    tx,
    sql`select id from attachments
        where tenant_id = ${t} and object_type = ${objectType} and record_id = ${l}
          and deleted_at is null`,
  );
  // Tags the master gains: those on the loser it does not already carry.
  const tags = await countOf(
    tx,
    sql`select r.tag_id from record_tags r
        where r.tenant_id = ${t} and r.object_type = ${objectType} and r.record_id = ${l}
          and not exists (
            select 1 from record_tags m
            where m.tenant_id = r.tenant_id and m.object_type = r.object_type
              and m.tag_id = r.tag_id and m.record_id = ${masterId}::uuid
          )`,
  );

  const activities =
    scopes.activity === null ? null : await countOf(tx, linkedActivities('other', scopes.activity));
  const notes =
    scopes.activity === null ? null : await countOf(tx, linkedActivities('note', scopes.activity));

  const deals =
    scopes.deal === null
      ? null
      : await countOf(
          tx,
          objectType === 'contact'
            ? sql`select d.id from deals d
                  where d.tenant_id = ${t} and d.deleted_at is null
                    and (d.primary_contact_id = ${l}
                         or exists (select 1 from deal_contacts c
                                    where c.tenant_id = d.tenant_id and c.deal_id = d.id
                                      and c.contact_id = ${l}))
                    and ${scoped(scopes.deal, sql`d.owner_id`)}`
            : sql`select d.id from deals d
                  where d.tenant_id = ${t} and d.deleted_at is null and d.account_id = ${l}
                    and ${scoped(scopes.deal, sql`d.owner_id`)}`,
        );

  const leads =
    scopes.lead === null
      ? null
      : await countOf(
          tx,
          sql`select x.id from leads x
              where x.tenant_id = ${t} and x.deleted_at is null
                and ${objectType === 'contact' ? sql`x.converted_contact_id` : sql`x.converted_account_id`} = ${l}
                and ${scoped(scopes.lead, sql`x.owner_id`)}`,
        );

  const contacts =
    objectType === 'contact'
      ? 0
      : scopes.contact === null
        ? null
        : await countOf(
            tx,
            sql`select c.id from contacts c
                where c.tenant_id = ${t} and c.deleted_at is null and c.account_id = ${l}
                  and ${scoped(scopes.contact, sql`c.owner_id`)}`,
          );

  const childAccounts =
    objectType === 'contact'
      ? 0
      : scopes.account === null
        ? null
        : await countOf(
            tx,
            sql`select a.id from accounts a
                where a.tenant_id = ${t} and a.deleted_at is null and a.parent_account_id = ${l}
                  and a.id <> ${masterId}::uuid
                  and ${scoped(scopes.account, sql`a.owner_id`)}`,
          );

  return { activities, notes, files, deals, contacts, childAccounts, leads, tags };
}

/* -------------------------------------------------------------------------- */
/* Moving                                                                       */
/* -------------------------------------------------------------------------- */

/** Business records that now point at the master, by kind: the ones that get an audit entry and an event. */
export interface RepointedRecords {
  readonly contact: readonly string[];
  readonly account: readonly string[];
  readonly deal: readonly string[];
  readonly lead: readonly string[];
}

export interface MoveResult {
  /** Rows of each table changed, for the record of what happened. */
  readonly moved: Readonly<Record<string, number>>;
  readonly repointed: RepointedRecords;
}

async function idsOf(tx: Tx, query: SQL): Promise<{ id: string; live: boolean }[]> {
  const result = await tx.execute(query);
  return (result.rows as unknown as { id: string; live: boolean }[]).map((row) => ({
    id: row.id,
    live: row.live,
  }));
}

/**
 * Write the pointer for a merge. The row must exist **before** a converted lead is re-pointed: the
 * trigger that freezes a lead's links (migration 0026) accepts a move only when this row, written in the
 * same transaction, says the old target was merged into the new one.
 *
 * It also collapses a chain: if records were earlier merged into the loser, they now answer with the
 * master, so an old id is always one hop from the survivor.
 */
export async function writeMergePointer(
  tx: Tx,
  args: {
    readonly id: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly objectType: MergeableObjectType;
    readonly loserId: string;
    readonly masterId: string;
    readonly moved: Readonly<Record<string, number | null>>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into record_merges (id, tenant_id, object_type, loser_id, master_id, moved, created_by, updated_by)
    values (${args.id}::uuid, ${args.tenantId}::uuid, ${args.objectType}, ${args.loserId}::uuid,
            ${args.masterId}::uuid, ${JSON.stringify(args.moved)}::jsonb, ${args.userId}::uuid,
            ${args.userId}::uuid)
  `);
  await tx.execute(sql`
    update record_merges
    set master_id = ${args.masterId}::uuid, updated_at = now(), updated_by = ${args.userId}::uuid
    where tenant_id = ${args.tenantId}::uuid
      and object_type = ${args.objectType}
      and master_id = ${args.loserId}::uuid
      and undone_at is null
      and id <> ${args.id}::uuid
  `);
}

/** The merge was a mistake and the loser has been restored: its old id stops answering "merged". */
export async function markMergeUndone(
  tx: Tx,
  tenantId: string,
  objectType: MergeableObjectType,
  loserId: string,
  userId: string | null,
): Promise<void> {
  await tx.execute(sql`
    update record_merges
    set undone_at = now(), updated_at = now(), updated_by = ${userId}::uuid
    where tenant_id = ${tenantId}::uuid
      and object_type = ${objectType}
      and loser_id = ${loserId}::uuid
      and undone_at is null
  `);
}

/**
 * Re-point everything in the catalogue from the loser to the master, inside the caller's transaction.
 *
 * Rows that would collide on a unique pair (a tag both records carry, an activity linked to both, a deal
 * that has both people on it) are not moved: the loser's copy is dropped, because the master already has
 * the fact. Records that now point somewhere new get their `version` bumped, so a colleague who has one
 * open and saves gets a 409 instead of writing over the change. Soft-deleted rows move too: a deal in
 * the Recycle Bin that is restored next month must not point at a record that has been folded away.
 */
export async function moveMergeChildren(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly userId: string;
    readonly objectType: MergeableObjectType;
    readonly loserId: string;
    readonly masterId: string;
  },
): Promise<MoveResult> {
  const t = sql`${args.tenantId}::uuid`;
  const l = sql`${args.loserId}::uuid`;
  const m = sql`${args.masterId}::uuid`;
  const u = sql`${args.userId}::uuid`;
  const ot = args.objectType;
  const moved: Record<string, number> = {};
  const repointed = {
    contact: [] as string[],
    account: [] as string[],
    deal: [] as string[],
    lead: [] as string[],
  };
  const note = (name: string, count: number) => {
    moved[name] = (moved[name] ?? 0) + count;
  };
  const live = (rows: { id: string; live: boolean }[], into: string[]) => {
    for (const row of rows) if (row.live) into.push(row.id);
  };

  if (ot === 'contact') {
    const deals = await idsOf(
      tx,
      sql`update deals set primary_contact_id = ${m}, version = version + 1, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and primary_contact_id = ${l}
          returning id, (deleted_at is null) as live`,
    );
    note('deals', deals.length);
    live(deals, repointed.deal);

    // A deal that has both people keeps one row. If the master's has no role and the loser's does, keep it.
    await tx.execute(sql`
      update deal_contacts mc set role = lc.role, updated_at = now(), updated_by = ${u}
      from deal_contacts lc
      where mc.tenant_id = ${t} and lc.tenant_id = ${t} and mc.deal_id = lc.deal_id
        and mc.contact_id = ${m} and lc.contact_id = ${l}
        and mc.role is null and lc.role is not null`);
    const dropped = await idsOf(
      tx,
      sql`delete from deal_contacts lc using deal_contacts mc
          where lc.tenant_id = ${t} and mc.tenant_id = ${t} and lc.deal_id = mc.deal_id
            and lc.contact_id = ${l} and mc.contact_id = ${m}
          returning lc.id, true as live`,
    );
    const people = await idsOf(
      tx,
      sql`update deal_contacts set contact_id = ${m}, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and contact_id = ${l}
          returning id, true as live`,
    );
    note('dealContacts', people.length + dropped.length);

    const leads = await idsOf(
      tx,
      sql`update leads set converted_contact_id = ${m}, version = version + 1, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and converted_contact_id = ${l}
          returning id, (deleted_at is null) as live`,
    );
    note('leads', leads.length);
    live(leads, repointed.lead);
  } else {
    const contacts = await idsOf(
      tx,
      sql`update contacts set account_id = ${m}, version = version + 1, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and account_id = ${l}
          returning id, (deleted_at is null) as live`,
    );
    note('contacts', contacts.length);
    live(contacts, repointed.contact);

    const deals = await idsOf(
      tx,
      sql`update deals set account_id = ${m}, version = version + 1, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and account_id = ${l}
          returning id, (deleted_at is null) as live`,
    );
    note('deals', deals.length);
    live(deals, repointed.deal);

    const children = await idsOf(
      tx,
      sql`update accounts set parent_account_id = ${m}, version = version + 1, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and parent_account_id = ${l} and id <> ${m}
          returning id, (deleted_at is null) as live`,
    );
    note('childAccounts', children.length);
    live(children, repointed.account);

    const leads = await idsOf(
      tx,
      sql`update leads set converted_account_id = ${m}, version = version + 1, updated_at = now(), updated_by = ${u}
          where tenant_id = ${t} and converted_account_id = ${l}
          returning id, (deleted_at is null) as live`,
    );
    note('leads', leads.length);
    live(leads, repointed.lead);
  }

  // ---- the polymorphic rows (ADR-0005) --------------------------------------------------------
  // A call, note or task linked to both records keeps one link.
  const droppedLinks = await idsOf(
    tx,
    sql`delete from activity_links lk using activity_links mk
        where lk.tenant_id = ${t} and mk.tenant_id = ${t}
          and lk.object_type = ${ot} and mk.object_type = ${ot}
          and lk.record_id = ${l} and mk.record_id = ${m} and lk.activity_id = mk.activity_id
        returning lk.id, true as live`,
  );
  const links = await idsOf(
    tx,
    sql`update activity_links set record_id = ${m}, updated_at = now(), updated_by = ${u}
        where tenant_id = ${t} and object_type = ${ot} and record_id = ${l}
        returning id, true as live`,
  );
  note('activityLinks', links.length + droppedLinks.length);

  const files = await idsOf(
    tx,
    sql`update attachments set record_id = ${m}, updated_at = now(), updated_by = ${u}
        where tenant_id = ${t} and object_type = ${ot} and record_id = ${l}
        returning id, true as live`,
  );
  note('files', files.length);

  // The master gains the tags it did not have; one both carry stays one.
  const droppedTags = await idsOf(
    tx,
    sql`delete from record_tags lt using record_tags mt
        where lt.tenant_id = ${t} and mt.tenant_id = ${t}
          and lt.object_type = ${ot} and mt.object_type = ${ot}
          and lt.record_id = ${l} and mt.record_id = ${m} and lt.tag_id = mt.tag_id
        returning lt.id, true as live`,
  );
  const tags = await idsOf(
    tx,
    sql`update record_tags set record_id = ${m}, updated_at = now(), updated_by = ${u}
        where tenant_id = ${t} and object_type = ${ot} and record_id = ${l}
        returning id, true as live`,
  );
  note('tags', tags.length + droppedTags.length);

  const timeline = await idsOf(
    tx,
    sql`update timeline_events set record_id = ${m}, updated_at = now()
        where tenant_id = ${t} and object_type = ${ot} and record_id = ${l}
        returning id, true as live`,
  );
  note('timelineEvents', timeline.length);

  // "Recently viewed" is one row per person per record: where a person has seen both, the master's stays.
  const droppedViews = await idsOf(
    tx,
    sql`delete from record_views lv using record_views mv
        where lv.tenant_id = ${t} and mv.tenant_id = ${t}
          and lv.object_type = ${ot} and mv.object_type = ${ot}
          and lv.user_id = mv.user_id and lv.record_id = ${l} and mv.record_id = ${m}
        returning lv.id, true as live`,
  );
  const views = await idsOf(
    tx,
    sql`update record_views set record_id = ${m}, updated_at = now()
        where tenant_id = ${t} and object_type = ${ot} and record_id = ${l}
        returning id, true as live`,
  );
  note('recentViews', views.length + droppedViews.length);

  return { moved, repointed };
}

/**
 * Finish the master: keep the older creation date, carry over what the loser alone knew, and make sure
 * it does not stay marked as sample data when it now carries a real record's history.
 *
 * - `created_at` and `created_by` follow whichever record is older, because "customer since" is a fact
 *   about the relationship and the earlier record is the better witness to it (ADR-0064).
 * - A contact's consent is kept as the master's; a channel recorded only on the loser is carried over, so
 *   a merge never drops a recorded consent. A missing address is taken from the loser.
 * - If the master was sample data (ADR-0037) and the loser was not, it is deregistered: "remove the
 *   sample data" would otherwise delete a record that now holds a real customer's history.
 */
export async function finishMaster(
  tx: Tx,
  args: {
    readonly tenantId: string;
    readonly userId: string;
    readonly objectType: MergeableObjectType;
    readonly loserId: string;
    readonly masterId: string;
    /** Bump the master's version, for a merge that changed none of its own fields. */
    readonly touch: boolean;
  },
): Promise<void> {
  const table = sql.identifier(TABLES[args.objectType]);
  const t = sql`${args.tenantId}::uuid`;
  const touch = args.touch ? sql`, version = m.version + 1` : sql``;

  await tx.execute(sql`
    update ${table} m
    set created_at = least(m.created_at, l.created_at),
        created_by = case when l.created_at < m.created_at then l.created_by else m.created_by end,
        updated_at = now(),
        updated_by = ${args.userId}::uuid
        ${touch}
    from ${table} l
    where m.tenant_id = ${t} and l.tenant_id = ${t}
      and m.id = ${args.masterId}::uuid and l.id = ${args.loserId}::uuid
  `);

  if (args.objectType === 'contact') {
    await tx.execute(sql`
      update contacts m
      set consent = l.consent || m.consent,
          address = coalesce(m.address, l.address)
      from contacts l
      where m.tenant_id = ${t} and l.tenant_id = ${t}
        and m.id = ${args.masterId}::uuid and l.id = ${args.loserId}::uuid
        and (l.consent <> '{}'::jsonb or (m.address is null and l.address is not null))
    `);
  }

  await tx.execute(sql`
    delete from sample_records s
    where s.tenant_id = ${t} and s.object_type = ${args.objectType} and s.record_id = ${args.masterId}::uuid
      and not exists (
        select 1 from sample_records o
        where o.tenant_id = ${t} and o.object_type = ${args.objectType} and o.record_id = ${args.loserId}::uuid
      )
  `);
}
