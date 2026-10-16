import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createDbClient, withTenant, withoutTenant, type DbClient, type Tx } from '@crm/db';
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
export class DatabaseService implements OnModuleDestroy {
  private readonly appClient: DbClient;
  private readonly authClient: DbClient;

  constructor(env: ApiEnv) {
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
