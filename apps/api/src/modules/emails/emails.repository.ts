import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  emailMessageLinks,
  emailMessages,
  emailPauses,
  emailSenderConfig,
  emailSignatures,
  emailSuppressions,
  emailTemplates,
  eq,
  inArray,
  isNull,
  sql,
  tenants,
  users,
  type EmailMessageLinkRow,
  type EmailMessageRow,
  type EmailPauseRow,
  type EmailSenderConfigRow,
  type EmailSignatureRow,
  type EmailSuppressionRow,
  type EmailTemplateRow,
  type NewEmailMessageRow,
  type Tx,
} from '@crm/db';
import type { Cursor } from '../../common/cursor.js';
import { keysetPredicate } from '../../common/keyset.js';

/** One row of a record's email list, with who sent it and whether it was tried again. */
export interface EmailListRow {
  readonly message: EmailMessageRow;
  readonly sentByName: string | null;
  readonly retriedById: string | null;
  /** The created-at instant at full precision, as text: the keyset cursor's value. */
  readonly cursorValue: string;
}

export interface TenantFacts {
  readonly name: string;
  readonly timezone: string;
  readonly createdAt: Date;
}

/**
 * The email module's statements (ADR-0001, ADR-0073). Every one names the tenant as well as relying
 * on row-level security. This module may INSERT a message and never UPDATE one: that is the worker's
 * word, and the database grant says so.
 */
@Injectable()
export class EmailsRepository {
  async insertMessage(tx: Tx, values: NewEmailMessageRow): Promise<EmailMessageRow> {
    const [row] = await tx.insert(emailMessages).values(values).returning();
    if (row === undefined) throw new Error('The email was not stored');
    return row;
  }

  async insertLinks(
    tx: Tx,
    rows: readonly (typeof emailMessageLinks.$inferInsert)[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(emailMessageLinks).values([...rows]);
  }

  async findMessage(tx: Tx, tenantId: string, id: string): Promise<EmailMessageRow | null> {
    const rows = await tx
      .select()
      .from(emailMessages)
      .where(and(eq(emailMessages.tenantId, tenantId), eq(emailMessages.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async linksOf(
    tx: Tx,
    tenantId: string,
    messageId: string,
  ): Promise<Pick<EmailMessageLinkRow, 'objectType' | 'recordId'>[]> {
    return tx
      .select({ objectType: emailMessageLinks.objectType, recordId: emailMessageLinks.recordId })
      .from(emailMessageLinks)
      .where(
        and(
          eq(emailMessageLinks.tenantId, tenantId),
          eq(emailMessageLinks.emailMessageId, messageId),
        ),
      );
  }

  /** The id of the email that tried this one again, if any. */
  async retryOf(tx: Tx, tenantId: string, id: string): Promise<string | null> {
    const rows = await tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(and(eq(emailMessages.tenantId, tenantId), eq(emailMessages.retryOf, id)))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /** Who wrote these messages, by name: one query for the page. */
  async senderNames(tx: Tx, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, [...userIds]));
    return new Map(rows.map((row) => [row.id, row.name]));
  }

  /**
   * A page of the emails linked to one record, newest first.
   *
   * The caller has already shown the record is visible to the reader; this only reads. `limit + 1`
   * rows come back so the service can tell whether there is another page.
   */
  async listForRecord(
    tx: Tx,
    tenantId: string,
    objectType: string,
    recordId: string,
    cursor: Cursor | null,
    limit: number,
  ): Promise<EmailListRow[]> {
    const keyset =
      cursor === null ? sql`true` : keysetPredicate(sql`m.created_at`, sql`m.id`, 'desc', cursor);
    const result = await tx.execute(sql`
      select m.id, m.created_at::text as cursor_value,
             u.name as sent_by_name,
             (select r.id from email_messages r
               where r.tenant_id = m.tenant_id and r.retry_of = m.id limit 1) as retried_by_id
      from email_message_links l
      join email_messages m on m.tenant_id = l.tenant_id and m.id = l.email_message_id
      left join users u on u.id = m.created_by
      where l.tenant_id = ${tenantId}::uuid
        and l.object_type = ${objectType}
        and l.record_id = ${recordId}::uuid
        and ${keyset}
      order by m.created_at desc, m.id desc
      limit ${limit + 1}
    `);
    const found = result.rows as unknown as {
      id: string;
      cursor_value: string;
      sent_by_name: string | null;
      retried_by_id: string | null;
    }[];
    if (found.length === 0) return [];

    const rows = await tx
      .select()
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.tenantId, tenantId),
          inArray(
            emailMessages.id,
            found.map((row) => row.id),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const page: EmailListRow[] = [];
    for (const row of found) {
      const message = byId.get(row.id);
      if (message === undefined) continue;
      page.push({
        message,
        sentByName: row.sent_by_name,
        retriedById: row.retried_by_id,
        cursorValue: row.cursor_value,
      });
    }
    return page;
  }

  // ---- sender configuration -------------------------------------------------------------------

  async findConfig(tx: Tx, tenantId: string): Promise<EmailSenderConfigRow | null> {
    const rows = await tx
      .select()
      .from(emailSenderConfig)
      .where(eq(emailSenderConfig.tenantId, tenantId))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertConfig(
    tx: Tx,
    values: typeof emailSenderConfig.$inferInsert,
  ): Promise<EmailSenderConfigRow | null> {
    const rows = await tx
      .insert(emailSenderConfig)
      .values(values)
      .onConflictDoNothing({ target: emailSenderConfig.tenantId })
      .returning();
    return rows[0] ?? null;
  }

  async updateConfig(
    tx: Tx,
    args: {
      tenantId: string;
      version: number;
      userId: string;
      fromName: string;
      replyTo: string | null;
      footerText: string | null;
    },
  ): Promise<EmailSenderConfigRow | null> {
    const rows = await tx
      .update(emailSenderConfig)
      .set({
        fromName: args.fromName,
        replyTo: args.replyTo,
        footerText: args.footerText,
        version: args.version + 1,
        updatedAt: new Date(),
        updatedBy: args.userId,
      })
      .where(
        and(
          eq(emailSenderConfig.tenantId, args.tenantId),
          eq(emailSenderConfig.version, args.version),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  // ---- the caps ---------------------------------------------------------------------------------

  /**
   * Serialise this workspace's sends for the day, so the company cap cannot be passed by two
   * people at once. Held to the end of the transaction, which is short.
   */
  async lockTenantDay(tx: Tx, tenantId: string, day: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`email:${tenantId}:${day}`}, 0))`,
    );
  }

  async sentToday(
    tx: Tx,
    tenantId: string,
    userId: string,
    day: string,
  ): Promise<{ user: number; tenant: number }> {
    const result = await tx.execute(sql`
      select coalesce(sum(sent), 0)::int as tenant,
             coalesce(sum(sent) filter (where user_id = ${userId}::uuid), 0)::int as mine
      from email_daily_counts
      where tenant_id = ${tenantId}::uuid and day = ${day}::date
    `);
    const row = result.rows[0] as unknown as { tenant: number; mine: number } | undefined;
    return { user: row?.mine ?? 0, tenant: row?.tenant ?? 0 };
  }

  /** Add one to this person's count for the day, unless it is already at `limit`. False means at the cap. */
  async spendOne(
    tx: Tx,
    tenantId: string,
    userId: string,
    day: string,
    limit: number,
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      insert into email_daily_counts as c (tenant_id, user_id, day, sent, created_at, updated_at)
      values (${tenantId}::uuid, ${userId}::uuid, ${day}::date, 1, now(), now())
      on conflict (tenant_id, user_id, day)
      do update set sent = c.sent + 1, updated_at = now()
      where c.sent < ${limit}
      returning c.sent
    `);
    return result.rows.length > 0;
  }

  /** How many emails this person has queued in the last minute. */
  async startedInLastMinute(tx: Tx, tenantId: string, userId: string): Promise<number> {
    const result = await tx.execute(sql`
      select count(*)::int as n from email_messages
      where tenant_id = ${tenantId}::uuid
        and created_by = ${userId}::uuid
        and created_at > now() - interval '1 minute'
    `);
    return (result.rows[0] as unknown as { n: number } | undefined)?.n ?? 0;
  }

  // ---- facts about the workspace and the person -------------------------------------------------

  async tenantFacts(tx: Tx, tenantId: string): Promise<TenantFacts> {
    const rows = await tx
      .select({ name: tenants.name, timezone: tenants.timezone, createdAt: tenants.createdAt })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new Error('The workspace could not be read');
    return row;
  }

  async userFacts(tx: Tx, userId: string): Promise<{ email: string; name: string } | null> {
    const rows = await tx
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  // ---- templates (ADR-0074) --------------------------------------------------------------------------

  async listTemplates(tx: Tx, tenantId: string): Promise<EmailTemplateRow[]> {
    return tx
      .select()
      .from(emailTemplates)
      .where(and(eq(emailTemplates.tenantId, tenantId), isNull(emailTemplates.deletedAt)))
      .orderBy(asc(sql`lower(${emailTemplates.name})`), asc(emailTemplates.id));
  }

  async findTemplate(tx: Tx, tenantId: string, id: string): Promise<EmailTemplateRow | null> {
    const rows = await tx
      .select()
      .from(emailTemplates)
      .where(
        and(
          eq(emailTemplates.tenantId, tenantId),
          eq(emailTemplates.id, id),
          isNull(emailTemplates.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async countTemplates(tx: Tx, tenantId: string): Promise<number> {
    const result = await tx.execute(sql`
      select count(*)::int as n from email_templates
      where tenant_id = ${tenantId}::uuid and deleted_at is null
    `);
    return (result.rows[0] as unknown as { n: number } | undefined)?.n ?? 0;
  }

  async insertTemplate(
    tx: Tx,
    values: typeof emailTemplates.$inferInsert,
  ): Promise<EmailTemplateRow> {
    const [row] = await tx.insert(emailTemplates).values(values).returning();
    if (row === undefined) throw new Error('The template was not stored');
    return row;
  }

  /** The update, only if the template is still at the version the caller read. Null means it is not. */
  async updateTemplate(
    tx: Tx,
    args: {
      tenantId: string;
      id: string;
      version: number;
      userId: string;
      patch: { name?: string; subject?: string; bodyText?: string };
    },
  ): Promise<EmailTemplateRow | null> {
    const rows = await tx
      .update(emailTemplates)
      .set({
        ...args.patch,
        version: args.version + 1,
        updatedAt: new Date(),
        updatedBy: args.userId,
      })
      .where(
        and(
          eq(emailTemplates.tenantId, args.tenantId),
          eq(emailTemplates.id, args.id),
          eq(emailTemplates.version, args.version),
          isNull(emailTemplates.deletedAt),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  async softDeleteTemplate(
    tx: Tx,
    args: { tenantId: string; id: string; version: number; userId: string },
  ): Promise<boolean> {
    const rows = await tx
      .update(emailTemplates)
      .set({
        deletedAt: new Date(),
        version: args.version + 1,
        updatedAt: new Date(),
        updatedBy: args.userId,
      })
      .where(
        and(
          eq(emailTemplates.tenantId, args.tenantId),
          eq(emailTemplates.id, args.id),
          eq(emailTemplates.version, args.version),
          isNull(emailTemplates.deletedAt),
        ),
      )
      .returning({ id: emailTemplates.id });
    return rows.length > 0;
  }

  // ---- signatures ------------------------------------------------------------------------------------

  async findSignature(tx: Tx, tenantId: string, userId: string): Promise<EmailSignatureRow | null> {
    const rows = await tx
      .select()
      .from(emailSignatures)
      .where(and(eq(emailSignatures.tenantId, tenantId), eq(emailSignatures.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertSignature(
    tx: Tx,
    values: typeof emailSignatures.$inferInsert,
  ): Promise<EmailSignatureRow | null> {
    const rows = await tx
      .insert(emailSignatures)
      .values(values)
      .onConflictDoNothing({ target: [emailSignatures.tenantId, emailSignatures.userId] })
      .returning();
    return rows[0] ?? null;
  }

  async updateSignature(
    tx: Tx,
    args: { tenantId: string; userId: string; version: number; text: string },
  ): Promise<EmailSignatureRow | null> {
    const rows = await tx
      .update(emailSignatures)
      .set({
        signatureText: args.text,
        version: args.version + 1,
        updatedAt: new Date(),
        updatedBy: args.userId,
      })
      .where(
        and(
          eq(emailSignatures.tenantId, args.tenantId),
          eq(emailSignatures.userId, args.userId),
          eq(emailSignatures.version, args.version),
        ),
      )
      .returning();
    return rows[0] ?? null;
  }

  // ---- the block list and the pause (ADR-0075) -------------------------------------------------------

  /** The live block on this address (by its hash), if there is one. */
  async findLiveSuppression(
    tx: Tx,
    tenantId: string,
    addressHash: Buffer,
  ): Promise<EmailSuppressionRow | null> {
    const rows = await tx
      .select()
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.tenantId, tenantId),
          eq(emailSuppressions.addressHash, addressHash),
          isNull(emailSuppressions.liftedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findSuppression(tx: Tx, tenantId: string, id: string): Promise<EmailSuppressionRow | null> {
    const rows = await tx
      .select()
      .from(emailSuppressions)
      .where(and(eq(emailSuppressions.tenantId, tenantId), eq(emailSuppressions.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** The live blocks, newest first, with the address from the email that caused each while it still holds one. */
  async listLiveSuppressions(
    tx: Tx,
    tenantId: string,
  ): Promise<{ row: EmailSuppressionRow; address: string | null }[]> {
    const result = await tx.execute(sql`
      select s.id, m.to_address::text as address
      from email_suppressions s
      left join email_messages m on m.tenant_id = s.tenant_id and m.id = s.source_email_id
      where s.tenant_id = ${tenantId}::uuid and s.lifted_at is null
      order by s.created_at desc, s.id desc
      limit 500
    `);
    const found = result.rows as unknown as { id: string; address: string | null }[];
    if (found.length === 0) return [];
    const rows = await tx
      .select()
      .from(emailSuppressions)
      .where(
        and(
          eq(emailSuppressions.tenantId, tenantId),
          inArray(
            emailSuppressions.id,
            found.map((entry) => entry.id),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const listed: { row: EmailSuppressionRow; address: string | null }[] = [];
    for (const entry of found) {
      const row = byId.get(entry.id);
      if (row !== undefined) listed.push({ row, address: entry.address });
    }
    return listed;
  }

  async liftSuppression(
    tx: Tx,
    args: { tenantId: string; id: string; userId: string },
  ): Promise<boolean> {
    const rows = await tx
      .update(emailSuppressions)
      .set({
        liftedAt: new Date(),
        liftedBy: args.userId,
        updatedAt: new Date(),
        updatedBy: args.userId,
      })
      .where(
        and(
          eq(emailSuppressions.tenantId, args.tenantId),
          eq(emailSuppressions.id, args.id),
          isNull(emailSuppressions.liftedAt),
        ),
      )
      .returning({ id: emailSuppressions.id });
    return rows.length > 0;
  }

  async findLivePause(tx: Tx, tenantId: string): Promise<EmailPauseRow | null> {
    const rows = await tx
      .select()
      .from(emailPauses)
      .where(and(eq(emailPauses.tenantId, tenantId), isNull(emailPauses.resumedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async resumePause(tx: Tx, args: { tenantId: string; userId: string }): Promise<boolean> {
    const rows = await tx
      .update(emailPauses)
      .set({
        resumedAt: new Date(),
        resumedBy: args.userId,
        updatedAt: new Date(),
        updatedBy: args.userId,
      })
      .where(and(eq(emailPauses.tenantId, args.tenantId), isNull(emailPauses.resumedAt)))
      .returning({ id: emailPauses.id });
    return rows.length > 0;
  }
}
