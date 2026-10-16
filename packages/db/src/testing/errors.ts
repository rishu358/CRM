/**
 * Unwrapping database errors in tests.
 *
 * Drizzle wraps a driver error in its own `Failed query: ...` Error and keeps
 * the original on `cause`. Asserting on the wrapper's message would pass for
 * *any* failure, including a typo in the test's own SQL — so a test that means
 * to prove "this was refused by RLS" would also pass when the query never ran.
 * These helpers reach the Postgres error and its SQLSTATE instead.
 */

export interface CapturedDbError {
  readonly message: string;
  /** Postgres SQLSTATE, e.g. 42501 insufficient_privilege. */
  readonly code: string | undefined;
}

/** Postgres raises this for both a denied grant and an RLS policy violation. */
export const INSUFFICIENT_PRIVILEGE = '42501';

function deepest(error: unknown): unknown {
  let current = error;
  while (
    current instanceof Error &&
    current.cause !== undefined &&
    current.cause !== null &&
    current.cause !== current
  ) {
    current = current.cause;
  }
  return current;
}

/** Run `work`, expect it to reject, and return the underlying database error. */
export async function captureDbError(work: () => Promise<unknown>): Promise<CapturedDbError> {
  try {
    await work();
  } catch (error) {
    const root = deepest(error);
    const message = root instanceof Error ? root.message : String(root);
    const code =
      typeof root === 'object' && root !== null && 'code' in root ? String(root.code) : undefined;
    return { message, code };
  }
  throw new Error('Expected the database to reject this operation, but it succeeded');
}
