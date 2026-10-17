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

  /**
   * Give a user a password, pre-verified, as signup would have left them.
   *
   * Takes an already-computed hash rather than a plaintext password: hashing
   * belongs to the API's `PasswordHasher` (ADR-0017), and a second
   * implementation here would be one more thing that can silently disagree
   * with the real one.
   */
  async setCredential(userId: string, email: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_accounts (id, user_id, provider_id, account_id, password_hash)
       VALUES ($1, $2, 'credential', $3, $4)
       ON CONFLICT (provider_id, account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [newId(), userId, email, passwordHash],
    );
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.pool.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [userId]);
  }

  async emailFor(userId: string): Promise<string> {
    const result = await this.pool.query<{ email: string }>(
      `SELECT email::text AS email FROM users WHERE id = $1`,
      [userId],
    );
    const email = result.rows[0]?.email;
    if (email === undefined) throw new Error(`No user ${userId}`);
    return email;
  }

  /**
   * Put a membership into any of its three states.
   *
   * Invitations are the first thing in the product that can leave a membership
   * at something other than `active`, so the tests that prove an inactive
   * member is locked out need a way to produce one.
   */
  async setMembershipStatus(tenantId: string, userId: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE memberships SET status = $3 WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId, status],
    );
  }

  /** Audit rows for one object type, newest first. */
  async auditEntries(
    tenantId: string,
    objectType: string,
  ): Promise<{ action: string; recordId: string | null; changes: unknown }[]> {
    const result = await this.pool.query<{
      action: string;
      record_id: string | null;
      changes: unknown;
    }>(
      `SELECT action, record_id, changes FROM audit_logs
       WHERE tenant_id = $1 AND object_type = $2
       ORDER BY occurred_at DESC`,
      [tenantId, objectType],
    );
    return result.rows.map((row) => ({
      action: row.action,
      recordId: row.record_id,
      changes: row.changes,
    }));
  }

  /** Every event type the outbox holds for a tenant. */
  async outboxEventTypes(tenantId: string): Promise<string[]> {
    const result = await this.pool.query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE tenant_id = $1`,
      [tenantId],
    );
    return result.rows.map((row) => row.event_type);
  }

  /** A pending invitation's row, for assertions nothing in the API exposes. */
  async invitationRow(id: string): Promise<{
    email: string;
    role_id: string;
    accepted_at: Date | null;
    revoked_at: Date | null;
    revoked_reason: string | null;
  } | null> {
    const result = await this.pool.query<{
      email: string;
      role_id: string;
      accepted_at: Date | null;
      revoked_at: Date | null;
      revoked_reason: string | null;
    }>(
      `SELECT email::text AS email, role_id, accepted_at, revoked_at, revoked_reason
       FROM invitations WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** Push an invitation's expiry into the past, to test what an old link does. */
  async expireInvitation(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [id],
    );
  }

  /** Merge a key into `tenants.settings`, e.g. `{ mfaRequired: true }`. */
  async setTenantSettings(tenantId: string, settings: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`, [
      tenantId,
      JSON.stringify(settings),
    ]);
  }

  /** Authentication events, newest first. Used to assert on brute-force rows. */
  async authEvents(where: {
    email?: string;
    userId?: string;
  }): Promise<{ type: string; succeeded: boolean }[]> {
    const result = await this.pool.query<{ type: string; succeeded: boolean }>(
      `SELECT type, succeeded FROM auth_events
       WHERE ($1::text IS NULL OR email = $1) AND ($2::uuid IS NULL OR user_id = $2)
       ORDER BY occurred_at DESC`,
      [where.email ?? null, where.userId ?? null],
    );
    return result.rows;
  }

  async countActiveSessions(userId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? '0');
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
