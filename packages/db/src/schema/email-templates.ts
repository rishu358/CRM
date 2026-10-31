import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Email templates and signatures (migration 0033, ADR-0074).
 *
 * Plain text only, like the emails themselves. Merge fields are checked by the API against a closed
 * list; the database holds lengths, so adding a field needs no migration.
 */

export const emailTemplates = pgTable(
  'email_templates',
  {
    ...baseColumns,
    name: text('name').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    version: integer('version').notNull().default(1),
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [
    index('email_templates_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export const emailSignatures = pgTable(
  'email_signatures',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    signatureText: text('signature_text').notNull(),
    version: integer('version').notNull().default(1),
  },
  (table) => [uniqueIndex('email_signatures_tenant_user_key').on(table.tenantId, table.userId)],
);

export type EmailTemplateRow = typeof emailTemplates.$inferSelect;
export type EmailSignatureRow = typeof emailSignatures.$inferSelect;
