import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { baseColumns } from './columns.js';

/**
 * Per-workspace entitlement overrides (ADR-0047).
 *
 * The plan says what a workspace has; a row here says "this workspace is an exception". Written only
 * by the operator's role (`crm_auth`); the application role and the worker can read their own
 * workspace's rows and nothing else, so no request can grant a workspace a feature.
 */
export const tenantEntitlements = pgTable(
  'tenant_entitlements',
  {
    ...baseColumns,
    feature: text('feature').notNull(),
    enabled: boolean('enabled').notNull(),
    reason: text('reason').notNull(),
  },
  (table) => [uniqueIndex('tenant_entitlements_feature_key').on(table.tenantId, table.feature)],
);

export type TenantEntitlement = typeof tenantEntitlements.$inferSelect;
export type NewTenantEntitlement = typeof tenantEntitlements.$inferInsert;
