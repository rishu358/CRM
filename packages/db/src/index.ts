export * from './client.js';
export * from './actor.js';
export * from './env.js';
export * from './migrator.js';
export * from './record-scope.js';
export * from './search/index.js';
export * from './import-export/index.js';
export * as schema from './schema/index.js';
export * from './schema/index.js';

/**
 * The query-builder surface, re-exported.
 *
 * Apps import `sql`, `eq` and friends **from here**, never from `drizzle-orm`
 * directly. Drizzle's `SQL` carries a private field, so TypeScript treats two
 * copies of the package as unrelated types — and pnpm produces two copies the
 * moment any dependency brings its own peer set, which is exactly what adding
 * `better-auth` to the API did (ADR-0017). The symptom is a wall of
 * "`SQL<unknown>` is not assignable to `SQL<unknown>`" in files nobody
 * touched.
 *
 * Routing every app through this module means there is one instance by
 * construction, whatever the dependency graph does later.
 */
export {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
export * from './access/records.js';
export * from './access/record-ref.js';
export * from './access/reassign.js';
