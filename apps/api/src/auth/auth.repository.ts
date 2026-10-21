import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@crm/core';
import { type Tx, sql } from '@crm/db';
import { DatabaseService } from '../database/database.service.js';

/**
 * Every read and write against the identity tables.
 *
 * Runs as `crm_auth`, which holds no grant on any business table, so nothing
 * in this file can reach customer data even if it is wrong (ADR-0002). The
 * module boundary is the other half of that: no other module imports this
 * repository, and nothing here reaches into another module's tables
 * (CLAUDE.md §3).
 *
 * Methods take an optional `tx` so a caller can compose several of them into
 * one transaction — a signup must not leave a user without a credential, and a
 * password change must not revoke sessions it then fails to apply.
 */
export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly image: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly email_verified_at: Date | null;
  readonly mfa_enabled: boolean;
  readonly deleted_at: Date | null;
}

export interface CredentialRow {
  readonly id: string;
  readonly user_id: string;
  readonly password_hash: string | null;
}

export interface VerificationRow {
  readonly id: string;
  readonly identifier: string;
  readonly user_id: string | null;
  readonly purpose: string;
}

export interface MembershipRow {
  readonly tenant_id: string;
  readonly name: string;
  readonly slug: string;
  readonly role_name: string;
  readonly settings: Record<string, unknown>;
}

/**
 * Timestamps come back as ISO strings, formatted in SQL.
 *
 * `tx.execute` returns raw driver rows, and whether a `timestamptz` arrives as
 * a `Date` or a string depends on the driver's type parsers — which is a thing
 * a dependency bump can change underneath us. Formatting in Postgres makes the
 * shape ours rather than the driver's, and these values are only ever
 * serialised into JSON anyway.
 */
export interface SessionRow {
  readonly id: string;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly created_at: string;
  readonly last_seen_at: string | null;
  readonly expires_at: string;
}

export interface MfaFactorRow {
  readonly id: string;
  readonly type: string;
  readonly secret: string;
  readonly verified_at: Date | null;
}

@Injectable()
export class AuthRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Run several repository calls in one identity transaction. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.runAsAuth(work);
  }

  private run<T>(tx: Tx | undefined, work: (tx: Tx) => Promise<T>): Promise<T> {
    return tx === undefined ? this.database.runAsAuth(work) : work(tx);
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  /**
   * Look up by address.
   *
   * Includes soft-deleted users so callers can decide. Treating a deleted user
   * as absent here would let the same address be signed up again and collide
   * on the unique index, reported as a 500.
   */
  async findUserByEmail(email: string, tx?: Tx): Promise<UserRow | null> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select id, email::text as email, name, image, locale, timezone,
               email_verified_at, mfa_enabled, deleted_at
        from users where email = ${email} limit 1
      `);
      return result.rows as unknown as UserRow[];
    });
    return rows[0] ?? null;
  }

  async findUserById(id: string, tx?: Tx): Promise<UserRow | null> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select id, email::text as email, name, image, locale, timezone,
               email_verified_at, mfa_enabled, deleted_at
        from users where id = ${id} and deleted_at is null limit 1
      `);
      return result.rows as unknown as UserRow[];
    });
    return rows[0] ?? null;
  }

  async createUser(
    input: { email: string; name: string; image?: string | null; emailVerified?: boolean },
    tx?: Tx,
  ): Promise<string> {
    const id = newId();
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into users (id, email, name, image, email_verified_at)
        values (
          ${id}, ${input.email}, ${input.name}, ${input.image ?? null},
          ${input.emailVerified === true ? sql`now()` : sql`null`}
        )
      `),
    );
    return id;
  }

  async markEmailVerified(userId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(
        sql`update users set email_verified_at = coalesce(email_verified_at, now()),
                             updated_at = now()
            where id = ${userId}`,
      ),
    );
  }

  async setMfaEnabled(userId: string, enabled: boolean, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(
        sql`update users set mfa_enabled = ${enabled}, updated_at = now() where id = ${userId}`,
      ),
    );
  }

  async deleteUser(userId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) => t.execute(sql`delete from users where id = ${userId}`));
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  async findCredential(userId: string, providerId: string, tx?: Tx): Promise<CredentialRow | null> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select id, user_id, password_hash from auth_accounts
        where user_id = ${userId} and provider_id = ${providerId} limit 1
      `);
      return result.rows as unknown as CredentialRow[];
    });
    return rows[0] ?? null;
  }

  async findBySocialAccount(
    providerId: string,
    accountId: string,
    tx?: Tx,
  ): Promise<{ user_id: string } | null> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select user_id from auth_accounts
        where provider_id = ${providerId} and account_id = ${accountId} limit 1
      `);
      return result.rows as unknown as { user_id: string }[];
    });
    return rows[0] ?? null;
  }

  async upsertCredential(
    input: { userId: string; providerId: string; accountId: string; passwordHash?: string | null },
    tx?: Tx,
  ): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into auth_accounts (id, user_id, provider_id, account_id, password_hash)
        values (${newId()}, ${input.userId}, ${input.providerId}, ${input.accountId},
                ${input.passwordHash ?? null})
        on conflict (provider_id, account_id) do update
          set password_hash = excluded.password_hash, updated_at = now()
      `),
    );
  }

  async setPassword(userId: string, passwordHash: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        update auth_accounts set password_hash = ${passwordHash}, updated_at = now()
        where user_id = ${userId} and provider_id = 'credential'
      `),
    );
  }

  // -------------------------------------------------------------------------
  // One-time tokens
  // -------------------------------------------------------------------------

  async createVerification(
    input: {
      identifier: string;
      valueHash: string;
      purpose: string;
      userId: string | null;
      expiresAt: Date;
    },
    tx?: Tx,
  ): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into verifications (id, identifier, value, purpose, user_id, expires_at)
        values (${newId()}, ${input.identifier}, ${input.valueHash}, ${input.purpose},
                ${input.userId}, ${input.expiresAt.toISOString()})
      `),
    );
  }

  /**
   * Redeem a token: find it and mark it consumed in one statement.
   *
   * The `consumed_at is null` in the WHERE is what makes a token single-use
   * even when two requests arrive at once. Reading first and updating second
   * would leave a window in which both reads see an unconsumed token and both
   * proceed — which for a password-reset link means two parties setting the
   * password.
   */
  async consumeVerification(
    valueHash: string,
    purpose: string,
    tx?: Tx,
  ): Promise<VerificationRow | null> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        update verifications set consumed_at = now()
        where value = ${valueHash}
          and purpose = ${purpose}
          and consumed_at is null
          and expires_at > now()
        returning id, identifier, user_id, purpose
      `);
      return result.rows as unknown as VerificationRow[];
    });
    return rows[0] ?? null;
  }

  /**
   * Invalidate every outstanding token of a purpose for a user.
   *
   * Issuing a new reset link must retire the previous one; otherwise a link
   * mailed to an address the attacker briefly controlled stays live for its
   * full hour after the real owner has recovered the account.
   */
  async consumeOutstanding(userId: string, purpose: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        update verifications set consumed_at = now()
        where user_id = ${userId} and purpose = ${purpose} and consumed_at is null
      `),
    );
  }

  // -------------------------------------------------------------------------
  // Memberships
  // -------------------------------------------------------------------------

  /**
   * The workspaces this user can act in.
   *
   * Only `active` memberships: an invited-but-not-accepted or suspended member
   * must not be able to choose that workspace at sign-in, which is the same
   * rule `ActorService` applies per request.
   */
  async listMemberships(userId: string, tx?: Tx): Promise<MembershipRow[]> {
    return this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select m.tenant_id, t.name, t.slug, r.name as role_name, t.settings
        from memberships m
        join tenants t on t.id = m.tenant_id
        join roles r on r.id = m.role_id
        where m.user_id = ${userId}
          and m.status = 'active'
          and t.deleted_at is null
        order by t.name
      `);
      return result.rows as unknown as MembershipRow[];
    });
  }

  async createTenant(
    input: { name: string; slug: string; status: string },
    tx?: Tx,
  ): Promise<string> {
    const id = newId();
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into tenants (id, name, slug, status)
        values (${id}, ${input.name}, ${input.slug}, ${input.status})
      `),
    );
    return id;
  }

  async activateTenant(tenantId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(
        sql`update tenants set status = 'active', updated_at = now() where id = ${tenantId}`,
      ),
    );
  }

  async createMembership(
    input: { tenantId: string; userId: string; roleId: string },
    tx?: Tx,
  ): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into memberships (id, tenant_id, user_id, role_id, status, joined_at, created_by)
        values (${newId()}, ${input.tenantId}, ${input.userId}, ${input.roleId}, 'active', now(),
                ${input.userId})
      `),
    );
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async listSessions(userId: string, tx?: Tx): Promise<SessionRow[]> {
    return this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select id, ip_address, user_agent,
               to_json(created_at)#>>'{}' as created_at,
               to_json(last_seen_at)#>>'{}' as last_seen_at,
               to_json(expires_at)#>>'{}' as expires_at
        from sessions
        where user_id = ${userId} and revoked_at is null and expires_at > now()
        order by coalesce(last_seen_at, created_at) desc
        limit 100
      `);
      return result.rows as unknown as SessionRow[];
    });
  }

  /** Returns how many were revoked, which the audit entry records. */
  async revokeOtherSessions(
    userId: string,
    keepSessionId: string | null,
    tx?: Tx,
  ): Promise<number> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        update sessions set revoked_at = now()
        where user_id = ${userId}
          and revoked_at is null
          and (${keepSessionId}::uuid is null or id <> ${keepSessionId}::uuid)
        returning id
      `);
      return result.rows as unknown as { id: string }[];
    });
    return rows.length;
  }

  /**
   * Revoke one session, but only if it belongs to this user.
   *
   * The ownership check is in the WHERE, not in a prior read: a session id is
   * a uuid a caller could guess at, and `delete where id = $1` would let one
   * user sign another out (CLAUDE.md §5.5).
   */
  async revokeSessionForUser(sessionId: string, userId: string, tx?: Tx): Promise<boolean> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        update sessions set revoked_at = now()
        where id = ${sessionId} and user_id = ${userId} and revoked_at is null
        returning id
      `);
      return result.rows as unknown as { id: string }[];
    });
    return rows.length > 0;
  }

  /**
   * Invalidate every session issued so far, in one write, by advancing the
   * user's session epoch (ADR-0036).
   *
   * This is what makes "changing the password revokes all other sessions"
   * (MVP_SPEC M1) a single statement that cannot half-apply, rather than a
   * sweep that might miss a session created while it ran.
   */
  async bumpSessionEpoch(userId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(
        sql`update users set session_epoch = session_epoch + 1, updated_at = now() where id = ${userId}`,
      ),
    );
  }

  async touchSession(sessionId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        update sessions set last_seen_at = now()
        where id = ${sessionId}
          and (last_seen_at is null or last_seen_at < now() - interval '1 minute')
      `),
    );
  }

  async setSessionTenant(sessionId: string, tenantId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        update sessions set active_tenant_id = ${tenantId}, updated_at = now()
        where id = ${sessionId}
      `),
    );
  }

  // -------------------------------------------------------------------------
  // MFA factors
  // -------------------------------------------------------------------------

  async listFactors(userId: string, tx?: Tx): Promise<MfaFactorRow[]> {
    return this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select id, type, secret, verified_at from mfa_factors where user_id = ${userId}
      `);
      return result.rows as unknown as MfaFactorRow[];
    });
  }

  async upsertFactor(
    input: { userId: string; type: string; secret: string; verified: boolean },
    tx?: Tx,
  ): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into mfa_factors (id, user_id, type, secret, verified_at)
        values (${newId()}, ${input.userId}, ${input.type}, ${input.secret},
                ${input.verified ? sql`now()` : sql`null`})
        on conflict (user_id, type) do update
          set secret = excluded.secret, verified_at = excluded.verified_at
      `),
    );
  }

  async markFactorVerified(userId: string, type: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        update mfa_factors set verified_at = coalesce(verified_at, now()), last_used_at = now()
        where user_id = ${userId} and type = ${type}
      `),
    );
  }

  async updateFactorSecret(userId: string, type: string, secret: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        update mfa_factors set secret = ${secret}, last_used_at = now()
        where user_id = ${userId} and type = ${type}
      `),
    );
  }

  async deleteFactors(userId: string, tx?: Tx): Promise<void> {
    await this.run(tx, (t) => t.execute(sql`delete from mfa_factors where user_id = ${userId}`));
  }

  // -------------------------------------------------------------------------
  // auth_events
  // -------------------------------------------------------------------------

  /**
   * Append an authentication event. Never the credential that was tried.
   *
   * `email` is recorded even when it matches no user, which is the whole point:
   * someone working through a list of addresses is invisible otherwise.
   */
  async recordEvent(
    input: {
      type: string;
      succeeded: boolean;
      userId?: string | null;
      email?: string | null;
      ipAddress?: string | null;
      userAgent?: string | null;
      requestId?: string | null;
    },
    tx?: Tx,
  ): Promise<void> {
    await this.run(tx, (t) =>
      t.execute(sql`
        insert into auth_events (id, user_id, email, type, ip_address, user_agent, request_id, succeeded)
        values (${newId()}, ${input.userId ?? null}, ${input.email ?? null}, ${input.type},
                ${input.ipAddress ?? null}, ${input.userAgent ?? null}, ${input.requestId ?? null},
                ${input.succeeded})
      `),
    );
  }

  /**
   * Failed sign-ins in the window, counted per address **and** per source
   * address, taking whichever is higher.
   *
   * Per-address alone lets one host work through many accounts unthrottled;
   * per-IP alone lets a distributed attempt on one account through. Neither is
   * sufficient, so both are counted (CLAUDE.md §5.14).
   */
  async countRecentFailures(
    input: { email: string | null; ipAddress: string | null; windowSeconds: number },
    tx?: Tx,
  ): Promise<number> {
    const rows = await this.run(tx, async (t) => {
      const result = await t.execute(sql`
        select
          count(*) filter (where email = ${input.email}) as by_email,
          count(*) filter (where ip_address = ${input.ipAddress}) as by_ip
        from auth_events
        where succeeded = false
          and type = 'login_failed'
          and occurred_at > now() - make_interval(secs => ${input.windowSeconds})
          and (email = ${input.email} or ip_address = ${input.ipAddress})
      `);
      return result.rows as unknown as { by_email: string; by_ip: string }[];
    });
    const row = rows[0];
    if (row === undefined) return 0;
    return Math.max(Number(row.by_email), Number(row.by_ip));
  }
}
