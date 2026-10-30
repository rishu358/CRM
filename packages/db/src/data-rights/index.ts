import { ERASED_PLACEHOLDER, PII_COLUMNS, type ErasableObjectType } from '@crm/core';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { descriptorFor } from '../recycle-bin/index.js';

/**
 * Data access for DPDP/GDPR data rights (MVP_SPEC M11, ADR-0032).
 *
 * In `@crm/db` because the worker performs all of it and the API performs none
 * of it: the API records the request and the capability check, the worker does
 * the reading and writing. Keeping the statements here rather than in the
 * worker is the same choice `recycle-bin/` and the search projection made — one
 * definition of what "this person's data" means, reachable by the tests
 * directly.
 */

/**
 * `first_name` -> `firstName`.
 *
 * `PII_COLUMNS` is keyed by column name, because that is what the UPDATE needs.
 * An audit diff's keys are the camelCase ones `diffChanges` produced from a
 * Drizzle row. The redaction has to speak both.
 */
export function toDiffKey(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * The diff keys an erasure replaces with `[erased]`.
 *
 * The PII columns of the object, in their diff spelling, plus `customFields` —
 * which holds whatever the tenant decided to put there and therefore cannot be
 * assumed free of personal data. Erasing the whole custom object is the safe
 * direction and the one the data subject asked for.
 */
export function redactableDiffKeys(objectType: ErasableObjectType): string[] {
  return [...Object.keys(PII_COLUMNS[objectType]).map(toDiffKey), 'customFields'];
}

export interface ErasureOutcome {
  /** How many record rows were changed. 0 or 1 — the subject is one record. */
  readonly recordsErased: number;
  /** Which columns were actually cleared or pseudonymised. */
  readonly erasedColumns: readonly string[];
}

/**
 * Delete or pseudonymise the personal columns of one record.
 *
 * Runs as `crm_worker`, inside the tenant's transaction, through the ordinary
 * grants — nothing privileged is needed to change a contact. The treatment of
 * each column comes from `PII_COLUMNS` in `@crm/core`, never from the request:
 * a caller who could name columns could name `owner_id`.
 *
 * `deleted_at` is set as well. An erased record is not a usable record — its
 * name is `[erased]` and it has no contact details — so leaving it in the lists
 * would be worse for everybody than putting it in the Bin, where the purge job
 * removes the husk after the retention window.
 */
export async function erasePersonalColumns(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
  userId: string | null,
): Promise<ErasureOutcome> {
  const descriptor = descriptorFor(objectType);
  const treatments = PII_COLUMNS[objectType];

  const assignments = Object.entries(treatments).map(([column, treatment]) => {
    const target = sql.identifier(column);
    switch (treatment) {
      case 'clear':
        return sql`${target} = null`;
      case 'redact':
        return sql`${target} = ${ERASED_PLACEHOLDER}`;
      case 'empty':
        return sql`${target} = '{}'::jsonb`;
    }
  });

  const result = await tx.execute(sql`
    update ${sql.identifier(descriptor.table)}
    set ${sql.join(assignments, sql`, `)},
        custom_fields = '{}'::jsonb,
        deleted_at = coalesce(deleted_at, now()),
        version = version + 1,
        updated_at = now(),
        updated_by = ${userId}
    where tenant_id = ${tenantId}::uuid
      and id = ${recordId}::uuid
  `);

  // A lead a website form made has a consent record beside it (ADR-0065 6). Erasing the person removes
  // it: it exists to show what this person accepted, and they have asked to be forgotten. It holds no
  // copy of what they typed, so nothing else of theirs is there to find.
  if (objectType === 'lead') {
    await tx.execute(sql`
      delete from lead_form_submissions
      where tenant_id = ${tenantId}::uuid and lead_id = ${recordId}::uuid
    `);
  }

  // Email sent to this person (ADR-0073): the address, subject and body are theirs, so they are scrubbed.
  // The row stays, so counts and the log's own history stay true, marked `erased_at`. Found through the
  // contact it was written to, or through a link to this record (a lead's mail).
  await tx.execute(sql`
    update email_messages
    set to_address = null, subject = '', body_text = '', erased_at = now(), updated_at = now()
    where tenant_id = ${tenantId}::uuid
      and erased_at is null
      and (
        contact_id = ${recordId}::uuid
        or id in (
          select email_message_id from email_message_links
          where tenant_id = ${tenantId}::uuid
            and object_type = ${objectType}
            and record_id = ${recordId}::uuid
        )
      )
  `);

  return {
    recordsErased: result.rowCount ?? 0,
    erasedColumns: Object.keys(treatments),
  };
}

/**
 * Replace personal values in this subject's audit diffs with `[erased]`
 * (MVP_SPEC M11, ADR-0032).
 *
 * **This is the one statement in the system that writes to `audit_logs`
 * other than an INSERT, and it must be run on the `crm_erasure` connection.**
 * `crm_app` and `crm_worker` hold no UPDATE grant on the table at all, so
 * running it on either fails — which is the point, and is asserted directly in
 * the security suite.
 *
 * What it can and cannot do is decided by Postgres, not by this function:
 *
 *   - the column grant is `UPDATE (changes)`, so no other column can be
 *     touched. Who did what, to which record, when, and from where survives any
 *     erasure;
 *   - the RLS policy admits a row only while an `erasure_requests` row for this
 *     exact subject says `processing`, so this statement outside its window
 *     updates nothing.
 *
 * The rewrite keeps the *shape* of each entry: an entry that recorded only a
 * new value still records only a new value, now `[erased]`. A reader of the log
 * can therefore still see that the field changed and when — which is the whole
 * reason the row is kept rather than deleted.
 *
 * No bound on `occurred_at`, so this reads every partition. That is deliberate:
 * an erasure must reach the person's entire history, and it is a rare
 * administrative action rather than a request-path query. Each partition is
 * reached through `audit_logs_tenant_record_idx`.
 */
export async function redactAuditDiffs(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
): Promise<number> {
  const keys = redactableDiffKeys(objectType);
  // Built as an ARRAY[...] of individually bound parameters. Handing Drizzle a
  // JS array directly expands it into a row constructor, `($1, $2, ...)`, which
  // Postgres cannot cast to text[].
  const keyArray = sql`array[${sql.join(
    keys.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;

  const result = await tx.execute(sql`
    update audit_logs
    set changes = (
      select jsonb_object_agg(
        entry.key,
        case
          when entry.key = any(${keyArray}) then
            (case when entry.value ? 'old'
                  then jsonb_build_object('old', to_jsonb(${ERASED_PLACEHOLDER}::text))
                  else '{}'::jsonb end)
            ||
            (case when entry.value ? 'new'
                  then jsonb_build_object('new', to_jsonb(${ERASED_PLACEHOLDER}::text))
                  else '{}'::jsonb end)
          else entry.value
        end
      )
      from jsonb_each(audit_logs.changes) as entry
    )
    where tenant_id = ${tenantId}::uuid
      and object_type = ${objectType}
      and record_id = ${recordId}::uuid
      and changes is not null
      and changes <> '{}'::jsonb
      and exists (
        select 1 from jsonb_each(audit_logs.changes) as probe
        where probe.key = any(${keyArray})
      )
  `);

  return result.rowCount ?? 0;
}

/**
 * The tables a whole-tenant archive contains, in the order they are written
 * (MVP_SPEC M11).
 *
 * Records first, then the configuration that gives them meaning, then the
 * directory of who works here. A tenant archive that contained only records
 * would be unreadable — a picklist value with no picklist, a deal in a stage
 * nobody can name.
 *
 * Every one of these is tenant-scoped and RLS-protected, and the job runs
 * inside `withTenant`, so "only this tenant's data" is enforced by the database
 * rather than by this list being right. The security suite proves it by
 * exporting from a tenant that has a neighbour with similar data.
 *
 * `users` is the one table without a `tenant_id`: identity is global
 * (ADR-0014), and `crm_worker` may only see users who share a tenant with the
 * session, through the `users_same_tenant` policy. Its rows are therefore
 * selected by membership rather than by column.
 */
export const TENANT_ARCHIVE_TABLES = [
  'accounts',
  'contacts',
  'leads',
  'deals',
  'deal_contacts',
  'activities',
  'activity_links',
  'tags',
  'record_tags',
  'timeline_events',
  'email_messages',
  'email_message_links',
  'email_sender_config',
  'pipelines',
  'pipeline_stages',
  'field_definitions',
  'saved_views',
  'roles',
  'role_permissions',
  'field_permissions',
  'teams',
  'team_members',
  'memberships',
] as const;

export type TenantArchiveTable = (typeof TENANT_ARCHIVE_TABLES)[number];

/**
 * One page of a table, by id keyset.
 *
 * `id` is a UUIDv7 (ADR-0003), so ordering by it is close enough to insertion
 * order to be a sensible archive order, and it is the primary key on every one
 * of these tables — so paging is an index scan with no sort. Never OFFSET
 * (CLAUDE.md §7): an archive of a million-row table is exactly the case that
 * breaks.
 */
export async function selectArchivePage(
  tx: Tx,
  tenantId: string,
  table: TenantArchiveTable,
  afterId: string | null,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`
    select *
    from ${sql.identifier(table)}
    where tenant_id = ${tenantId}::uuid
      ${afterId === null ? sql`` : sql`and id > ${afterId}::uuid`}
    order by id
    limit ${limit}
  `);
  return result.rows;
}

/** The workspace's member directory, for the tenant archive. */
export async function selectMemberDirectory(
  tx: Tx,
  tenantId: string,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`
    select u.id, u.email::text as email, u.name, u.created_at, m.role_id, m.status, m.joined_at
    from memberships m
    join users u on u.id = m.user_id
    where m.tenant_id = ${tenantId}::uuid
    order by u.id
  `);
  return result.rows;
}

/**
 * Everything the workspace holds about one person (MVP_SPEC M11).
 *
 * A subject access request is answered with the record, what it is attached to,
 * and what has been done to it. Deliberately a fixed shape rather than a
 * traversal of every table that mentions the id: a traversal would quietly
 * start including whatever the next module adds, which for a file handed to a
 * data subject is the wrong direction to fail in.
 */
export async function selectSubjectRecord(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
): Promise<Record<string, unknown> | null> {
  const descriptor = descriptorFor(objectType);
  const result = await tx.execute(sql`
    select *
    from ${sql.identifier(descriptor.table)}
    where tenant_id = ${tenantId}::uuid and id = ${recordId}::uuid
    limit 1
  `);
  return result.rows[0] ?? null;
}

/** Activities linked to the subject, through the polymorphic link table (ADR-0005). */
export async function selectSubjectActivities(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`
    select a.id, a.type, a.subject, a.body, a.due_at, a.completed_at,
           a.status, a.priority, a.assigned_to, a.created_at
    from activities a
    join activity_links l on l.activity_id = a.id and l.tenant_id = a.tenant_id
    where a.tenant_id = ${tenantId}::uuid
      and l.object_type = ${objectType}
      and l.record_id = ${recordId}::uuid
    order by a.id
  `);
  return result.rows;
}

/** The emails sent to or about the subject, as the subject is entitled to see them (ADR-0073). */
export async function selectSubjectEmails(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`
    select m.id, m.status, m.from_name, m.to_address::text as to_address, m.subject, m.body_text,
           m.queued_at, m.sent_at, m.failure_code
    from email_messages m
    where m.tenant_id = ${tenantId}::uuid
      and (
        m.contact_id = ${recordId}::uuid
        or m.id in (
          select email_message_id from email_message_links
          where tenant_id = ${tenantId}::uuid
            and object_type = ${objectType}
            and record_id = ${recordId}::uuid
        )
      )
    order by m.id
  `);
  return result.rows;
}

/** The subject's timeline, and the tags on it. */
export async function selectSubjectTimeline(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`
    select id, event_type, actor_id, summary, detail, created_at
    from timeline_events
    where tenant_id = ${tenantId}::uuid
      and object_type = ${objectType}
      and record_id = ${recordId}::uuid
    order by created_at, id
  `);
  return result.rows;
}

export async function selectSubjectTags(
  tx: Tx,
  tenantId: string,
  objectType: ErasableObjectType,
  recordId: string,
): Promise<Record<string, unknown>[]> {
  const result = await tx.execute(sql`
    select t.id, t.name, t.color
    from record_tags rt
    join tags t on t.id = rt.tag_id and t.tenant_id = rt.tenant_id
    where rt.tenant_id = ${tenantId}::uuid
      and rt.object_type = ${objectType}
      and rt.record_id = ${recordId}::uuid
    order by t.id
  `);
  return result.rows;
}
