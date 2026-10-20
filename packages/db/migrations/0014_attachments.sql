-- Record attachments (MVP_SPEC §6.1, ADR-0005, ADR-0035).
--
-- The table MVP_SPEC §6.1 named and §5.12 was half-written for: a file a user
-- supplies, attached to any record, downloaded by other users. The row holds
-- *about* the file and never the file: the bytes live in object storage under
-- a random key and are reachable only through a short-lived presigned URL.
--
-- Four things worth reading before changing it:
--
--   1. `(object_type, record_id)` is the polymorphic pair (ADR-0005), so there
--      is **no foreign key to the target**. The CHECK below is not a
--      substitute: it only keeps `object_type` inside the closed set
--      ATTACHMENT_TARGET_TYPES names in @crm/core, so a typo cannot create a
--      row nothing will ever resolve or clean up. Integrity on write is the
--      service's job, and orphan cleanup is the worker's.
--   2. `status` is the upload's state machine. A row exists before its bytes
--      do, and nothing lists or signs a download for a row that has not been
--      through the worker's byte check.
--   3. There is **no `version`**. An attachment cannot be edited — there is
--      no PATCH — so there is nothing for optimistic locking to protect, and
--      a column nobody can move is a column that only misleads.
--   4. `deleted_at` is a soft delete, and the *bytes* outlive it deliberately:
--      an undelete that cannot bring the file back is not an undelete. The
--      worker removes both when the retention window passes (ADR-0035).
--
-- Created empty, so no index build takes a long lock.

CREATE TABLE attachments (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type     text NOT NULL,
  record_id       uuid NOT NULL,
  -- 256 random bits from the CSPRNG. The filename is never part of it: a
  -- user-typed name in a key is a traversal and enumeration surface (§5.12).
  file_key        text NOT NULL,
  -- Display only. Separators, traversal, control characters and bidirectional
  -- overrides are refused by the contract and sanitised again at download.
  file_name       text NOT NULL,
  -- Chosen by the server from the allow-listed extension, never by the client,
  -- and the type the presigned PUT is bound to and the download served as.
  mime            text NOT NULL,
  size_bytes      bigint NOT NULL,
  status          text NOT NULL DEFAULT 'awaiting_upload',
  detected_format text,
  failure_reason  text,
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,

  CONSTRAINT attachments_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal', 'activity')),
  CONSTRAINT attachments_status_chk
    CHECK (status IN ('awaiting_upload', 'scanning', 'ready', 'rejected')),
  CONSTRAINT attachments_file_name_chk
    CHECK (length(btrim(file_name)) > 0 AND length(file_name) <= 255),
  -- Repeats in the database what the contract and the presigned URL already
  -- say: 25 MB, and never zero (an empty file has no type to detect).
  CONSTRAINT attachments_size_chk
    CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  -- A refusal must say why, and a file that is fine must not claim a reason.
  CONSTRAINT attachments_rejection_chk
    CHECK ((status = 'rejected') = (failure_reason IS NOT NULL))
);

-- "The files on this record": how the record page reads its list, in keyset
-- order (ADR-0012), live rows only.
CREATE INDEX attachments_target_idx
  ON attachments (tenant_id, object_type, record_id, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX attachments_tenant_created_idx
  ON attachments (tenant_id, created_at, id);
-- Keys are random, so a collision is a bug rather than an attack. This turns
-- that bug into a failed insert instead of two rows sharing one file.
CREATE UNIQUE INDEX attachments_file_key
  ON attachments (tenant_id, file_key);

-- ---------------------------------------------------------------------------
-- Row-Level Security and grants (0004)
--
-- The worker needs UPDATE (it records the result of the byte check) and
-- DELETE (it purges a deleted attachment's row once the bytes are gone, and
-- clears rows whose target record has really disappeared). It never inserts:
-- only a request creates an attachment.
-- ---------------------------------------------------------------------------
CALL apply_tenant_rls('attachments');

GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO crm_app;
GRANT SELECT, UPDATE, DELETE ON attachments TO crm_worker;

-- No role_permissions or field_definitions backfill, and that is the decision
-- rather than an omission: an attachment is not an object in its own right in
-- the permissions model. Reading one requires `read` on the record it hangs
-- from, and adding or removing one requires `update` on that record, judged
-- against the actor's scope by the same can() call the record's own module
-- makes (ADR-0035). So every tenant that already exists has exactly the right
-- permissions the moment this ships, and nothing has to be copied.
