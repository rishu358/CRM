-- Search that costs what it returns, not what it matches (ADR-0028 §4, ADR-0041).
--
-- Found by the load test at a million contacts. A surname shared by one record in sixty matches
-- sixty-seven thousand index rows, and fetching and ranking them all took 3 to 6 seconds: long
-- enough that a handful of concurrent searches held every database connection the API has, and
-- every other request failed behind them. A sales rep, who may see only their own records, paid
-- the same, because the owner restriction was applied after the fetch, not by the index.
--
-- Two changes, both to indexes (the statements change in `packages/db/src/search/postgres.ts`):
--
-- 1. The full-text and trigram GIN indexes now lead with `(tenant_id, owner_id)`. A rep's search
--    is an index condition on both, so it reads the rep's rows: measured 1.5 s down to about
--    0.15 s on the same data. A search by someone who may see everything has no `owner_id` condition,
--    and a GIN index answers a query that uses only some of its columns, so it is not slower.
--    The new indexes are no bigger than the ones they replace (213 MB against 214 MB for full-text,
--    156 MB against 194 MB for trigram, at 5.6 million rows). They keep the old names so nothing that
--    refers to them has to change.
--
-- 2. `search_documents_recent_idx` lets a broad term be answered newest-first and stopped after
--    `SEARCH_CANDIDATE_CAP` matches (see that constant for what this changes and what it does not).
--    For a selective term the planner still uses the GIN indexes, exactly as before.
--
-- The new indexes are built before the old ones are dropped, so there is never a moment without a
-- search index. Built inside the runner's transaction (see 0018): fine while the table is small; on
-- one that already holds millions of rows build them outside the runner, CONCURRENTLY, as 0016
-- describes for the audit log, then run the renames.
CREATE INDEX search_documents_fts_owner_idx
  ON search_documents USING gin (tenant_id, owner_id, search_vector);

CREATE INDEX search_documents_trgm_owner_idx
  ON search_documents USING gin (tenant_id, owner_id, value gin_trgm_ops);

DROP INDEX search_documents_fts_idx;
DROP INDEX search_documents_trgm_idx;

ALTER INDEX search_documents_fts_owner_idx RENAME TO search_documents_fts_idx;
ALTER INDEX search_documents_trgm_owner_idx RENAME TO search_documents_trgm_idx;

CREATE INDEX search_documents_recent_idx
  ON search_documents (tenant_id, record_updated_at DESC, id DESC);
