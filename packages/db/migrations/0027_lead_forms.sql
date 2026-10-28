-- Website lead forms (ADR-0065).
--
-- The first door anybody on the internet, with no account, can use to write into a tenant. Read
-- ADR-0065 section 3 before changing this file; the grants below ARE the design.
--
--   lead_forms               a form a company puts on its own website
--   lead_form_keys           the keys that open a form: only the SHA-256 is stored, never the key
--   lead_form_consent_texts  every wording a form's consent has had (append-only)
--   lead_form_submissions    one row per lead a form made: consent version and time, no copy of the
--                            values, no address, no user agent
--   lead_form_daily_counts   the hard daily caps, counted in the database so they hold without Redis
--
-- Who may touch what:
--   crm_auth  the platform routing role. It may read FIVE COLUMNS of lead_form_keys, so a public
--             request can turn a key into (tenant, form). It has no grant on lead_forms, leads or
--             anything else, so it cannot read a form's definition, let alone customer data.
--   crm_app   everything else, under the ordinary tenant policy. The public request does its work
--             as crm_app inside the tenant the key row named, so row-level security is on for every
--             statement that writes the lead.
--   crm_worker may delete a person's submission rows (erasure) and read the rest.
--
-- Size: all five tables are created empty, so nothing here takes a lock worth naming. The
-- backfills at the end touch one row per tenant (the lead `source` picklist) and a handful of
-- role_permissions rows per tenant; the runner wraps the file in one transaction.

-- ---------------------------------------------------------------------------
-- lead_forms
-- ---------------------------------------------------------------------------
CREATE TABLE lead_forms (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name                 text NOT NULL,
  -- A disabled form answers like a form that does not exist (ADR-0065 3.4).
  status               text NOT NULL DEFAULT 'enabled',
  -- [{ key, label, required, helpText? }], in display order. Keys are lead field keys; the
  -- service checks them against this tenant's field metadata and the allowed types.
  fields               jsonb NOT NULL DEFAULT '[]'::jsonb,
  consent_text         text NOT NULL,
  consent_version      integer NOT NULL DEFAULT 1,
  privacy_url          text,
  success_message      text NOT NULL,
  success_redirect_url text,
  -- https origins that may frame the hosted page (frame-ancestors), nothing else in v1.
  allowed_origins      text[] NOT NULL DEFAULT '{}',
  -- Calling code, digits only (91), prefixed to a number typed without a plus. Null: a plus is required.
  phone_country_code   text,
  version              integer NOT NULL DEFAULT 1,
  deleted_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,

  CONSTRAINT lead_forms_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT lead_forms_status_chk CHECK (status IN ('enabled', 'disabled')),
  CONSTRAINT lead_forms_version_chk CHECK (version > 0 AND consent_version > 0),
  CONSTRAINT lead_forms_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT lead_forms_fields_chk
    CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) <= 25),
  CONSTRAINT lead_forms_consent_chk CHECK (char_length(consent_text) BETWEEN 20 AND 1000),
  CONSTRAINT lead_forms_success_chk CHECK (char_length(success_message) BETWEEN 1 AND 500),
  CONSTRAINT lead_forms_privacy_url_chk
    CHECK (privacy_url IS NULL OR (privacy_url ~ '^https://[^[:space:]]+$' AND char_length(privacy_url) <= 500)),
  CONSTRAINT lead_forms_redirect_chk
    CHECK (success_redirect_url IS NULL
           OR (success_redirect_url ~ '^https://[^[:space:]]+$' AND char_length(success_redirect_url) <= 500)),
  CONSTRAINT lead_forms_origins_chk CHECK (cardinality(allowed_origins) <= 10),
  CONSTRAINT lead_forms_phone_code_chk
    CHECK (phone_country_code IS NULL OR phone_country_code ~ '^[1-9][0-9]{0,3}$')
);

-- A name is unique among the forms in use, ignoring case, so two forms are never confused in a list.
CREATE UNIQUE INDEX lead_forms_tenant_name_key
  ON lead_forms (tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX lead_forms_tenant_created_idx
  ON lead_forms (tenant_id, created_at, id) WHERE deleted_at IS NULL;

CALL apply_tenant_rls('lead_forms');
GRANT SELECT, INSERT, UPDATE ON lead_forms TO crm_app;
GRANT SELECT ON lead_forms TO crm_worker;

-- ---------------------------------------------------------------------------
-- lead_form_keys
-- ---------------------------------------------------------------------------
CREATE TABLE lead_form_keys (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  form_id     uuid NOT NULL,
  -- SHA-256 of the whole key. The key itself is shown once and never stored.
  key_hash    bytea NOT NULL,
  -- The last four characters, so a person can tell which key a form is on.
  hint        text NOT NULL,
  -- A rotated key keeps working until this moment (a grace window to update the website).
  retires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,

  CONSTRAINT lead_form_keys_hash_chk CHECK (octet_length(key_hash) = 32),
  CONSTRAINT lead_form_keys_hint_chk CHECK (char_length(hint) = 4),
  CONSTRAINT lead_form_keys_form_fkey
    FOREIGN KEY (tenant_id, form_id) REFERENCES lead_forms (tenant_id, id) ON DELETE CASCADE
);

-- One key is one form, platform-wide: the lookup has no tenant to narrow it.
CREATE UNIQUE INDEX lead_form_keys_hash_key ON lead_form_keys (key_hash);
CREATE INDEX lead_form_keys_form_idx ON lead_form_keys (tenant_id, form_id);

CALL apply_tenant_rls('lead_form_keys');
GRANT SELECT, INSERT, UPDATE ON lead_form_keys TO crm_app;
GRANT SELECT ON lead_form_keys TO crm_worker;

-- The one cross-tenant read a public request needs: key hash to (tenant, form). Column-limited, so
-- `SELECT *` and a read of any other column fail for crm_auth, and read-only.
GRANT SELECT (tenant_id, form_id, key_hash, retires_at, revoked_at) ON lead_form_keys TO crm_auth;
CREATE POLICY lead_form_keys_route ON lead_form_keys
  FOR SELECT TO crm_auth USING (true);

-- ---------------------------------------------------------------------------
-- lead_form_consent_texts: what each version of a form's consent said (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE lead_form_consent_texts (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  form_id    uuid NOT NULL,
  version    integer NOT NULL,
  text       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,

  CONSTRAINT lead_form_consent_texts_version_chk CHECK (version > 0),
  CONSTRAINT lead_form_consent_texts_text_chk CHECK (char_length(text) BETWEEN 20 AND 1000),
  CONSTRAINT lead_form_consent_texts_form_fkey
    FOREIGN KEY (tenant_id, form_id) REFERENCES lead_forms (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX lead_form_consent_texts_version_key
  ON lead_form_consent_texts (tenant_id, form_id, version);

CALL apply_tenant_rls('lead_form_consent_texts');
-- No UPDATE, no DELETE: a grant that is missing fails loudly, a policy that is dropped does not.
GRANT SELECT, INSERT ON lead_form_consent_texts TO crm_app;
GRANT SELECT ON lead_form_consent_texts TO crm_worker;

-- ---------------------------------------------------------------------------
-- lead_form_submissions: the consent record, and the double-submit guard
-- ---------------------------------------------------------------------------
CREATE TABLE lead_form_submissions (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  form_id          uuid NOT NULL,
  lead_id          uuid NOT NULL,
  consent_version  integer NOT NULL,
  consent_at       timestamptz NOT NULL,
  -- Always 'web_form' in v1; a column so a later door (an API key, an import) does not need a new table.
  source           text NOT NULL DEFAULT 'web_form',
  -- SHA-256 of the Idempotency-Key the page sent; cleared after the idempotency window.
  idempotency_hash bytea,
  -- A matching record found at the time, for the timeline; null when there was none.
  duplicate_of_type text,
  duplicate_of_id   uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,

  CONSTRAINT lead_form_submissions_form_fkey
    FOREIGN KEY (tenant_id, form_id) REFERENCES lead_forms (tenant_id, id) ON DELETE CASCADE,
  -- Erasing or purging the lead removes the consent record with it (ADR-0065 6).
  CONSTRAINT lead_form_submissions_lead_fkey
    FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT lead_form_submissions_hash_chk
    CHECK (idempotency_hash IS NULL OR octet_length(idempotency_hash) = 32),
  CONSTRAINT lead_form_submissions_duplicate_chk
    CHECK ((duplicate_of_type IS NULL) = (duplicate_of_id IS NULL)
           AND (duplicate_of_type IS NULL OR duplicate_of_type IN ('lead', 'contact')))
);

CREATE UNIQUE INDEX lead_form_submissions_idempotency_key
  ON lead_form_submissions (tenant_id, form_id, idempotency_hash) WHERE idempotency_hash IS NOT NULL;
CREATE INDEX lead_form_submissions_form_idx
  ON lead_form_submissions (tenant_id, form_id, created_at);
CREATE INDEX lead_form_submissions_lead_idx ON lead_form_submissions (tenant_id, lead_id);

CALL apply_tenant_rls('lead_form_submissions');
GRANT SELECT, INSERT, UPDATE ON lead_form_submissions TO crm_app;
GRANT SELECT, DELETE ON lead_form_submissions TO crm_worker;

-- ---------------------------------------------------------------------------
-- lead_form_daily_counts: the hard caps (per form, and per workspace), counted here
-- ---------------------------------------------------------------------------
CREATE TABLE lead_form_daily_counts (
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- 'form:<uuid>' or 'tenant'.
  counter_key text NOT NULL,
  day         date NOT NULL,
  count       integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, counter_key, day),
  CONSTRAINT lead_form_daily_counts_count_chk CHECK (count >= 0)
);

-- This table has no id and no author (it is a counter, not a record), so it does not use the
-- helper that assumes a `tenant_id` + standard columns beyond tenant_id.
CALL apply_tenant_rls('lead_form_daily_counts');
GRANT SELECT, INSERT, UPDATE ON lead_form_daily_counts TO crm_app;

-- ---------------------------------------------------------------------------
-- lead_form_settings: the workspace-wide pause (the kill switch)
-- ---------------------------------------------------------------------------
-- Its own table and not `tenants.settings`: the application role may not write that column (0017
-- narrowed what it can update, and `settings` also holds the workspace's security requirements), and
-- a switch that closes a door to the internet is no reason to widen that.
CREATE TABLE lead_form_settings (
  tenant_id  uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  paused     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

CALL apply_tenant_rls('lead_form_settings');
GRANT SELECT, INSERT, UPDATE ON lead_form_settings TO crm_app;
GRANT SELECT ON lead_form_settings TO crm_worker;

-- ---------------------------------------------------------------------------
-- Backfills for workspaces that already exist
-- ---------------------------------------------------------------------------
-- The migration role owns these tables and FORCE ROW LEVEL SECURITY applies to owners, so each
-- backfill needs a narrow, temporary policy for it (the pattern 0024 used).
CREATE POLICY role_permissions_lead_forms_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_lead_forms_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);
CREATE POLICY field_definitions_lead_forms_backfill ON field_definitions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);

-- `lead_form` is a new administrative object type: Owner and Admin get it for every workspace that
-- exists; a custom role gets nothing (default deny).
INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'lead_form', a.action, 'all', now(), now()
FROM roles r
CROSS JOIN (VALUES ('read'), ('create'), ('update'), ('delete')) AS a(action)
WHERE r.is_system AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

-- The lead `source` picklist gains "Web form" so a lead made by a form shows a label, not a raw
-- value. Appending keeps every value ever offered, which the 0019 trigger requires.
UPDATE field_definitions
   SET options = options || jsonb_build_array(
         jsonb_build_object('value', 'web_form', 'label', 'Web form')),
       version = version + 1,
       updated_at = now()
 WHERE object_type = 'lead'
   AND key = 'source'
   AND options IS NOT NULL
   AND jsonb_typeof(options) = 'array'
   AND NOT EXISTS (
     SELECT 1 FROM jsonb_array_elements(options) AS o WHERE o ->> 'value' = 'web_form'
   );

DROP POLICY role_permissions_lead_forms_backfill ON role_permissions;
DROP POLICY roles_lead_forms_backfill ON roles;
DROP POLICY field_definitions_lead_forms_backfill ON field_definitions;
