import { customType, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Delivery events, the address block list and the company pause (migration 0034, ADR-0075).
 *
 * Read the migration's header before changing any of this: the platform's routing role may read three
 * columns of `email_messages` so an event that names only the provider's id can find its company, and
 * nothing more.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

export const emailProviderEvents = pgTable(
  'email_provider_events',
  {
    ...baseColumns,
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    emailMessageId: uuid('email_message_id').notNull(),
    eventType: text('event_type').$type<'delivered' | 'bounced' | 'complained'>().notNull(),
  },
  (table) => [
    uniqueIndex('email_provider_events_once_key').on(
      table.tenantId,
      table.provider,
      table.providerEventId,
    ),
    index('email_provider_events_message_idx').on(table.tenantId, table.emailMessageId),
  ],
);

export const emailSuppressions = pgTable(
  'email_suppressions',
  {
    ...baseColumns,
    addressHash: bytea('address_hash').notNull(),
    reason: text('reason').$type<'hard_bounce' | 'complaint' | 'unsubscribed'>().notNull(),
    sourceEmailId: uuid('source_email_id'),
    liftedAt: timestamptz('lifted_at'),
    liftedBy: uuid('lifted_by'),
  },
  (table) => [
    index('email_suppressions_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

export const emailPauses = pgTable('email_pauses', {
  ...baseColumns,
  reason: text('reason').$type<'bounces' | 'complaints'>().notNull(),
  pausedAt: timestamptz('paused_at').notNull(),
  resumedAt: timestamptz('resumed_at'),
  resumedBy: uuid('resumed_by'),
});

export type EmailSuppressionRow = typeof emailSuppressions.$inferSelect;
export type EmailPauseRow = typeof emailPauses.$inferSelect;
