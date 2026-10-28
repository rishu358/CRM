-- Record merge (MVP_SPEC M4; ADR-0064).
--
-- Folding a duplicate contact or account into the one that stays needs two things the database did not
-- have:
--
--   1. a record of which record was merged into which, that outlives the Recycle Bin's 30 days, so an
--      old link or API id can be answered "merged into ..." instead of a silent 404
--   2. a way for a converted lead to follow its contact or account to the surviving record, which a
--      trigger (migration 0009, ADR-0022) forbids on purpose
--
-- `record_merges` is a new, empty table, so none of its index builds takes a lock that matters. It holds
-- ids, counts, who and when, and no personal data, which is why a purged loser's row may stay: the
-- loser's own row, with its name and e-mail, is gone with the purge (and an erasure request, ADR-0032,
-- has nothing to redact here). Nothing is added to `contacts` or `accounts`, two tables that can be large.
--
-- The trigger change is the part to read twice. It is written so the *only* additional thing allowed is
-- "this lead's contact (or account) link moves from record A to record B, in a transaction that also
-- wrote the row saying A was merged into B". Everything else the old trigger refused is still refused.

CREATE TABLE record_merges (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type text NOT NULL,
  -- The record that was folded away, and the one that stayed. Not foreign keys: the loser is
  -- hard-deleted by the Recycle Bin purge and this row is meant to outlive it (ADR-0005 gave up the
  -- foreign key on polymorphic references for the same reason).
  loser_id    uuid NOT NULL,
  master_id   uuid NOT NULL,
  -- How many rows of each kind moved: counts only, never the rows.
  moved       jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_at   timestamptz NOT NULL DEFAULT now(),
  -- Set when the loser is restored from the Recycle Bin: from then on it is a record again and the
  -- old id stops answering "merged".
  undone_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT record_merges_object_type_chk CHECK (object_type IN ('contact', 'account')),
  CONSTRAINT record_merges_distinct_chk CHECK (loser_id <> master_id)
);

-- One live pointer per merged-away record: the lookup an old id makes.
CREATE UNIQUE INDEX record_merges_loser_key
  ON record_merges (tenant_id, object_type, loser_id) WHERE undone_at IS NULL;
-- "What was folded into this record", and the re-pointing when the master is itself merged later.
CREATE INDEX record_merges_master_idx
  ON record_merges (tenant_id, object_type, master_id) WHERE undone_at IS NULL;

CALL apply_tenant_rls('record_merges');

-- The API writes a pointer, collapses a chain (A into B, then B into C: A's row now says C) and marks a
-- pointer undone on restore. It may change nothing else on an existing row.
GRANT SELECT, INSERT ON record_merges TO crm_app;
GRANT UPDATE (master_id, undone_at, updated_at, updated_by) ON record_merges TO crm_app;
GRANT SELECT ON record_merges TO crm_worker;

-- ---------------------------------------------------------------------------
-- A converted lead may follow its contact or account to the record it was merged into.
--
-- Same function as in 0009, with one carve-out per link. A link may change to a different, non-null
-- target only when a `record_merges` row says the OLD target was merged into the NEW one, that row has
-- not been undone, and it was written in this very transaction (`merged_at = now()`, and `now()` is
-- the transaction's start, the same in every statement and savepoint of it). A direct UPDATE from the
-- application outside a merge has no such row and is refused exactly as before. The deal link has no
-- carve-out: deals are not merged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION leads_assert_conversion_final() RETURNS trigger
  LANGUAGE plpgsql
AS $fn$
DECLARE
  contact_followed_merge boolean := false;
  account_followed_merge boolean := false;
BEGIN
  IF NEW.converted_contact_id IS DISTINCT FROM OLD.converted_contact_id
     AND NEW.converted_contact_id IS NOT NULL
     AND OLD.converted_contact_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM record_merges rm
      WHERE rm.tenant_id = OLD.tenant_id
        AND rm.object_type = 'contact'
        AND rm.loser_id = OLD.converted_contact_id
        AND rm.master_id = NEW.converted_contact_id
        AND rm.undone_at IS NULL
        AND rm.merged_at = now()
    ) INTO contact_followed_merge;
  END IF;

  IF NEW.converted_account_id IS DISTINCT FROM OLD.converted_account_id
     AND NEW.converted_account_id IS NOT NULL
     AND OLD.converted_account_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM record_merges rm
      WHERE rm.tenant_id = OLD.tenant_id
        AND rm.object_type = 'account'
        AND rm.loser_id = OLD.converted_account_id
        AND rm.master_id = NEW.converted_account_id
        AND rm.undone_at IS NULL
        AND rm.merged_at = now()
    ) INTO account_followed_merge;
  END IF;

  IF NEW.converted_at IS DISTINCT FROM OLD.converted_at
     OR NEW.status <> 'converted'
     OR (NEW.converted_contact_id IS DISTINCT FROM OLD.converted_contact_id
         AND NEW.converted_contact_id IS NOT NULL
         AND NOT contact_followed_merge)
     OR (NEW.converted_account_id IS DISTINCT FROM OLD.converted_account_id
         AND NEW.converted_account_id IS NOT NULL
         AND NOT account_followed_merge)
     OR (NEW.converted_deal_id IS DISTINCT FROM OLD.converted_deal_id
         AND NEW.converted_deal_id IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Lead % has already been converted; its conversion cannot be changed', OLD.id
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'leads_conversion_final';
  END IF;

  RETURN NEW;
END
$fn$;
