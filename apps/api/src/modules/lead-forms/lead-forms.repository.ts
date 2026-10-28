import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  isNull,
  leadFormConsentTexts,
  leadFormKeys,
  leadFormSubmissions,
  leadForms,
  sql,
  tenants,
  type LeadFormKeyRow,
  type LeadFormRow,
  type Tx,
} from '@crm/db';

/**
 * Persistence for website lead forms (ADR-0063).
 *
 * Every statement filters on `tenant_id` explicitly **and** runs under RLS, so a form or key from
 * another workspace reads as absent either way. The one statement that runs without a tenant is
 * `routeKey`, which runs as `crm_auth` and can read five columns of one table (migration 0027).
 *
 * Not exported from the module (CLAUDE.md §3).
 */

export interface FormStats {
  readonly today: number;
  readonly last7Days: number;
  readonly total: number;
  readonly lastSubmittedAt: Date | null;
}

export interface RoutedKey {
  readonly tenantId: string;
  readonly formId: string;
}

function rows(result: { rows: unknown[] }): Record<string, unknown>[] {
  return result.rows as Record<string, unknown>[];
}

@Injectable()
export class LeadFormsRepository {
  // -------------------------------------------------------------------------
  // The one cross-tenant read: a key to (workspace, form)
  // -------------------------------------------------------------------------

  /**
   * Which workspace and form does this key open? Run as `crm_auth`, with no tenant context.
   *
   * It answers only for a key that is not revoked and not past its retirement, in a workspace that is
   * active. It selects exactly the five columns `crm_auth` is granted, and returns two of them.
   */
  async routeKey(tx: Tx, keyHash: Buffer): Promise<RoutedKey | null> {
    const result = await tx.execute(sql`
      select k.tenant_id, k.form_id
      from lead_form_keys k
      join tenants t on t.id = k.tenant_id
      where k.key_hash = ${keyHash}
        and k.revoked_at is null
        and (k.retires_at is null or k.retires_at > now())
        and t.status = 'active'
        and t.deleted_at is null
      limit 1
    `);
    const row = rows(result)[0];
    return row === undefined
      ? null
      : { tenantId: String(row['tenant_id']), formId: String(row['form_id']) };
  }

  // -------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------

  async list(tx: Tx, tenantId: string): Promise<LeadFormRow[]> {
    return tx
      .select()
      .from(leadForms)
      .where(and(eq(leadForms.tenantId, tenantId), isNull(leadForms.deletedAt)))
      .orderBy(asc(leadForms.createdAt), asc(leadForms.id));
  }

  async findById(tx: Tx, tenantId: string, id: string): Promise<LeadFormRow | null> {
    const found = await tx
      .select()
      .from(leadForms)
      .where(
        and(eq(leadForms.tenantId, tenantId), eq(leadForms.id, id), isNull(leadForms.deletedAt)),
      )
      .limit(1);
    return found[0] ?? null;
  }

  /** The same, locking the row so two edits to one form run one after the other. */
  async lockById(tx: Tx, tenantId: string, id: string): Promise<LeadFormRow | null> {
    const found = await tx
      .select()
      .from(leadForms)
      .where(
        and(eq(leadForms.tenantId, tenantId), eq(leadForms.id, id), isNull(leadForms.deletedAt)),
      )
      .limit(1)
      .for('update');
    return found[0] ?? null;
  }

  async count(tx: Tx, tenantId: string): Promise<number> {
    const result = await tx.execute(sql`
      select count(*)::int as n from lead_forms
      where tenant_id = ${tenantId}::uuid and deleted_at is null
    `);
    return Number(rows(result)[0]?.['n'] ?? 0);
  }

  async insert(tx: Tx, values: typeof leadForms.$inferInsert): Promise<LeadFormRow> {
    const inserted = await tx.insert(leadForms).values(values).returning();
    const row = inserted[0];
    if (row === undefined) throw new Error('The form insert returned no row');
    return row;
  }

  async update(
    tx: Tx,
    tenantId: string,
    id: string,
    patch: Partial<typeof leadForms.$inferInsert>,
    by: string,
  ): Promise<LeadFormRow> {
    const updated = await tx
      .update(leadForms)
      .set({
        ...patch,
        updatedAt: new Date(),
        updatedBy: by,
        version: sql`${leadForms.version} + 1`,
      })
      .where(and(eq(leadForms.tenantId, tenantId), eq(leadForms.id, id)))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new Error('The form update returned no row');
    return row;
  }

  async softDelete(tx: Tx, tenantId: string, id: string, by: string): Promise<void> {
    await tx
      .update(leadForms)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: by,
        version: sql`${leadForms.version} + 1`,
      })
      .where(and(eq(leadForms.tenantId, tenantId), eq(leadForms.id, id)));
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  async insertKey(tx: Tx, values: typeof leadFormKeys.$inferInsert): Promise<void> {
    await tx.insert(leadFormKeys).values(values);
  }

  /** The keys that open the form now, newest first. */
  async liveKeys(tx: Tx, tenantId: string, formIds: readonly string[]): Promise<LeadFormKeyRow[]> {
    if (formIds.length === 0) return [];
    const found = await tx
      .select()
      .from(leadFormKeys)
      .where(
        and(
          eq(leadFormKeys.tenantId, tenantId),
          sql`${leadFormKeys.formId} in (${sql.join(
            formIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
          isNull(leadFormKeys.revokedAt),
          sql`(${leadFormKeys.retiresAt} is null or ${leadFormKeys.retiresAt} > now())`,
        ),
      );
    return found.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Stop keys working: now, or at a moment of the database's choosing. */
  async retireKeys(
    tx: Tx,
    tenantId: string,
    keyIds: readonly string[],
    graceSeconds: number,
    by: string,
  ): Promise<void> {
    if (keyIds.length === 0) return;
    const idList = sql.join(
      keyIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    if (graceSeconds <= 0) {
      await tx.execute(sql`
        update lead_form_keys
           set revoked_at = now(), updated_at = now(), updated_by = ${by}::uuid
         where tenant_id = ${tenantId}::uuid and id in (${idList}) and revoked_at is null
      `);
      return;
    }
    await tx.execute(sql`
      update lead_form_keys
         set retires_at = now() + make_interval(secs => ${graceSeconds}),
             updated_at = now(), updated_by = ${by}::uuid
       where tenant_id = ${tenantId}::uuid and id in (${idList}) and revoked_at is null
    `);
  }

  async revokeAllKeys(tx: Tx, tenantId: string, formId: string, by: string): Promise<void> {
    await tx.execute(sql`
      update lead_form_keys
         set revoked_at = now(), updated_at = now(), updated_by = ${by}::uuid
       where tenant_id = ${tenantId}::uuid and form_id = ${formId}::uuid and revoked_at is null
    `);
  }

  // -------------------------------------------------------------------------
  // Consent wording
  // -------------------------------------------------------------------------

  async insertConsentText(tx: Tx, values: typeof leadFormConsentTexts.$inferInsert): Promise<void> {
    await tx.insert(leadFormConsentTexts).values(values);
  }

  // -------------------------------------------------------------------------
  // What the forms have made
  // -------------------------------------------------------------------------

  async stats(
    tx: Tx,
    tenantId: string,
    formIds: readonly string[],
  ): Promise<Map<string, FormStats>> {
    const out = new Map<string, FormStats>();
    if (formIds.length === 0) return out;
    // "Today" is the UTC day, the same day the daily cap counts.
    const result = await tx.execute(sql`
      select form_id,
             count(*)::int as total,
             count(*) filter (where created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc')::int as today,
             count(*) filter (where created_at >= now() - interval '7 days')::int as last7,
             max(created_at) as last_at
      from lead_form_submissions
      where tenant_id = ${tenantId}::uuid
        and form_id in (${sql.join(
          formIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      group by form_id
    `);
    for (const row of rows(result)) {
      const last = row['last_at'];
      out.set(String(row['form_id']), {
        today: Number(row['today']),
        last7Days: Number(row['last7']),
        total: Number(row['total']),
        lastSubmittedAt:
          last === null || last === undefined
            ? null
            : last instanceof Date
              ? last
              : new Date(last as string),
      });
    }
    return out;
  }

  async findSubmissionByKeyHash(
    tx: Tx,
    tenantId: string,
    formId: string,
    hash: Buffer,
  ): Promise<{ id: string } | null> {
    const found = await tx
      .select({ id: leadFormSubmissions.id })
      .from(leadFormSubmissions)
      .where(
        and(
          eq(leadFormSubmissions.tenantId, tenantId),
          eq(leadFormSubmissions.formId, formId),
          eq(leadFormSubmissions.idempotencyHash, hash),
        ),
      )
      .limit(1);
    return found[0] ?? null;
  }

  async insertSubmission(tx: Tx, values: typeof leadFormSubmissions.$inferInsert): Promise<void> {
    await tx.insert(leadFormSubmissions).values(values);
  }

  /**
   * Take one from a day's allowance, or say there is none left.
   *
   * One atomic statement: two submissions racing for the last place cannot both win, because the second
   * waits on the row and then re-reads a count that is already at the cap. It runs in the submission's
   * own transaction, so a refused submission leaves no count behind and an accepted one counts exactly once.
   */
  async takeFromDailyCap(
    tx: Tx,
    tenantId: string,
    counterKey: string,
    cap: number,
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      insert into lead_form_daily_counts as c (tenant_id, counter_key, day, count)
      values (${tenantId}::uuid, ${counterKey}, (now() at time zone 'utc')::date, 1)
      on conflict (tenant_id, counter_key, day)
      do update set count = c.count + 1, updated_at = now()
        where c.count < ${cap}
      returning c.count
    `);
    return rows(result).length > 0;
  }

  // -------------------------------------------------------------------------
  // The workspace-wide pause
  // -------------------------------------------------------------------------

  async isPaused(tx: Tx, tenantId: string): Promise<boolean> {
    const found = await tx
      .select({
        paused: sql<boolean>`coalesce((${tenants.settings} ->> 'lead_forms_paused')::boolean, false)`,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return found[0]?.paused ?? false;
  }

  async setPaused(tx: Tx, tenantId: string, paused: boolean): Promise<void> {
    await tx.execute(sql`
      update tenants
         set settings = jsonb_set(settings, '{lead_forms_paused}', to_jsonb(${paused}::boolean), true),
             updated_at = now()
       where id = ${tenantId}::uuid
    `);
  }

  /** The workspace's locale, for pre-filling the calling code. */
  async locale(tx: Tx, tenantId: string): Promise<string | null> {
    const found = await tx
      .select({ locale: tenants.locale })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return found[0]?.locale ?? null;
  }
}
