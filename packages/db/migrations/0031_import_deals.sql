-- F7-4 (ADR-0070): deals can be imported.
--
-- 1. An import job may be about deals.
-- 2. A deal may carry the person's own id for it (`external_id`), so importing the same file again
--    updates the deals instead of doubling them. It is unique among a company's live deals, and a
--    deal with none is unaffected. Added nullable and without a default, so on a large live table
--    this is a catalogue change; the unique index is built on an all-NULL column and is empty.

ALTER TABLE import_jobs DROP CONSTRAINT import_jobs_object_type_chk;
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_object_type_chk
  CHECK (object_type IN ('account', 'contact', 'lead', 'deal'));

ALTER TABLE deals ADD COLUMN external_id text;
ALTER TABLE deals
  ADD CONSTRAINT deals_external_id_chk
  CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 200);

CREATE UNIQUE INDEX deals_tenant_external_id_key
  ON deals (tenant_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;
