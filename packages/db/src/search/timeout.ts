import { SearchTimeoutError } from '@crm/core';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';

/**
 * A time limit on a search, that cannot leave the caller's transaction broken (ADR-0041 §1).
 *
 * Search leans on two functions being marked LEAKPROOF, which needs a superuser. On a database
 * without one it still works, but a rare or misspelled word makes Postgres read every index row of the
 * company: measured at a million contacts, 28 seconds for a list's search box, 8 for the palette. Left
 * alone that holds a database connection for the whole time, and a handful of people mistyping at once
 * leaves the API with none. So every search statement runs under a limit, and past it the answer is a
 * clear "too broad, be more specific" (`SearchTimeoutError`, 503) instead of a wait.
 *
 * Two things make this safe to wrap around a statement in somebody else's transaction:
 *
 *   - **A savepoint.** A statement that times out aborts the transaction it ran in; run inside one it
 *     aborts only the savepoint, so the caller's transaction (which has the tenant set and may have
 *     more to do) carries on.
 *   - **The previous limit is put back.** `SET LOCAL` outlasts the savepoint when it succeeds, so the
 *     caller's own statements would otherwise inherit a two-second limit.
 *
 * The limit is generous for a search that is working (an exact search over a million contacts takes
 * 0.1 to 0.3 s) and short enough to be a limit on harm.
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 2000;

/** SQLSTATE 57014, `query_canceled`: what a statement timeout raises. */
const QUERY_CANCELED = '57014';

function pgCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  // Drizzle wraps the driver's error and keeps it as `cause`.
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? undefined : pgCode(cause);
}

export async function withSearchTimeout<T>(
  tx: Tx,
  timeoutMs: number,
  run: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await tx.transaction(async (inner) => {
      const current = await inner.execute(
        sql`select current_setting('statement_timeout') as value`,
      );
      const previous = (current.rows[0] as { value: string } | undefined)?.value ?? '0';

      await inner.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
      const result = await run(inner);
      await inner.execute(sql`select set_config('statement_timeout', ${previous}, true)`);
      return result;
    });
  } catch (error) {
    if (pgCode(error) === QUERY_CANCELED) throw new SearchTimeoutError();
    throw error;
  }
}
