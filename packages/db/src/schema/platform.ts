import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns, timestamptz } from './columns.js';

/**
 * Audit log (CLAUDE.md §5.10).
 *
 * **Append-only**: `crm_app` is granted INSERT and SELECT but not UPDATE or
 * DELETE, so the application physically cannot rewrite history even if asked to.
 *
 * Partitioned monthly by `occurred_at`. A busy tenant writes a row per record
 * change, so this becomes the largest table in the database; partitions let old
 * months be detached and archived without a long-running DELETE.
 *
 * Partition pruning requires the partition key in the primary key, hence the
 * composite `(id, occurred_at)`.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    /** Null for system-initiated changes such as a retention job. */
    actorId: uuid('actor_id'),
    /** create | update | delete | login | permission_change | export | impersonate | ... */
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    recordId: uuid('record_id'),
    /**
     * `{ field: { old, new } }`. Field-level permissions are applied before this
     * diff is shown to anyone, so a hidden field never surfaces here either.
     */
    changes: jsonb('changes').$type<Record<string, { old?: unknown; new?: unknown }>>(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.occurredAt] }),
    index('audit_logs_tenant_time_idx').on(table.tenantId, table.occurredAt),
    index('audit_logs_tenant_record_idx').on(table.tenantId, table.objectType, table.recordId),
    index('audit_logs_tenant_actor_idx').on(table.tenantId, table.actorId, table.occurredAt),
  ],
);

/**
 * Transactional outbox (ADR-0006).
 *
 * Written in the same transaction as the state change it describes, then relayed
 * by the worker. Delivery is at-least-once, so every consumer must be idempotent.
 *
 * The worker reads across tenants, which is a deliberate exception to tenant
 * scoping: it connects as `crm_worker`, whose policy on this table alone permits
 * all rows. It then opens a tenant-scoped transaction per event before touching
 * anything else.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    /** Dotted and versioned, e.g. `contact.created.v1`. */
    eventType: text('event_type').notNull(),
    objectType: text('object_type'),
    recordId: uuid('record_id'),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** pending | processing | relayed | failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Next time this row may be picked up; moved forward on backoff. */
    availableAt: timestamptz('available_at')
      .notNull()
      .default(sql`now()`),
    lastError: text('last_error'),
    actorId: uuid('actor_id'),
    requestId: text('request_id'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    relayedAt: timestamptz('relayed_at'),
  },
  (table) => [
    // The worker's claim query. Partial, so relayed rows do not bloat it.
    index('outbox_events_pending_idx')
      .on(table.availableAt)
      .where(sql`${table.status} = 'pending'`),
    index('outbox_events_tenant_idx').on(table.tenantId, table.createdAt),
  ],
);

/**
 * In-app notifications (MVP_SPEC M6).
 *
 * Written by the worker from outbox events, never inline by a service
 * (ADR-0006). A notification is addressed to one person, so there is no role
 * grant for it: the only rule is that you read your own, which the service
 * applies as `user_id = <session user>` on top of RLS.
 *
 * `digestedAt` is how the email digest avoids sending the same item twice.
 * It is set when a digest including this row is sent, so a later digest skips
 * it even though it may still be unread (ADR-0025).
 */
export const notifications = pgTable(
  'notifications',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    readAt: timestamptz('read_at'),
    digestedAt: timestamptz('digested_at'),
    /**
     * The outbox event this came from. Unique per tenant, which is what makes
     * the notification handler idempotent under at-least-once delivery.
     */
    sourceEventId: uuid('source_event_id'),
  },
  (table) => [
    index('notifications_tenant_user_idx').on(table.tenantId, table.userId, table.createdAt),
  ],
);

/**
 * Which records a person opened, and when (MVP_SPEC M6, "recently viewed").
 *
 * One row per person per record, moved forward on each view rather than
 * appended, so this stays small and "recent" is a cheap indexed read instead
 * of a scan over a log. Polymorphic, like every other cross-object table
 * (ADR-0005).
 *
 * Deliberately not written by the read path itself: a GET that writes turns
 * every record page into a write transaction, and makes a read-only replica
 * impossible later. The client says "I opened this" instead, and the server
 * still checks the caller may read what they claim to have viewed.
 */
export const recordViews = pgTable(
  'record_views',
  {
    ...baseColumns,
    userId: uuid('user_id').notNull(),
    objectType: text('object_type').notNull(),
    recordId: uuid('record_id').notNull(),
    viewedAt: timestamptz('viewed_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex('record_views_unique').on(
      table.tenantId,
      table.userId,
      table.objectType,
      table.recordId,
    ),
    index('record_views_recent_idx').on(table.tenantId, table.userId, table.viewedAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type RecordView = typeof recordViews.$inferSelect;
