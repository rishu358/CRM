import { Injectable } from '@nestjs/common';
import type { RecordCounts } from '@crm/contracts';
import { sql, type Tx } from '@crm/db';

export interface ProfileRow {
  readonly name: string;
  readonly defaultCurrency: string;
  readonly timezone: string;
  readonly locale: string;
  readonly industry: string | null;
  readonly setupCompletedAt: Date | null;
}

export interface ProfilePatch {
  readonly name?: string;
  readonly defaultCurrency?: string;
  readonly timezone?: string;
  readonly industry?: string | null;
}

export interface ChecklistFacts {
  readonly inviteTeam: boolean;
  readonly importContacts: boolean;
  readonly addFirstDeal: boolean;
  readonly setEmailSender: boolean;
}

/**
 * Data access for company setup (MVP_SPEC M2).
 *
 * The only table it writes is the caller's own `tenants` row, and only the
 * columns the application role holds UPDATE on (migration 0017). It reads the
 * rest — memberships, invitations, import jobs, deals, the sample registry —
 * only to answer "has this been done yet", which is why the checklist is derived
 * from what exists and never stored: a stored tick can disagree with the data,
 * and a derived one cannot.
 *
 * The statements are written as `sql` templates with every value bound; no name
 * or fragment comes from a caller (CLAUDE.md section 5.7).
 */
@Injectable()
export class OnboardingRepository {
  async findProfile(tx: Tx, tenantId: string): Promise<ProfileRow | null> {
    const result = await tx.execute(sql`
      select name, default_currency, timezone, locale, industry, setup_completed_at
      from tenants where id = ${tenantId}::uuid
    `);
    const row = result.rows[0] as
      | {
          name: string;
          default_currency: string;
          timezone: string;
          locale: string;
          industry: string | null;
          setup_completed_at: Date | string | null;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      name: row.name,
      defaultCurrency: row.default_currency,
      timezone: row.timezone,
      locale: row.locale,
      industry: row.industry,
      setupCompletedAt: row.setup_completed_at === null ? null : new Date(row.setup_completed_at),
    };
  }

  /** Only the columns present in `patch`, and `updated_at`. */
  async updateProfile(tx: Tx, tenantId: string, patch: ProfilePatch): Promise<void> {
    const assignments = [
      patch.name === undefined ? null : sql`name = ${patch.name}`,
      patch.defaultCurrency === undefined ? null : sql`default_currency = ${patch.defaultCurrency}`,
      patch.timezone === undefined ? null : sql`timezone = ${patch.timezone}`,
      patch.industry === undefined ? null : sql`industry = ${patch.industry}`,
    ].filter((fragment) => fragment !== null);
    if (assignments.length === 0) return;

    await tx.execute(sql`
      update tenants
      set ${sql.join(assignments, sql`, `)}, updated_at = now()
      where id = ${tenantId}::uuid
    `);
  }

  /**
   * Stamp completion once. Returns whether this call did it, so a repeated
   * request is a no-op that writes no audit row.
   */
  async markSetupComplete(tx: Tx, tenantId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      update tenants
      set setup_completed_at = now(), updated_at = now()
      where id = ${tenantId}::uuid and setup_completed_at is null
    `);
    return (result.rowCount ?? 0) > 0;
  }

  /** The checklist questions in one round trip. */
  async checklist(tx: Tx, tenantId: string): Promise<ChecklistFacts> {
    const result = await tx.execute(sql`
      select
        (
          exists (select 1 from invitations where tenant_id = ${tenantId}::uuid)
          or (select count(*) from memberships
              where tenant_id = ${tenantId}::uuid and status = 'active') > 1
        ) as invite_team,
        exists (
          select 1 from import_jobs
          where tenant_id = ${tenantId}::uuid and status = 'completed'
        ) as import_contacts,
        -- "your first deal" is one a person made, not one that came with the sample data.
        exists (
          select 1 from deals d
          where d.tenant_id = ${tenantId}::uuid
            and d.deleted_at is null
            and not exists (
              select 1 from sample_records s
              where s.tenant_id = d.tenant_id
                and s.object_type = 'deal'
                and s.record_id = d.id
            )
        ) as add_first_deal,
        -- The company has saved how its emails to customers are sent (ADR-0073).
        exists (
          select 1 from email_sender_config where tenant_id = ${tenantId}::uuid
        ) as set_email_sender
    `);
    const row = result.rows[0] as {
      invite_team: boolean;
      import_contacts: boolean;
      add_first_deal: boolean;
      set_email_sender: boolean;
    };
    return {
      inviteTeam: row.invite_team,
      importContacts: row.import_contacts,
      addFirstDeal: row.add_first_deal,
      setEmailSender: row.set_email_sender,
    };
  }

  /** How many records of each kind are still registered as sample data. */
  async sampleCounts(tx: Tx, tenantId: string): Promise<RecordCounts> {
    const result = await tx.execute(sql`
      select object_type, count(*)::int as n
      from sample_records where tenant_id = ${tenantId}::uuid
      group by object_type
    `);
    const byType = new Map(
      (result.rows as unknown as { object_type: string; n: number }[]).map((row) => [
        row.object_type,
        row.n,
      ]),
    );
    return {
      accounts: byType.get('account') ?? 0,
      contacts: byType.get('contact') ?? 0,
      leads: byType.get('lead') ?? 0,
      deals: byType.get('deal') ?? 0,
      activities: byType.get('activity') ?? 0,
    };
  }

  /**
   * Is a removal asked for and not yet done?
   *
   * The outbox row *is* the state. Nothing separate records "removing", so there
   * is nothing to forget to clear if the job fails or is retried, and a second
   * request while one is pending can see it and do nothing.
   */
  async removalPending(tx: Tx, tenantId: string): Promise<boolean> {
    const result = await tx.execute(sql`
      select exists (
        select 1 from outbox_events
        where tenant_id = ${tenantId}::uuid
          and event_type = 'sample_data.removal_requested.v1'
          and status in ('pending', 'processing')
      ) as pending
    `);
    return (result.rows[0] as { pending: boolean }).pending;
  }
}
