import { Injectable } from '@nestjs/common';
import { emailProviderEvents, sql, type Tx } from '@crm/db';

/**
 * The events door's two statements (ADR-0075). The first runs as the platform's routing role and reads
 * three columns of one table; the second runs as the application role inside the company the first one
 * named. Nothing else in this module touches the database.
 */
@Injectable()
export class EmailEventsRepository {
  /**
   * Which company and which email a provider's id belongs to, or null.
   *
   * An id that matches nothing, or matches more than one row (it should not, but a refusal at write
   * time would have broken the send), is null: an ambiguous id is never guessed at. A suspended or
   * deleted company is null too.
   */
  async routeProviderId(
    tx: Tx,
    providerMessageId: string,
  ): Promise<{ tenantId: string; messageId: string } | null> {
    const result = await tx.execute(sql`
      select m.tenant_id, m.id
      from email_messages m
      join tenants t on t.id = m.tenant_id
      where m.provider_message_id = ${providerMessageId}
        and t.status = 'active'
        and t.deleted_at is null
      limit 2
    `);
    const rows = result.rows as unknown as { tenant_id: string; id: string }[];
    const only = rows.length === 1 ? rows[0] : undefined;
    return only === undefined ? null : { tenantId: only.tenant_id, messageId: only.id };
  }

  /** Record that this event was received. False means it had been received before: a replay. */
  async insertProviderEvent(
    tx: Tx,
    values: typeof emailProviderEvents.$inferInsert,
  ): Promise<boolean> {
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
