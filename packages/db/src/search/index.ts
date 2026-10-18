/**
 * The Postgres search adapter (ADR-0009, ADR-0028).
 *
 * The interface it implements lives in `@crm/core`; only this folder knows
 * that search is Postgres-shaped today. It sits in `@crm/db` because it is the
 * only code that understands `search_documents`, and because both the API
 * (which reads the index) and the worker (which writes it) need it — a copy in
 * each app would be two things to keep in step.
 */
export {
  PostgresSearchProvider,
  fullTextStatement,
  fuzzyStatement,
  visibilityPredicate,
} from './postgres.js';
export { buildSearchDocuments, liveRecordIds, MAX_INDEXED_VALUE_LENGTH } from './documents.js';
export { reindexTenant } from './reindex.js';
