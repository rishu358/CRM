-- Deals won this month (MVP_SPEC M10, ADR-0038).
--
-- The dashboard's "won this month" and its leaderboard ask for the deals of one
-- company closed within a two-month window. Until now `closed_at` was only ever
-- read as part of a record, so nothing indexed it, and the nearest index
-- (`deals_tenant_stage_created_idx`) would have read every deal the company has
-- ever won and thrown most of them away: a cost that grows with the age of the
-- company rather than with the size of the month.
--
-- Partial on purpose. An open deal has no close date and a deleted one is in the
-- Recycle Bin, so neither belongs in an index whose only reader is a report of
-- closed work; leaving them out keeps it the size of the company's wins, not of
-- its pipeline.
--
-- Not CONCURRENTLY, because the migration runner wraps each file in one
-- transaction (see 0007). That is safe while `deals` is small; building this on a
-- table that already holds millions of rows belongs outside the runner, as the
-- recipe in 0016 describes for the audit log.
CREATE INDEX deals_tenant_closed_idx
  ON deals (tenant_id, closed_at, id)
  WHERE deleted_at IS NULL AND closed_at IS NOT NULL;
