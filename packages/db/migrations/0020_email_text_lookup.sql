-- Exact email lookups that can use an index (CLAUDE.md §7, ADR-0041).
--
-- Found by the load test: `WHERE email = 'x'` on `contacts` read every contact the company
-- has (about 240 ms at 250,000 rows, and linear), although `contacts_tenant_email_idx` exists
-- and answers the same question in under a millisecond when run by a superuser.
--
-- The cause is row-level security. `email` is `citext`, and its equality function
-- (`citext_eq`) is not marked LEAKPROOF. With RLS on, Postgres will not evaluate a
-- non-leakproof function from the query before the policy's own condition, so it cannot be
-- used as an index condition, and every role the application connects as is subject to RLS
-- (`FORCE ROW LEVEL SECURITY`, no BYPASSRLS). `text` equality (`texteq`) *is* leakproof.
-- The old index was therefore built and maintained on every write and read by nobody.
--
-- The fix is to compare as text, which needs the stored value to be what the comparison
-- expects. The API contracts have always lower-cased an email on the way in (create, update and
-- import), so lower case is already true of every row the product wrote; this makes it true of
-- every row, whoever writes it, so `email::text = lower($1)` is exactly what `citext`
-- equality was.
--
-- NOT VALID, then VALIDATE: the second step takes a lock that lets reads and writes continue
-- while it scans, so this is safe on a large live table. If a row somewhere is not lower case
-- the VALIDATE fails and says so, and nothing has been changed.
--
-- The indexes are built inside the runner's transaction (see 0018). That is safe while the
-- tables are small; on one that already holds millions of rows build them outside the runner,
-- CONCURRENTLY, as 0016 describes for the audit log.

ALTER TABLE contacts
  ADD CONSTRAINT contacts_email_lowercase_chk
  CHECK (email IS NULL OR email::text = lower(email::text)) NOT VALID;
ALTER TABLE contacts VALIDATE CONSTRAINT contacts_email_lowercase_chk;

ALTER TABLE leads
  ADD CONSTRAINT leads_email_lowercase_chk
  CHECK (email IS NULL OR email::text = lower(email::text)) NOT VALID;
ALTER TABLE leads VALIDATE CONSTRAINT leads_email_lowercase_chk;

CREATE INDEX contacts_tenant_email_text_idx
  ON contacts (tenant_id, (email::text))
  WHERE deleted_at IS NULL;

CREATE INDEX leads_tenant_email_text_idx
  ON leads (tenant_id, (email::text))
  WHERE deleted_at IS NULL;

-- Replaced, not supplemented: no role the application uses can read these.
DROP INDEX contacts_tenant_email_idx;
DROP INDEX leads_tenant_email_idx;
