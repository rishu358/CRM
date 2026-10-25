import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema/index.js';
import { closePool } from './pool-close.js';
import { poolConnectionConfig } from './tls.js';

/**
 * Database access (ADR-0002).
 *
 * Nothing outside this module may open a connection or start a transaction.
 * Tenant isolation depends on every statement running inside a transaction that
 * has already set `app.tenant_id`, and `withTenant` is the only thing that does
 * that — a raw pool checkout bypasses the guarantee entirely.
 */

export type Database = NodePgDatabase<typeof schema>;

/** A transaction handle. Only ever obtained from `withTenant` or `withoutTenant`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TenantContext {
  readonly tenantId: string;
  /** Null for system actions such as a scheduled job. */
  readonly userId: string | null;
}

export interface DbClientOptions {
  readonly connectionString: string;
  /**
   * The provider's CA certificate, for a managed Postgres whose certificate Node does not trust
   * (see `tls.ts`). Verification stays on; unset leaves the driver's own rules untouched.
   */
  readonly caCert?: string | undefined;
  readonly maxConnections?: number;
  /** Fail fast rather than queueing behind a saturated pool. */
  readonly connectionTimeoutMillis?: number;
}

// Postgres returns bigint as a string by default so that values above 2^53 are
// not silently rounded. We want that precision, but as a real bigint.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => BigInt(value));

export interface DbClient {
  readonly db: Database;
  readonly pool: pg.Pool;
  close(): Promise<void>;
}

export function createDbClient(options: DbClientOptions): DbClient {
  const pool = new pg.Pool({
    ...poolConnectionConfig(options.connectionString, options.caCert),
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    // Recycle idle connections so a long-lived process does not pin a backend
    // that has accumulated session state.
    idleTimeoutMillis: 30_000,
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    close: () => closePool(pool),
  };
}

/**
 * UUID shape check applied before a value reaches `set_config`.
 *
 * `set_config` takes its value as a parameter, so this is not what prevents SQL
 * injection. It is a second assertion that the tenant id is a real id and not,
 * say, an empty string — which would make `current_tenant_id()` return NULL and
 * turn every query into a silent zero-row result instead of an obvious failure.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `work` inside a transaction scoped to one tenant.
 *
 * `SET LOCAL` binds the setting to this transaction, so it is discarded on
 * COMMIT or ROLLBACK and cannot leak to whatever request next borrows this
 * pooled connection. Using `SET` instead of `SET LOCAL` here would be a
 * cross-tenant leak that only appears under concurrency.
 *
 * Both values are passed as **parameters** to `set_config`, never interpolated
 * into the statement text (CLAUDE.md §5.7).
 */
export async function withTenant<T>(
  db: Database,
  context: TenantContext,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(context.tenantId)) {
    throw new TypeError('withTenant requires a valid tenant id');
  }
  if (context.userId !== null && !UUID_PATTERN.test(context.userId)) {
    throw new TypeError('withTenant requires a valid user id or null');
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${context.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${context.userId ?? ''}, true)`);
    return work(tx);
  });
}

/**
 * Run a transaction with **no** tenant context.
 *
 * Every RLS policy compares against `current_tenant_id()`, which is NULL here,
 * so tenant tables return nothing and reject writes. This exists for the few
 * genuinely tenant-less operations — signup creating the first tenant row, or a
 * health check — and for tests that need to prove the fail-closed behaviour.
 *
 * It is deliberately named so that it stands out in review.
 */
export function withoutTenant<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(work);
}

export { schema };

/** What the database says about the role a pool's connections run as. */
export interface PoolRole {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
}

/**
 * Asks the server who this pool really is, for the startup check that refuses a role that can
 * walk through row-level security (CLAUDE.md §5.1). It reads the catalog rather than trusting
 * the connection string: the name in a URL says what someone meant, `pg_roles` says what the
 * role can do. Touches no tenant data, so it needs no tenant context.
 */
export async function readPoolRole(pool: pg.Pool): Promise<PoolRole> {
  const result = await pool.query<{ name: string; superuser: boolean; bypassrls: boolean }>(
    `select r.rolname as name, r.rolsuper as superuser, r.rolbypassrls as bypassrls
       from pg_roles r
      where r.rolname = current_user`,
  );
  const row = result.rows[0];
  // current_user always has a pg_roles row; an empty answer means we cannot say what we are, and
  // not knowing is not a pass.
  if (row === undefined) throw new Error('Could not read the connected database role');
  return { name: row.name, superuser: row.superuser, bypassRls: row.bypassrls };
}
