import { createDbClient, withTenant } from '@crm/db';
import { provisionTenantDefaults } from '@crm/db/seed';

/**
 * Equip a test company the way sign-up does: as the **application** role.
 *
 * Provisioning writes `field_definitions`, and the worker's role cannot (migration
 * 0019, ADR-0039): the worker reads definitions to build exports and writes none. A
 * harness that provisioned through its worker connection was relying on a grant no
 * production code path uses, so it provisions through the role that does.
 */
export async function provisionAsApp(
  appUrl: string,
  tenantId: string,
): ReturnType<typeof provisionTenantDefaults> {
  const app = createDbClient({ connectionString: appUrl, maxConnections: 1 });
  try {
    return await withTenant(app.db, { tenantId, userId: null }, (tx) =>
      provisionTenantDefaults(tx, tenantId, null),
    );
  } finally {
    await app.close();
  }
}
