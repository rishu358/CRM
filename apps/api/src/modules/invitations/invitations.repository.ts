import { Injectable } from '@nestjs/common';
import { newId } from '@crm/core';
import { type Tx, sql } from '@crm/db';

/**
 * Data access for invitations and for the memberships they produce.
 *
 * Only `InvitationsService` calls this (ADR-0001). Every query runs inside the
 * caller's tenant-scoped transaction as `crm_app`, so RLS supplies the tenant
 * predicate; the explicit `tenant_id` comparisons are belt and braces.
 *
 * ## Why memberships are written here
 *
 * `memberships` has no module of its own yet. The auth module touches it as
 * `crm_auth` during sign-up only, which is documented there and cannot be
 * reused: that role has INSERT but no UPDATE on the table, and acceptance has
 * to run inside the workspace's RLS context anyway. Membership reads and
 * writes move to the users module when M3 builds it; until then this is the
 * one place that owns them, rather than being a second one.
 */
export interface InvitationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly email: string;
  readonly role_id: string;
  readonly role_name: string;
  readonly invited_by_name: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface RedeemedInvitation {
  readonly id: string;
  readonly email: string;
  readonly role_id: string;
  readonly created_by: string | null;
  /**
   * ISO text, formatted in SQL.
   *
   * Whether a `timestamptz` arrives from `tx.execute` as a Date or a string
   * depends on the driver's type parsers, which a dependency bump can change
   * underneath us. Formatting in Postgres makes the shape ours; the value is
   * only ever copied into another column.
   */
  readonly created_at: string;
}

export interface PendingInvitationLookup extends InvitationRow {
  readonly workspace_name: string;
}

export interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface MembershipStatusRow {
  readonly id: string;
  readonly status: string;
}

/**
 * The columns the admin list and the acceptance preview both need.
 *
 * `invited_by_name` comes from `users` through the membership policy, so an
 * inviter who has since been removed from the workspace reads as null rather
 * than leaking a name from outside it.
 */
const INVITATION_COLUMNS = sql`
  i.id,
  i.tenant_id,
  i.email::text as email,
  i.role_id,
  r.name as role_name,
  u.name as invited_by_name,
  to_json(i.created_at)#>>'{}' as created_at,
  to_json(i.expires_at)#>>'{}' as expires_at
`;

/** Pending means: not accepted, not revoked, not yet expired. */
const STILL_PENDING = sql`
  i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
`;

@Injectable()
export class InvitationsRepository {
  async listPending(tx: Tx, tenantId: string, limit: number): Promise<InvitationRow[]> {
    const result = await tx.execute(sql`
      select ${INVITATION_COLUMNS}
      from invitations i
      join roles r on r.id = i.role_id
      left join users u on u.id = i.created_by
      where i.tenant_id = ${tenantId} and ${STILL_PENDING}
      order by i.created_at desc, i.id desc
      limit ${limit}
    `);
    return result.rows as unknown as InvitationRow[];
  }

  /** One pending invitation by id, for revocation. Null covers both "gone" and "not yours". */
  async findPendingById(tx: Tx, tenantId: string, id: string): Promise<InvitationRow | null> {
    const result = await tx.execute(sql`
      select ${INVITATION_COLUMNS}
      from invitations i
      join roles r on r.id = i.role_id
      left join users u on u.id = i.created_by
      where i.tenant_id = ${tenantId} and i.id = ${id} and ${STILL_PENDING}
      limit 1
    `);
    return (result.rows as unknown as InvitationRow[])[0] ?? null;
  }

  /**
   * Look a token up without consuming it, for the acceptance screen.
   *
   * By digest, inside the workspace the token's prefix named — so a prefix
   * pointing at some other workspace matches nothing, which is exactly what
   * makes the prefix a routing hint rather than an authorization (ADR-0019).
   */
  async findPendingByTokenHash(
    tx: Tx,
    tenantId: string,
    tokenHash: string,
  ): Promise<PendingInvitationLookup | null> {
    const result = await tx.execute(sql`
      select ${INVITATION_COLUMNS}, t.name as workspace_name
      from invitations i
      join roles r on r.id = i.role_id
      join tenants t on t.id = i.tenant_id
      left join users u on u.id = i.created_by
      where i.tenant_id = ${tenantId} and i.token_hash = ${tokenHash} and ${STILL_PENDING}
      limit 1
    `);
    return (result.rows as unknown as PendingInvitationLookup[])[0] ?? null;
  }

  /**
   * This workspace's name, for the invitation email.
   *
   * The `tenants_self` policy confines the row to the current tenant, so there
   * is no name here to read but our own.
   */
  async workspaceName(tx: Tx, tenantId: string): Promise<string> {
    const result = await tx.execute(sql`
      select name from tenants where id = ${tenantId} limit 1
    `);
    return (result.rows as unknown as { name: string }[])[0]?.name ?? '';
  }

  /** Every role in this workspace, for the invite form's picker. */
  async listRoles(tx: Tx, tenantId: string): Promise<RoleRow[]> {
    const result = await tx.execute(sql`
      select id, name, description from roles
      where tenant_id = ${tenantId}
      order by name
    `);
    return result.rows as unknown as RoleRow[];
  }

  /** A role that exists in this workspace, or null. RLS does the scoping. */
  async findRole(tx: Tx, tenantId: string, roleId: string): Promise<{ name: string } | null> {
    const result = await tx.execute(sql`
      select name from roles where tenant_id = ${tenantId} and id = ${roleId} limit 1
    `);
    return (result.rows as unknown as { name: string }[])[0] ?? null;
  }

  /**
   * Retire every outstanding invitation for this address in this workspace.
   *
   * A second invitation must invalidate the first (MVP_SPEC M2), for the same
   * reason a new password-reset link retires the previous one: an admin who
   * re-invites because they mistyped a role, or because the first link went
   * somewhere it should not have, expects the earlier link to stop working.
   */
  async supersedeOutstanding(tx: Tx, tenantId: string, email: string): Promise<number> {
    const result = await tx.execute(sql`
      update invitations
      set revoked_at = now(), revoked_reason = 'superseded', updated_at = now()
      where tenant_id = ${tenantId}
        and email = ${email}
        and accepted_at is null
        and revoked_at is null
      returning id
    `);
    return result.rows.length;
  }

  async insert(
    tx: Tx,
    input: {
      tenantId: string;
      email: string;
      roleId: string;
      tokenHash: string;
      expiresAt: Date;
      invitedBy: string;
    },
  ): Promise<string> {
    const id = newId();
    await tx.execute(sql`
      insert into invitations
        (id, tenant_id, email, role_id, token_hash, expires_at, created_by, updated_by)
      values
        (${id}, ${input.tenantId}, ${input.email}, ${input.roleId}, ${input.tokenHash},
         ${input.expiresAt.toISOString()}, ${input.invitedBy}, ${input.invitedBy})
    `);
    return id;
  }

  /**
   * Redeem a token: find it and mark it accepted in one statement.
   *
   * The guards live in the WHERE, not in a preceding read, so two concurrent
   * acceptances cannot both win and a revocation that lands mid-flight is
   * honoured. Exactly the shape `AuthRepository.consumeVerification` uses, and
   * for exactly the same reason.
   */
  async redeem(
    tx: Tx,
    tenantId: string,
    tokenHash: string,
    acceptedBy: string,
  ): Promise<RedeemedInvitation | null> {
    const result = await tx.execute(sql`
      update invitations
      set accepted_at = now(), accepted_by = ${acceptedBy}, updated_at = now(),
          updated_by = ${acceptedBy}
      where tenant_id = ${tenantId}
        and token_hash = ${tokenHash}
        and accepted_at is null
        and revoked_at is null
        and expires_at > now()
      returning id, email::text as email, role_id, created_by,
               to_json(created_at)#>>'{}' as created_at
    `);
    return (result.rows as unknown as RedeemedInvitation[])[0] ?? null;
  }

  /** Revoke by id. Returns null when it was already accepted, revoked or expired. */
  async revoke(
    tx: Tx,
    tenantId: string,
    id: string,
    revokedBy: string,
  ): Promise<{ id: string } | null> {
    const result = await tx.execute(sql`
      update invitations
      set revoked_at = now(), revoked_reason = 'revoked', updated_at = now(),
          updated_by = ${revokedBy}
      where tenant_id = ${tenantId}
        and id = ${id}
        and accepted_at is null
        and revoked_at is null
      returning id
    `);
    return (result.rows as unknown as { id: string }[])[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  async findMembership(
    tx: Tx,
    tenantId: string,
    userId: string,
  ): Promise<MembershipStatusRow | null> {
    const result = await tx.execute(sql`
      select id, status from memberships
      where tenant_id = ${tenantId} and user_id = ${userId} limit 1
    `);
    return (result.rows as unknown as MembershipStatusRow[])[0] ?? null;
  }

  /**
   * Create the membership an accepted invitation earns.
   *
   * `invited_by` and `invited_at` are copied from the invitation row, so the
   * provenance MVP_SPEC §6.1 asks for survives even though no membership
   * existed while the invitation was pending (ADR-0019).
   */
  async createActiveMembership(
    tx: Tx,
    input: {
      tenantId: string;
      userId: string;
      roleId: string;
      invitedBy: string | null;
      /** ISO text, straight from the invitation row. */
      invitedAt: string;
    },
  ): Promise<string> {
    const id = newId();
    await tx.execute(sql`
      insert into memberships
        (id, tenant_id, user_id, role_id, status, invited_by, invited_at, joined_at,
         created_by, updated_by)
      values
        (${id}, ${input.tenantId}, ${input.userId}, ${input.roleId}, 'active',
         ${input.invitedBy}, ${input.invitedAt}, now(),
         ${input.userId}, ${input.userId})
    `);
    return id;
  }

  /** Activate a membership that was sitting at `invited`, keeping the invited role. */
  async activateMembership(
    tx: Tx,
    tenantId: string,
    membershipId: string,
    roleId: string,
    userId: string,
  ): Promise<void> {
    await tx.execute(sql`
      update memberships
      set status = 'active', role_id = ${roleId}, joined_at = coalesce(joined_at, now()),
          updated_at = now(), updated_by = ${userId}
      where tenant_id = ${tenantId} and id = ${membershipId} and status = 'invited'
    `);
  }
}
