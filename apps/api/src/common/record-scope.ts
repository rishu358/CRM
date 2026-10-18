/**
 * The actor's record scope as a WHERE clause (ADR-0008).
 *
 * The implementation moved to `@crm/db` when global search was built: the
 * Postgres search provider needs the identical translation and lives outside
 * the API, and two copies of this particular rule is exactly the duplication
 * the comment on the original warned about (ADR-0028).
 *
 * Re-exported from here so every module's import is unchanged, and so that
 * anybody looking for it in the API finds it rather than a blank space.
 */
export { constraintToSql } from '@crm/db';
