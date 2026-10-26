import type pg from 'pg';

/**
 * A row as a test reads it back: keyed by column, value unknown.
 *
 * `pg`'s default result type is `any[]`, which silently switches off the type
 * checker for everything read from it. A test that says
 * `expect(rows[0].owner_id).toBe(rep)` compiles whatever the column is called,
 * which is how an assertion ends up checking nothing. `unknown` forces each
 * value to be named and compared explicitly, and the lint rules that ban `any`
 * (CLAUDE.md §2) apply to tests like everything else.
 */
export type TestRow = Record<string, unknown>;

export interface TypedPool {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: TestRow[] }>;
  end(): Promise<void>;
}

/** Wrap a `pg.Pool` so query results are `TestRow[]`, not `any[]`. */
export function typedPool(pool: pg.Pool): TypedPool {
  return {
    query: async (text, values) => {
      const result = await pool.query<TestRow>(text, values === undefined ? [] : [...values]);
      return { rows: result.rows };
    },
    end: () => pool.end(),
  };
}
