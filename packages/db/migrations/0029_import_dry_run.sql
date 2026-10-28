-- F7-2 (ADR-0068): an import can be checked before it is run.
--
-- A check is a job of its own that reads the same file with the same mapping and runs every row
-- through the real row logic, then rolls each chunk back, so it reports what would happen and
-- writes nothing. `dry_run` marks it. The column is added with a constant default, so on a large
-- live table it is a catalogue change and not a rewrite.
ALTER TABLE import_jobs ADD COLUMN dry_run boolean NOT NULL DEFAULT false;

-- The transition rule (0012) with one more fact that never changes after creation: whether the job
-- is a check. A check that became a real import, or the reverse, would be a way to write what a
-- person only asked to preview.
CREATE OR REPLACE FUNCTION import_jobs_assert_transition() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('completed', 'failed', 'rejected') THEN
    RAISE EXCEPTION 'import job % is % and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'awaiting_upload' AND NEW.status IN ('analyzing', 'rejected'))
    OR (OLD.status = 'analyzing'       AND NEW.status IN ('awaiting_mapping', 'rejected', 'failed'))
    OR (OLD.status = 'awaiting_mapping' AND NEW.status IN ('staging', 'rejected'))
    OR (OLD.status = 'staging'         AND NEW.status IN ('processing', 'rejected', 'failed'))
    OR (OLD.status = 'processing'      AND NEW.status IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'import job % cannot go from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.processed_rows < OLD.processed_rows
     OR NEW.created_count < OLD.created_count
     OR NEW.updated_count < OLD.updated_count
     OR NEW.skipped_count < OLD.skipped_count
     OR NEW.failed_count < OLD.failed_count THEN
    RAISE EXCEPTION 'import job % progress cannot go backwards', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.tenant_id <> OLD.tenant_id
     OR NEW.object_type <> OLD.object_type
     OR NEW.storage_key <> OLD.storage_key
     OR NEW.dry_run <> OLD.dry_run
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'import job % identity is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;
