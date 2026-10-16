import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from './columns.js';

/**
 * Auth tables backing Better Auth (ADR-0014).
 *
 * Like `users`, these are **global** and carry no tenant RLS: a session belongs
 * to a person, not to a tenant, and the active tenant is chosen per request and
 * checked against `memberships`.
 *
 * Nothing here is ever logged or serialised into a response (CLAUDE.md §5.8).
 */

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    /** Opaque, high-entropy. Stored hashed by the auth layer, never returned. */
    token: text('token').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    /** The tenant this session is currently acting in; re-checked every request. */
    activeTenantId: uuid('active_tenant_id'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
    revokedAt: timestamptz('revoked_at'),
  },
  (table) => [
    uniqueIndex('sessions_token_key').on(table.token),
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

/** Credentials and linked social providers. One row per provider per user. */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    /** 'credential' for email+password, otherwise the OAuth provider id. */
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    /** Argon2id hash for the credential provider. Null for OAuth. */
    passwordHash: text('password_hash'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamptz('access_token_expires_at'),
    refreshTokenExpiresAt: timestamptz('refresh_token_expires_at'),
    scope: text('scope'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    uniqueIndex('auth_accounts_provider_account_key').on(table.providerId, table.accountId),
    index('auth_accounts_user_idx').on(table.userId),
  ],
);

/** Short-lived tokens for email verification, password reset and invites. */
export const verifications = pgTable(
  'verifications',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index('verifications_identifier_idx').on(table.identifier),
    index('verifications_expires_idx').on(table.expiresAt),
  ],
);

/** Enrolled second factors. `secret` is encrypted at the application layer. */
export const mfaFactors = pgTable(
  'mfa_factors',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').notNull(),
    /** totp | backup_codes */
    type: text('type').notNull(),
    secret: text('secret').notNull(),
    verifiedAt: timestamptz('verified_at'),
    createdAt: timestamptz('created_at')
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index('mfa_factors_user_idx').on(table.userId)],
);

/**
 * Authentication attempts and outcomes.
 *
 * Drives brute-force protection (MVP_SPEC M1) and is append-only. Records what
 * happened, never the credential that was tried.
 */
export const authEvents = pgTable(
  'auth_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id'),
    /** Present even when the address matches no user, so probing is visible. */
    email: text('email'),
    /** login_succeeded | login_failed | password_reset | mfa_challenged | ... */
    type: text('type').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    requestId: text('request_id'),
    succeeded: boolean('succeeded').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index('auth_events_email_time_idx').on(table.email, table.occurredAt),
    index('auth_events_user_time_idx').on(table.userId, table.occurredAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type AuthAccount = typeof authAccounts.$inferSelect;
export type MfaFactor = typeof mfaFactors.$inferSelect;
export type AuthEvent = typeof authEvents.$inferSelect;
