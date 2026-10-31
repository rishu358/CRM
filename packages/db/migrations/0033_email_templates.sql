-- Email templates, per-person signatures, and the worker's right to link a lead's emails to its contact
-- (ADR-0074, building on 0032 / ADR-0073).
--
--   email_templates   company-wide, plain-text subject and body a person can start an email from
--   email_signatures  one row per person: the lines added below what they write
--
-- Size: both tables are created empty, so nothing here takes a lock worth naming; the runner wraps the
-- file in one transaction.
--
-- Who may touch what:
--   crm_app    SELECT, INSERT and UPDATE on both (a template is a record with a version; a person edits
--              only their own signature, which the service enforces by taking the person from the
--              session, never from the request).
--   crm_worker SELECT on both, and INSERT on email_message_links, so that converting a lead can link
--              the lead's emails to the contact it became (the worker did only move and delete links).

-- ---------------------------------------------------------------------------
-- email_templates
-- ---------------------------------------------------------------------------
CREATE TABLE email_templates (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Plain text with merge fields in double braces. The API refuses a field that is not on the list;
  -- the database holds only lengths, so the list can grow without a migration.
  subject     text NOT NULL,
  body_text   text NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,

  CONSTRAINT email_templates_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT email_templates_version_chk CHECK (version > 0),
  CONSTRAINT email_templates_name_chk CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT email_templates_subject_chk CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT email_templates_body_chk CHECK (char_length(body_text) BETWEEN 1 AND 10000)
);

-- A name is unique among the templates in use, ignoring case, so two are never confused in a list.
CREATE UNIQUE INDEX email_templates_tenant_name_key
  ON email_templates (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX email_templates_tenant_created_idx
  ON email_templates (tenant_id, created_at, id) WHERE deleted_at IS NULL;

CALL apply_tenant_rls('email_templates');
GRANT SELECT, INSERT, UPDATE ON email_templates TO crm_app;
GRANT SELECT ON email_templates TO crm_worker;

-- ---------------------------------------------------------------------------
-- email_signatures
-- ---------------------------------------------------------------------------
CREATE TABLE email_signatures (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id        uuid NOT NULL,
  signature_text text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,

  CONSTRAINT email_signatures_tenant_user_key UNIQUE (tenant_id, user_id),
  CONSTRAINT email_signatures_version_chk CHECK (version > 0),
  CONSTRAINT email_signatures_text_chk CHECK (char_length(signature_text) <= 500)
);

CALL apply_tenant_rls('email_signatures');
GRANT SELECT, INSERT, UPDATE ON email_signatures TO crm_app;
GRANT SELECT ON email_signatures TO crm_worker;

-- ---------------------------------------------------------------------------
-- Linking a lead's emails to the contact it became
-- ---------------------------------------------------------------------------
-- The worker handles `lead.converted.v1` and adds a link from each of the lead's emails to the new
-- contact (and deal). It still cannot change what a message says: that grant is unchanged.
GRANT INSERT ON email_message_links TO crm_worker;
