import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  createDbClient,
  readPoolRole,
  withTenant,
  withoutTenant,
  type DbClient,
  type Tx,
} from '@crm/db';
import { assertConnectedRoles } from '@crm/core';
import type { ApiEnv } from '../config/env.js';

/**
 * Owns the connection pools and is the only route to a transaction.
 *
 * Two pools, two database roles (ADR-0002):
 *   `app`  — crm_app, tenant-scoped by RLS, the role every request uses
 *   `auth` — crm_auth, identity tables only, used solely to verify a session
 *
 * The split means a flaw in a controller cannot read password hashes, and a
 * flaw in the auth layer cannot read customer data.
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly appClient: DbClient;
  private readonly authClient: DbClient;

  constructor(private readonly env: ApiEnv) {
    this.appClient = createDbClient({
      connectionString: env.DATABASE_URL,
      maxConnections: env.DATABASE_POOL_MAX,
    });
    this.authClient = createDbClient({
      connectionString: env.DATABASE_AUTH_URL ?? env.DATABASE_URL,
      // Session lookups are short; a small pool is plenty and limits blast radius.
      maxConnections: Math.max(2, Math.floor(env.DATABASE_POOL_MAX / 4)),
    });
  }

  /**
   * In production, refuse to run if either pool connects as a role that can bypass row-level
   * security (CLAUDE.md §5.1). Managed Postgres hands out an administrative role that does, as the
   * first connection string it shows; running the API as it turns the tenant wall off without a
   * single error. Thrown from here, it stops the process before it listens (`main.ts` logs it and
   * exits). Development and tests are not asked: their roles are the ones the bootstrap built.
   */
  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV !== 'production') return;
    const [app, auth] = await Promise.all([
      readPoolRole(this.appClient.pool),
      readPoolRole(this.authClient.pool),
    ]);
    assertConnectedRoles({ DATABASE_URL: app, DATABASE_AUTH_URL: auth });
  }

  /**
   * Run `work` inside a transaction scoped to this tenant and user.
   *
   * Everything that touches tenant data goes through here. The SET LOCAL that
   * RLS depends on happens inside `withTenant`; opening a connection any other
   * way silently bypasses isolation.
   */
  runInTenant<T>(
    context: { tenantId: string; userId: string | null },
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return withTenant(this.appClient.db, context, work);
  }

  /**
   * Run `work` against the identity tables with no tenant context.
   *
   * Used only to resolve a session into a user, before any tenant is known.
   * The crm_auth role has no grant on business tables, so this cannot reach
   * customer data even by mistake.
   */
  runAsAuth<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return withoutTenant(this.authClient.db, work);
  }

  /** Liveness check. Deliberately touches no tenant data. */
  async ping(): Promise<boolean> {
    const result = await this.appClient.pool.query('select 1 as ok');
    return result.rows.length === 1;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.appClient.close(), this.authClient.close()]);
  }
}
