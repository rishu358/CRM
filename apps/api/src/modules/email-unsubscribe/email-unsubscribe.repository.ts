import { Injectable } from '@nestjs/common';
import { emailProviderEvents, sql, type Tx } from '@crm/db';

/**
 * The unsubscribe door's three statements (ADR-0076). The first runs as the platform's routing role and reads
 * two columns of one table; the other two run as the application role inside the company the first one named.
 * Nothing else in this module touches the database.
 */
@Injectable()
export class EmailUnsubscribeRepository {
  /**
   * Which company an email belongs to, or null. The email id comes from a token whose signature has already
   * been checked, so a stranger cannot make this look for an id of their choosing. A suspended or deleted
   * company is null too.
   */
  async routeEmailId(tx: Tx, emailId: string): Promise<{ tenantId: string } | null> {
    const result = await tx.execute(sql`
      select m.tenant_id
      from email_messages m
      join tenants t on t.id = m.tenant_id
      where m.id = ${emailId}::uuid
        and t.status = 'active'
        and t.deleted_at is null
      limit 1
    `);
    const row = (result.rows as unknown as { tenant_id: string }[])[0];
    return row === undefined ? null : { tenantId: row.tenant_id };
  }

  /**
   * The name the email was sent under, which is what the page says ("Stop emails from ..."). It is the
   * company's own sender name, not a person's. Null when the email is not in this company.
   */
  async senderNameOf(tx: Tx, tenantId: string, emailId: string): Promise<string | null> {
    const result = await tx.execute(sql`
      select from_name
      from email_messages
      where tenant_id = ${tenantId}::uuid and id = ${emailId}::uuid
      limit 1
    `);
    const row = (result.rows as unknown as { from_name: string }[])[0];
    return row?.from_name ?? null;
  }

  /** Record that this email's link was used. False means it had been used before: a repeat. */
  async insertEvent(tx: Tx, values: typeof emailProviderEvents.$inferInsert): Promise<boolean> {
    const rows = await tx
      .insert(emailProviderEvents)
      .values(values)
      .onConflictDoNothing({
        target: [
          emailProviderEvents.tenantId,
          emailProviderEvents.provider,
          emailProviderEvents.providerEventId,
        ],
      })
      .returning({ id: emailProviderEvents.id });
    return rows.length > 0;
  }
}
