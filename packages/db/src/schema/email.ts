import {
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, citext, timestamptz } from './columns.js';

/**
 * Email sent from a record, and the log of it (migration 0032, ADR-0073).
 *
 * Read the migration's header before changing any of this: the application role may INSERT and SELECT
 * `email_messages` and nothing else, so only the worker can say what the provider did.
 */

export const emailMessages = pgTable(
  'email_messages',
  {
    ...baseColumns,
    direction: text('direction').$type<'outbound' | 'inbound'>().notNull().default('outbound'),
    status: text('status')
      .$type<'queued' | 'sending' | 'sent' | 'failed' | 'delivered' | 'bounced' | 'complained'>()
      .notNull()
      .default('queued'),
    sourceObjectType: text('source_object_type').$type<'contact' | 'lead' | 'deal'>().notNull(),
    sourceRecordId: uuid('source_record_id').notNull(),
    contactId: uuid('contact_id'),
    fromName: text('from_name').notNull(),
    fromAddress: text('from_address').notNull(),
    replyTo: citext('reply_to'),
    toAddress: citext('to_address'),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    messageId: text('message_id').notNull(),
    providerMessageId: text('provider_message_id'),
    failureCode: text('failure_code'),
    /** Why a bounced message bounced, from a closed list; set by the worker from the provider's event. */
    bounceReason: text('bounce_reason'),
    attempts: integer('attempts').notNull().default(0),
    retryOf: uuid('retry_of'),
    queuedAt: timestamptz('queued_at').notNull(),
    sendingStartedAt: timestamptz('sending_started_at'),
    sentAt: timestamptz('sent_at'),
    failedAt: timestamptz('failed_at'),
    erasedAt: timestamptz('erased_at'),
  },
  (table) => [
    uniqueIndex('email_messages_tenant_message_id_key').on(table.tenantId, table.messageId),
    index('email_messages_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export const emailMessageLinks = pgTable(
  'email_message_links',
  {
    ...baseColumns,
    emailMessageId: uuid('email_message_id').notNull(),
    objectType: text('object_type').notNull(),
    recordId: uuid('record_id').notNull(),
  },
  (table) => [
    uniqueIndex('email_message_links_unique').on(
      table.tenantId,
      table.emailMessageId,
      table.objectType,
      table.recordId,
    ),
    index('email_message_links_target_idx').on(
      table.tenantId,
      table.objectType,
      table.recordId,
      table.emailMessageId,
    ),
  ],
);

export const emailSenderConfig = pgTable('email_sender_config', {
  ...baseColumns,
  fromName: text('from_name').notNull(),
  replyTo: citext('reply_to'),
  footerText: text('footer_text'),
  version: integer('version').notNull().default(1),
});

export const emailDailyCounts = pgTable(
  'email_daily_counts',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    sent: integer('sent').notNull().default(0),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId, table.day] })],
);

export type EmailMessageRow = typeof emailMessages.$inferSelect;
export type NewEmailMessageRow = typeof emailMessages.$inferInsert;
export type EmailMessageLinkRow = typeof emailMessageLinks.$inferSelect;
export type EmailSenderConfigRow = typeof emailSenderConfig.$inferSelect;
