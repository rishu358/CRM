-- Accounts module (MVP_SPEC §M4).
--
-- The table itself shipped with 0002 because contacts.account_id references it.
-- This migration adds the integrity rules the module needs, and they are in the
-- database rather than only in the service for the same reason the E.164 CHECK
-- on contacts is: an import, a seed or a future code path must not be able to
-- introduce a row the service would have refused.
--
-- Three rules, in order of how badly each one hurts if it is missing:
--   1. a parent account must belong to the same tenant
--   2. an account is not its own parent
--   3. the parent chain contains no cycle
--
-- Index builds here are not CONCURRENTLY because the migration runner wraps
-- each file in one transaction. That is safe today — every accounts table in
-- existence is empty — but any later index on this table, once tenants hold
-- real data, has to be built outside a transaction.

-- ---------------------------------------------------------------------------
-- 1. A parent account must be in the same tenant.
--
-- The original foreign key referenced accounts (id) alone, which the database
-- is perfectly happy to satisfy with a row from another tenant: RLS decides
-- which rows a query can SEE, and says nothing about which rows a value may
-- POINT AT. Referential checks run with row security off, so a caller who
-- learned an id from another company could have planted it here. Nothing would
-- leak — reading the parent is still RLS-filtered — but the row would be a
-- permanent cross-tenant reference in a table we promise is tenant-isolated.
--
-- Making the key composite closes that: (tenant_id, parent_account_id) can only
-- match a row with the same tenant_id, and tenant_id is NOT NULL so the pair is
-- always checked when a parent is set.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD CONSTRAINT accounts_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE accounts DROP CONSTRAINT accounts_parent_account_id_fkey;

-- The column list on SET NULL is required: without it Postgres would try to
-- null tenant_id too, which is NOT NULL, and a hard delete of a parent would
-- fail instead of orphaning its children.
ALTER TABLE accounts ADD CONSTRAINT accounts_parent_same_tenant_fkey
  FOREIGN KEY (tenant_id, parent_account_id)
  REFERENCES accounts (tenant_id, id)
  ON DELETE SET NULL (parent_account_id);

-- ---------------------------------------------------------------------------
-- 2. An account is not its own parent. The cheapest cycle there is, and the
--    only one a CHECK constraint can see on its own.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD CONSTRAINT accounts_parent_not_self_chk
  CHECK (parent_account_id IS NULL OR parent_account_id <> id);

-- ---------------------------------------------------------------------------
-- 3. No cycles anywhere in the chain (ADR-0018).
--
-- A → B → A makes any walk of the hierarchy non-terminating: a rollup, a
-- breadcrumb, a tree render, an export. The failure is not a wrong number, it
-- is a request that never returns, so this is prevented on write rather than
-- defended against on every read.
--
-- The advisory lock is the part that is easy to leave out and impossible to
-- notice. Without it, two concurrent transactions — one setting A's parent to
-- B, the other setting B's parent to A — each walk a snapshot in which the
-- other's change does not exist, both find no cycle, and both commit one.
-- Taking a per-tenant lock first serialises hierarchy changes within a tenant,
-- and because a PL/pgSQL statement takes a fresh snapshot in READ COMMITTED,
-- the walk that runs after the lock is released sees the change that was
-- holding it. Parent changes are rare, so the contention cost is nil.
--
-- The depth guard is a termination guard, not a business rule: if data written
-- before this trigger existed already contains a cycle, the recursive term has
-- to stop somewhere rather than spin.
-- ---------------------------------------------------------------------------
CREATE FUNCTION accounts_assert_no_parent_cycle() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  creates_cycle boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('accounts.parent_account_id'),
                                hashtext(NEW.tenant_id::text));

  WITH RECURSIVE ancestors AS (
    SELECT a.id, a.parent_account_id, 1 AS depth
      FROM accounts a
     WHERE a.tenant_id = NEW.tenant_id
       AND a.id = NEW.parent_account_id
    UNION ALL
    SELECT a.id, a.parent_account_id, ancestors.depth + 1
      FROM accounts a
      JOIN ancestors ON a.id = ancestors.parent_account_id
     WHERE a.tenant_id = NEW.tenant_id
       AND ancestors.depth < 1000
  )
  SELECT EXISTS (SELECT 1 FROM ancestors WHERE ancestors.id = NEW.id)
    INTO creates_cycle;

  IF creates_cycle THEN
    RAISE EXCEPTION 'Account % cannot be placed under %: that would create a cycle',
      NEW.id, NEW.parent_account_id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'accounts_parent_cycle';
  END IF;

  RETURN NEW;
END
$$;

-- Only when a parent is actually being set, so an ordinary edit to a name or a
-- phone number does not queue behind another transaction's hierarchy change.
CREATE TRIGGER accounts_parent_no_cycle
  BEFORE INSERT OR UPDATE OF parent_account_id ON accounts
  FOR EACH ROW
  WHEN (NEW.parent_account_id IS NOT NULL)
  EXECUTE FUNCTION accounts_assert_no_parent_cycle();

-- Granted explicitly rather than relying on the PUBLIC default, matching how
-- current_tenant_id() is granted in 0004.
GRANT EXECUTE ON FUNCTION accounts_assert_no_parent_cycle() TO crm_app, crm_worker;

-- ---------------------------------------------------------------------------
-- Indexes for the module's actual queries (CLAUDE.md §7).
-- ---------------------------------------------------------------------------

-- "The children of this account", on the record page and in the cycle walk.
CREATE INDEX accounts_tenant_parent_idx
  ON accounts (tenant_id, parent_account_id)
  WHERE parent_account_id IS NOT NULL;

-- Duplicate detection by domain on create and import (MVP_SPEC M4).
CREATE INDEX accounts_tenant_domain_idx
  ON accounts (tenant_id, domain)
  WHERE deleted_at IS NULL;

-- Sorting a list by company name is the common case, and keyset pagination
-- needs id in the index to make the ordering total (ADR-0012). The existing
-- accounts_tenant_name_idx covers deleted rows too, which the Recycle Bin
-- will want, so both stay.
CREATE INDEX accounts_tenant_name_id_idx
  ON accounts (tenant_id, name, id)
  WHERE deleted_at IS NULL;

-- A name is a name: an account with a blank one is unusable in every list and
-- every lookup, and nothing else enforces it below the Zod schema.
ALTER TABLE accounts ADD CONSTRAINT accounts_name_chk CHECK (length(btrim(name)) > 0);

-- E.164, for the same reason contacts has it: a number that reached the column
-- by any route other than the API is still dialable.
ALTER TABLE accounts ADD CONSTRAINT accounts_phone_chk
  CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{1,14}$');

-- Revenue is a count of minor units and cannot be negative. The pairing of
-- amount and currency is already enforced by accounts_revenue_currency_chk.
ALTER TABLE accounts ADD CONSTRAINT accounts_revenue_sign_chk
  CHECK (annual_revenue_minor IS NULL OR annual_revenue_minor >= 0);

ALTER TABLE accounts ADD CONSTRAINT accounts_employee_count_chk
  CHECK (employee_count IS NULL OR employee_count >= 0);
