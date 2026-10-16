import { newId } from '@crm/core';
import type { Action, Scope } from '@crm/core';
import type pg from 'pg';

/**
 * Test fixtures.
 *
 * These insert through a **superuser** connection, deliberately. Every
 * application role is subject to FORCE ROW LEVEL SECURITY, so none of them can
 * set up a second tenant's data — which is exactly the property the isolation
 * tests exist to prove. Fixtures therefore sit outside that boundary, the same
 * way provisioning does in production.
 */

/**
 * A collision-resistant suffix taken from a UUIDv7's **tail**.
 *
 * UUIDv7 encodes the timestamp in its leading bits (ADR-0003), so ids minted in
 * the same millisecond share a prefix. Fixtures that built unique slugs and
 * emails from the first characters collided exactly as often as the tests were
 * fast. The trailing bits are the random ones.
 */
function randomSuffix(id: string): string {
  return id.replaceAll('-', '').slice(-12);
}

export interface SeededTenant {
  readonly tenantId: string;
}

export interface SeededUser {
  readonly userId: string;
  readonly membershipId: string;
}

export class Fixtures {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Create a bare tenant with no roles.
   *
   * Roles come either from `provisionTenantDefaults` (the real path) or from an
   * explicit `createRole` call. Seeding one here as well collided with
   * provisioning on the unique (tenant_id, name) index.
   */
  async createTenant(options: { name?: string; slug?: string } = {}): Promise<SeededTenant> {
    const tenantId = newId();
    const slug = options.slug ?? `t-${randomSuffix(tenantId)}`;
    await this.pool.query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)`, [
      tenantId,
      options.name ?? `Tenant ${slug}`,
      slug,
    ]);
    return { tenantId };
  }

  async createRole(
    tenantId: string,
    name: string,
    options: { isSystem?: boolean } = {},
  ): Promise<string> {
    const roleId = newId();
    await this.pool.query(
      `INSERT INTO roles (id, tenant_id, name, is_system) VALUES ($1, $2, $3, $4)`,
      [roleId, tenantId, name, options.isSystem ?? false],
    );
    return roleId;
  }

  async grant(
    tenantId: string,
    roleId: string,
    objectType: string,
    action: Action,
    scope: Scope,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, role_id, object_type, action)
       DO UPDATE SET scope = EXCLUDED.scope`,
      [newId(), tenantId, roleId, objectType, action, scope],
    );
  }

  /** Grant the full CRUD set on one object type at one scope. */
  async grantAll(
    tenantId: string,
    roleId: string,
    objectType: string,
    scope: Scope,
  ): Promise<void> {
    for (const action of ['read', 'create', 'update', 'delete', 'export'] as const) {
      await this.grant(tenantId, roleId, objectType, action, scope);
    }
  }

  async setFieldPermission(
    tenantId: string,
    roleId: string,
    objectType: string,
    fieldKey: string,
    access: 'hidden' | 'read' | 'write',
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO field_permissions (id, tenant_id, role_id, object_type, field_key, access)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, role_id, object_type, field_key)
       DO UPDATE SET access = EXCLUDED.access`,
      [newId(), tenantId, roleId, objectType, fieldKey, access],
    );
  }

  async createUser(
    tenantId: string,
    roleId: string,
    options: { email?: string; name?: string } = {},
  ): Promise<SeededUser> {
    const userId = newId();
    const membershipId = newId();
    await this.pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
      userId,
      options.email ?? `user-${randomSuffix(userId)}@example.com`,
      options.name ?? 'Test User',
    ]);
    await this.pool.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, status, joined_at)
       VALUES ($1, $2, $3, $4, 'active', now())`,
      [membershipId, tenantId, userId, roleId],
    );
    return { userId, membershipId };
  }

  async createTeam(tenantId: string, name: string, userIds: readonly string[]): Promise<string> {
    const teamId = newId();
    await this.pool.query(`INSERT INTO teams (id, tenant_id, name) VALUES ($1, $2, $3)`, [
      teamId,
      tenantId,
      name,
    ]);
    for (const userId of userIds) {
      await this.pool.query(
        `INSERT INTO team_members (id, tenant_id, team_id, user_id) VALUES ($1, $2, $3, $4)`,
        [newId(), tenantId, teamId, userId],
      );
    }
    return teamId;
  }

  async createContact(
    tenantId: string,
    options: {
      ownerId?: string | null;
      lastName?: string;
      email?: string | null;
      customFields?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const contactId = newId();
    await this.pool.query(
      `INSERT INTO contacts (id, tenant_id, owner_id, last_name, email, custom_fields)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        contactId,
        tenantId,
        options.ownerId ?? null,
        options.lastName ?? 'Sharma',
        options.email ?? null,
        JSON.stringify(options.customFields ?? {}),
      ],
    );
    return contactId;
  }
}
