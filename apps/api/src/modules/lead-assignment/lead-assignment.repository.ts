import { Injectable } from '@nestjs/common';
import { and, asc, eq, leadAssignmentRules, leadAssignmentSettings, sql, type Tx } from '@crm/db';

export type RuleRow = typeof leadAssignmentRules.$inferSelect;
export type SettingsRow = typeof leadAssignmentSettings.$inferSelect;

function rows(result: { rows: unknown[] }): Record<string, unknown>[] {
  return result.rows as Record<string, unknown>[];
}

/**
 * Persistence for assignment rules (migration 0028, ADR-0065 10).
 *
 * Every statement names the tenant and runs under RLS. Not exported from the module.
 */
@Injectable()
export class LeadAssignmentRepository {
  async listRules(tx: Tx, tenantId: string): Promise<RuleRow[]> {
    return tx
      .select()
      .from(leadAssignmentRules)
      .where(eq(leadAssignmentRules.tenantId, tenantId))
      .orderBy(asc(leadAssignmentRules.position), asc(leadAssignmentRules.id));
  }

  async lockRule(tx: Tx, tenantId: string, id: string): Promise<RuleRow | null> {
    const found = await tx
      .select()
      .from(leadAssignmentRules)
      .where(and(eq(leadAssignmentRules.tenantId, tenantId), eq(leadAssignmentRules.id, id)))
      .limit(1)
      .for('update');
    return found[0] ?? null;
  }

  async nextPosition(tx: Tx, tenantId: string): Promise<number> {
    const result = await tx.execute(sql`
      select coalesce(max(position), 0) + 10 as next
      from lead_assignment_rules where tenant_id = ${tenantId}::uuid
    `);
    return Number(rows(result)[0]?.['next'] ?? 10);
  }

  async insertRule(tx: Tx, values: typeof leadAssignmentRules.$inferInsert): Promise<RuleRow> {
    const inserted = await tx.insert(leadAssignmentRules).values(values).returning();
    const row = inserted[0];
    if (row === undefined) throw new Error('The rule insert returned no row');
    return row;
  }

  async updateRule(
    tx: Tx,
    tenantId: string,
    id: string,
    patch: Partial<typeof leadAssignmentRules.$inferInsert>,
    by: string,
  ): Promise<RuleRow> {
    const updated = await tx
      .update(leadAssignmentRules)
      .set({
        ...patch,
        updatedAt: new Date(),
        updatedBy: by,
        version: sql`${leadAssignmentRules.version} + 1`,
      })
      .where(and(eq(leadAssignmentRules.tenantId, tenantId), eq(leadAssignmentRules.id, id)))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new Error('The rule update returned no row');
    return row;
  }

  async deleteRule(tx: Tx, tenantId: string, id: string): Promise<void> {
    await tx
      .delete(leadAssignmentRules)
      .where(and(eq(leadAssignmentRules.tenantId, tenantId), eq(leadAssignmentRules.id, id)));
  }

  /** Give the rules the positions 10, 20, 30... in this order. Not a version bump: a place is not an edit. */
  async writeOrder(tx: Tx, tenantId: string, ids: readonly string[]): Promise<void> {
    let position = 0;
    for (const id of ids) {
      position += 10;
      await tx.execute(sql`
        update lead_assignment_rules set position = ${position}, updated_at = now()
        where tenant_id = ${tenantId}::uuid and id = ${id}::uuid
      `);
    }
  }

  // ---- settings -----------------------------------------------------------------------------

  async findSettings(tx: Tx, tenantId: string): Promise<SettingsRow | null> {
    const found = await tx
      .select()
      .from(leadAssignmentSettings)
      .where(eq(leadAssignmentSettings.tenantId, tenantId))
      .limit(1);
    return found[0] ?? null;
  }

  /** The settings row, made if there is none, and locked: the same lock orders every rule change. */
  async lockSettings(tx: Tx, tenantId: string): Promise<SettingsRow> {
    await tx.execute(sql`
      insert into lead_assignment_settings (tenant_id) values (${tenantId}::uuid)
      on conflict (tenant_id) do nothing
    `);
    const found = await tx
      .select()
      .from(leadAssignmentSettings)
      .where(eq(leadAssignmentSettings.tenantId, tenantId))
      .limit(1)
      .for('update');
    const row = found[0];
    if (row === undefined) throw new Error('The settings row vanished');
    return row;
  }

  async setDefaultOwner(
    tx: Tx,
    tenantId: string,
    defaultOwnerId: string | null,
    by: string,
  ): Promise<SettingsRow> {
    const updated = await tx
      .update(leadAssignmentSettings)
      .set({
        defaultOwnerId,
        updatedAt: new Date(),
        updatedBy: by,
        version: sql`${leadAssignmentSettings.version} + 1`,
      })
      .where(eq(leadAssignmentSettings.tenantId, tenantId))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new Error('The settings update returned no row');
    return row;
  }

  // ---- round-robin pointers -----------------------------------------------------------------

  async readPointers(tx: Tx, tenantId: string): Promise<Map<string, string | null>> {
    const result = await tx.execute(sql`
      select rule_id, last_user_id from lead_assignment_pointers
      where tenant_id = ${tenantId}::uuid
    `);
    return new Map(
      rows(result).map((row) => [
        String(row['rule_id']),
        row['last_user_id'] === null ? null : String(row['last_user_id']),
      ]),
    );
  }

  /**
   * Take this rule's turn-keeper, waiting at most two seconds for it, and answer where it stands.
   *
   * The row is locked until the submission's transaction ends, so two submissions that both land on this
   * rule take their turns one after the other and cannot both be given the same person. The wait is
   * bounded: if it cannot be had, this throws, the caller's savepoint rolls back, and the lead goes to
   * the fallback rather than waiting for ever or being refused. The setting is put back afterwards, so
   * it does not leak into the rest of the transaction.
   */
  async lockPointer(tx: Tx, tenantId: string, ruleId: string): Promise<string | null> {
    const before = await tx.execute(sql`select current_setting('lock_timeout') as value`);
    const previous = String(rows(before)[0]?.['value'] ?? '0');
    await tx.execute(sql`select set_config('lock_timeout', '2s', true)`);
    try {
      await tx.execute(sql`
        insert into lead_assignment_pointers (tenant_id, rule_id)
        values (${tenantId}::uuid, ${ruleId}::uuid)
        on conflict (tenant_id, rule_id) do nothing
      `);
      const result = await tx.execute(sql`
        select last_user_id from lead_assignment_pointers
        where tenant_id = ${tenantId}::uuid and rule_id = ${ruleId}::uuid
        for update
      `);
      const last = rows(result)[0]?.['last_user_id'];
      return last === null || last === undefined ? null : String(last);
    } finally {
      await tx.execute(sql`select set_config('lock_timeout', ${previous}, true)`);
    }
  }

  async setPointer(tx: Tx, tenantId: string, ruleId: string, userId: string): Promise<void> {
    await tx.execute(sql`
      update lead_assignment_pointers set last_user_id = ${userId}::uuid, updated_at = now()
      where tenant_id = ${tenantId}::uuid and rule_id = ${ruleId}::uuid
    `);
  }
}
