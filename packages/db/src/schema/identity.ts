import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { baseColumns, citext, timestamptz } from './columns.js';

/**
 * Identity (ADR-0014).
 *
 * `users` is a **global** identity table: one person, one row, no matter how
 * many tenants they belong to. Consultants and agencies legitimately work across
 * several businesses, and duplicating them per tenant would mean duplicate
 * passwords and duplicate MFA enrolments.
 *
 * Because it is global, `users` carries **no `tenant_id` and no tenant RLS
 * policy**. Tenant scoping lives in `memberships`, which is tenant-owned and does
 * carry RLS. Adding a tenant policy here would break multi-tenant membership;
 * omitting the membership join when reading users would leak the user directory.
 * Both mistakes are covered by tests.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    /** citext: addresses are compared case-insensitively everywhere. */
    email: citext('email').notNull(),
    emailVerifiedAt: timestamptz('email_verified_at'),
    name: text('name').notNull(),
    image: text('image'),
    locale: text('locale').notNull().default('en-IN'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /**
     * Revokes every session issued under an earlier epoch. A password change
     * adds one, so revocation is one write rather than a sweep over sessions
     * (MVP_SPEC M1 acceptance). A counter and not a timestamp, because the
     * comparison must not depend on the database clock moving forwards
     * (ADR-0036).
     */
    sessionEpoch: integer('session_epoch').notNull().default(0),
    /**
     * @deprecated No longer read; superseded by `sessionEpoch` (ADR-0036).
     * Kept so the previous release keeps working through a rolling deploy.
     */
    sessionsValidFrom: timestamptz('sessions_valid_from')
      .notNull()
      .default(sql`now()`),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    deletedAt: timestamptz('deleted_at'),
  },
  (table) => [uniqueIndex('users_email_key').on(table.email)],
);

/**
 * Which tenants a user belongs to, and as what.
 *
 * Tenant-owned, RLS-protected, and the join every user lookup must go through.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    /** invited | active | suspended */
    status: text('status').notNull().default('invited'),
    invitedBy: uuid('invited_by'),
    invitedAt: timestamptz('invited_at'),
    joinedAt: timestamptz('joined_at'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    uniqueIndex('memberships_tenant_user_key').on(table.tenantId, table.userId),
    index('memberships_tenant_role_idx').on(table.tenantId, table.roleId),
    index('memberships_user_idx').on(table.userId),
  ],
);

/**
 * Pending and settled invitations to join a workspace (MVP_SPEC M2).
 *
 * Tenant-owned and RLS-protected, because an invitation *is* tenant data: it
 * names a workspace, carries the role it confers, and must be listable and
 * revocable by that workspace's administrators and by nobody else.
 *
 * That is why the token digest lives here rather than in `verifications`,
 * which is global, crm_auth-only and has nowhere to put a tenant or a role
 * (ADR-0019). The mechanics are the same as that table's, deliberately: only
 * the SHA-256 of the token is stored, and redemption is a single
 * `UPDATE ... WHERE accepted_at IS NULL ... RETURNING` so two concurrent
 * attempts cannot both win.
 *
 * `created_by` is the inviter and `created_at` the invitation time, so
 * `memberships.invited_by` / `invited_at` are filled from here on acceptance.
 *
 * There is **no membership row while an invitation is pending**. A pending row
 * could only be written for an address that already has a user, so its
 * presence would tell any administrator which of the addresses they invited
 * already have accounts — the enumeration oracle the whole auth module is
 * built to avoid.
 */
export const invitations = pgTable(
  'invitations',
  {
    ...baseColumns,
    /** The invited address, lowercased. citext: matched case-insensitively. */
    email: citext('email').notNull(),
    /** The role the invitation confers. Never taken from the request body. */
    roleId: uuid('role_id').notNull(),
    /** SHA-256 of the whole token, including its workspace prefix. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    acceptedAt: timestamptz('accepted_at'),
    acceptedBy: uuid('accepted_by'),
    revokedAt: timestamptz('revoked_at'),
    /** revoked (by a person) | superseded (by a newer invitation). */
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('invitations_token_hash_key').on(table.tokenHash),
    index('invitations_tenant_email_idx').on(table.tenantId, table.email),
    index('invitations_tenant_created_idx').on(table.tenantId, table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
