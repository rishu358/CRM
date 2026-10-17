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

  /**
   * Insert an account directly.
   *
   * `parentAccountId` goes through the same trigger and foreign key the API
   * does — fixtures bypass RLS, not integrity — so a test can use this to
   * prove the database refuses a cycle even when the service is not involved.
   */
  async createAccount(
    tenantId: string,
    options: {
      ownerId?: string | null;
      name?: string;
      domain?: string | null;
      industry?: string | null;
      email?: string | null;
      phone?: string | null;
      gstin?: string | null;
      annualRevenueMinor?: bigint | null;
      annualRevenueCurrency?: string | null;
      employeeCount?: number | null;
      parentAccountId?: string | null;
      customFields?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const accountId = newId();
    await this.pool.query(
      `INSERT INTO accounts (
         id, tenant_id, owner_id, name, domain, industry, email, phone, gstin,
         annual_revenue_minor, annual_revenue_currency, employee_count,
         parent_account_id, custom_fields
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        accountId,
        tenantId,
        options.ownerId ?? null,
        options.name ?? 'Acme Trading',
        options.domain ?? null,
        options.industry ?? null,
        options.email ?? null,
        options.phone ?? null,
        options.gstin ?? null,
        options.annualRevenueMinor === undefined || options.annualRevenueMinor === null
          ? null
          : options.annualRevenueMinor.toString(),
        options.annualRevenueCurrency ?? null,
        options.employeeCount ?? null,
        options.parentAccountId ?? null,
        JSON.stringify(options.customFields ?? {}),
      ],
    );
    return accountId;
  }

  /** Set a parent directly, for tests that must reach the trigger, not the API. */
  async setAccountParent(accountId: string, parentAccountId: string | null): Promise<void> {
    await this.pool.query(`UPDATE accounts SET parent_account_id = $2 WHERE id = $1`, [
      accountId,
      parentAccountId,
    ]);
  }

  /** A tenant's pipelines with their stages, as provisioning created them. */
  async pipelinesFor(tenantId: string): Promise<
    {
      id: string;
      name: string;
      isDefault: boolean;
      stages: { id: string; name: string; stageType: 'open' | 'won' | 'lost' }[];
    }[]
  > {
    const pipelines = await this.pool.query<{ id: string; name: string; is_default: boolean }>(
      `SELECT id, name, is_default FROM pipelines WHERE tenant_id = $1 ORDER BY position, id`,
      [tenantId],
    );
    const stages = await this.pool.query<{
      id: string;
      pipeline_id: string;
      name: string;
      stage_type: 'open' | 'won' | 'lost';
    }>(
      `SELECT id, pipeline_id, name, stage_type FROM pipeline_stages
       WHERE tenant_id = $1 ORDER BY position, id`,
      [tenantId],
    );
    return pipelines.rows.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      isDefault: pipeline.is_default,
      stages: stages.rows
        .filter((stage) => stage.pipeline_id === pipeline.id)
        .map((stage) => ({ id: stage.id, name: stage.name, stageType: stage.stage_type })),
    }));
  }

  /**
   * Insert a deal directly, through the same constraints and triggers the API
   * meets — fixtures bypass RLS, not integrity. Closed-state columns are not
   * defaulted from the stage, so a test can hand the database an inconsistent
   * row and watch it refuse.
   */
  async createDeal(
    tenantId: string,
    options: {
      pipelineId: string;
      stageId: string;
      ownerId?: string | null;
      name?: string;
      amountMinor?: bigint | null;
      currency?: string | null;
      probability?: number;
      closedAt?: Date | null;
      lostReason?: string | null;
      accountId?: string | null;
      primaryContactId?: string | null;
      customFields?: Record<string, unknown>;
    },
  ): Promise<string> {
    const dealId = newId();
    await this.pool.query(
      `INSERT INTO deals (
         id, tenant_id, owner_id, name, pipeline_id, stage_id, amount_minor, currency,
         probability, closed_at, lost_reason, account_id, primary_contact_id, custom_fields
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        dealId,
        tenantId,
        options.ownerId ?? null,
        options.name ?? 'Sample deal',
        options.pipelineId,
        options.stageId,
        options.amountMinor === undefined || options.amountMinor === null
          ? null
          : options.amountMinor.toString(),
        options.currency ?? null,
        options.probability ?? 0,
        options.closedAt ?? null,
        options.lostReason ?? null,
        options.accountId ?? null,
        options.primaryContactId ?? null,
        JSON.stringify(options.customFields ?? {}),
      ],
    );
    return dealId;
  }

  /** A further pipeline, to prove that stages cannot be borrowed across pipelines. */
  async createPipeline(
    tenantId: string,
    name: string,
    stages: readonly { name: string; stageType: 'open' | 'won' | 'lost'; probability: number }[],
  ): Promise<{ pipelineId: string; stageIds: string[] }> {
    const pipelineId = newId();
    await this.pool.query(
      `INSERT INTO pipelines (id, tenant_id, name, position) VALUES ($1, $2, $3, 100)`,
      [pipelineId, tenantId, name],
    );
    const stageIds: string[] = [];
    for (const [index, stage] of stages.entries()) {
      const stageId = newId();
      stageIds.push(stageId);
      await this.pool.query(
        `INSERT INTO pipeline_stages
           (id, tenant_id, pipeline_id, name, position, probability, stage_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          stageId,
          tenantId,
          pipelineId,
          stage.name,
          (index + 1) * 10,
          stage.probability,
          stage.stageType,
        ],
      );
    }
    return { pipelineId, stageIds };
  }

  /** Retype a stage directly, to reach the trigger that protects stages holding deals. */
  async setStageType(stageId: string, stageType: 'open' | 'won' | 'lost'): Promise<void> {
    await this.pool.query(`UPDATE pipeline_stages SET stage_type = $2 WHERE id = $1`, [
      stageId,
      stageType,
    ]);
  }

  /** Put a person on a deal. */
  async linkDealContact(
    tenantId: string,
    dealId: string,
    contactId: string,
    role: string | null = null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO deal_contacts (id, tenant_id, deal_id, contact_id, role)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), tenantId, dealId, contactId, role],
    );
  }

  /** A manual exchange rate, major unit to major unit: 1 `from` = `rate` `to`. */
  async setExchangeRate(tenantId: string, from: string, to: string, rate: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO exchange_rates (id, tenant_id, from_currency, to_currency, rate)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, from_currency, to_currency) DO UPDATE SET rate = EXCLUDED.rate`,
      [newId(), tenantId, from, to, rate],
    );
  }

  /** The deal row as stored, for assertions the API's serializer would filter. */
  async dealRow(id: string): Promise<{
    stage_id: string;
    probability: number;
    closed_at: Date | null;
    lost_reason: string | null;
    version: number;
    deleted_at: Date | null;
  } | null> {
    const result = await this.pool.query<{
      stage_id: string;
      probability: number;
      closed_at: Date | null;
      lost_reason: string | null;
      version: number;
      deleted_at: Date | null;
    }>(
      `SELECT stage_id, probability, closed_at, lost_reason, version, deleted_at
       FROM deals WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** Outbox events of one type, oldest first, with their payloads. */
  async outboxEvents(
    tenantId: string,
    eventType: string,
  ): Promise<{ recordId: string | null; payload: Record<string, unknown> }[]> {
    const result = await this.pool.query<{
      record_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT record_id, payload FROM outbox_events
       WHERE tenant_id = $1 AND event_type = $2 ORDER BY created_at, id`,
      [tenantId, eventType],
    );
    return result.rows.map((row) => ({ recordId: row.record_id, payload: row.payload }));
  }

  async createContact(
    tenantId: string,
    options: {
      ownerId?: string | null;
      firstName?: string | null;
      lastName?: string;
      email?: string | null;
      phone?: string | null;
      accountId?: string | null;
      customFields?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const contactId = newId();
    await this.pool.query(
      `INSERT INTO contacts (id, tenant_id, owner_id, first_name, last_name, email, phone,
                             account_id, custom_fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        contactId,
        tenantId,
        options.ownerId ?? null,
        options.firstName ?? null,
        options.lastName ?? 'Sharma',
        options.email ?? null,
        options.phone ?? null,
        options.accountId ?? null,
        JSON.stringify(options.customFields ?? {}),
      ],
    );
    return contactId;
  }

  /**
   * Insert a lead directly, through the same constraints and triggers the API
   * meets — fixtures bypass RLS, not integrity. Conversion columns are not
   * defaulted from the status, so a test can hand the database an inconsistent
   * row and watch it refuse.
   */
  async createLead(
    tenantId: string,
    options: {
      ownerId?: string | null;
      firstName?: string | null;
      lastName?: string;
      company?: string | null;
      email?: string | null;
      phone?: string | null;
      source?: string | null;
      status?: 'new' | 'contacted' | 'qualified' | 'unqualified' | 'converted';
      convertedAt?: Date | null;
      convertedContactId?: string | null;
      convertedAccountId?: string | null;
      convertedDealId?: string | null;
      customFields?: Record<string, unknown>;
    } = {},
  ): Promise<string> {
    const leadId = newId();
    await this.pool.query(
      `INSERT INTO leads (
         id, tenant_id, owner_id, first_name, last_name, company, email, phone, source,
         status, converted_at, converted_contact_id, converted_account_id,
         converted_deal_id, custom_fields
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        leadId,
        tenantId,
        options.ownerId ?? null,
        options.firstName ?? null,
        options.lastName ?? 'Verma',
        options.company ?? null,
        options.email ?? null,
        options.phone ?? null,
        options.source ?? null,
        options.status ?? 'new',
        options.convertedAt ?? null,
        options.convertedContactId ?? null,
        options.convertedAccountId ?? null,
        options.convertedDealId ?? null,
        JSON.stringify(options.customFields ?? {}),
      ],
    );
    return leadId;
  }

  /** The lead row as stored, for assertions the API's serializer would filter. */
  async leadRow(id: string): Promise<{
    status: string;
    version: number;
    converted_at: Date | null;
    converted_contact_id: string | null;
    converted_account_id: string | null;
    converted_deal_id: string | null;
    deleted_at: Date | null;
  } | null> {
    const result = await this.pool.query<{
      status: string;
      version: number;
      converted_at: Date | null;
      converted_contact_id: string | null;
      converted_account_id: string | null;
      converted_deal_id: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT status, version, converted_at, converted_contact_id, converted_account_id,
              converted_deal_id, deleted_at
       FROM leads WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** How many live rows a tenant holds in a table. Table name is a fixture constant. */
  async countRows(
    table: 'contacts' | 'accounts' | 'deals' | 'leads',
    tenantId: string,
  ): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = $1`,
      [tenantId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  /** A tenant-defined (non-system) custom field, as an admin would add one. */
  async createCustomField(
    tenantId: string,
    objectType: string,
    key: string,
    type: 'text' | 'number' | 'date' | 'boolean' | 'email' | 'phone' | 'url',
    label = key,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO field_definitions (id, tenant_id, object_type, key, label, type, position)
       VALUES ($1, $2, $3, $4, $5, $6, 1000)`,
      [newId(), tenantId, objectType, key, label, type],
    );
  }
}
