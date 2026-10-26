-- CRM business objects (MVP_SPEC §6.2).
--
-- Standard fields are real columns with real types and constraints; anything a
-- tenant adds lives in custom_fields jsonb with a GIN index (ADR-0004).
--
-- Every list index starts with tenant_id and ends with id: tenant_id because
-- RLS always adds that predicate, and id because keyset pagination needs a
-- total order (ADR-0012).

CREATE TABLE accounts (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id                  uuid REFERENCES users (id) ON DELETE SET NULL,
  name                      text NOT NULL,
  domain                    text,
  industry                  text,
  phone                     text,
  email                     citext,
  website                   text,
  gstin                     text,
  billing_address           jsonb,
  shipping_address          jsonb,
  annual_revenue_minor      bigint,
  annual_revenue_currency   text,
  employee_count            bigint,
  parent_account_id         uuid REFERENCES accounts (id) ON DELETE SET NULL,
  custom_fields             jsonb NOT NULL DEFAULT '{}'::jsonb,
  version                   integer NOT NULL DEFAULT 1,
  deleted_at                timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  created_by                uuid,
  updated_by                uuid,
  CONSTRAINT accounts_version_chk CHECK (version > 0),
  -- An amount without its currency is meaningless (ADR-0011); require both or neither.
  CONSTRAINT accounts_revenue_currency_chk CHECK (
    (annual_revenue_minor IS NULL) = (annual_revenue_currency IS NULL)
  ),
  CONSTRAINT accounts_revenue_currency_format_chk CHECK (
    annual_revenue_currency IS NULL OR annual_revenue_currency ~ '^[A-Z]{3}$'
  )
);
CREATE INDEX accounts_tenant_created_idx
  ON accounts (tenant_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX accounts_tenant_owner_idx ON accounts (tenant_id, owner_id);
CREATE INDEX accounts_tenant_name_idx ON accounts (tenant_id, name);
CREATE INDEX accounts_custom_fields_idx ON accounts USING gin (custom_fields);
-- Fuzzy duplicate detection on company name (MVP_SPEC M4).
CREATE INDEX accounts_name_trgm_idx ON accounts USING gin (name gin_trgm_ops);

CREATE TABLE contacts (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  first_name    text,
  last_name     text NOT NULL,
  email         citext,
  phone         text,
  whatsapp      text,
  title         text,
  account_id    uuid REFERENCES accounts (id) ON DELETE SET NULL,
  address       jsonb,
  lead_source   text,
  consent       jsonb NOT NULL DEFAULT '{}'::jsonb,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  version       integer NOT NULL DEFAULT 1,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_by    uuid,
  CONSTRAINT contacts_version_chk CHECK (version > 0),
  CONSTRAINT contacts_last_name_chk CHECK (length(btrim(last_name)) > 0),
  -- E.164 enforced at the column, not only in Zod, so an import or a future
  -- code path cannot introduce an unnormalised number.
  CONSTRAINT contacts_phone_chk CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{1,14}$'),
  CONSTRAINT contacts_whatsapp_chk CHECK (whatsapp IS NULL OR whatsapp ~ '^\+[1-9][0-9]{1,14}$')
);
CREATE INDEX contacts_tenant_created_idx
  ON contacts (tenant_id, created_at, id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_tenant_owner_idx ON contacts (tenant_id, owner_id);
CREATE INDEX contacts_tenant_account_idx ON contacts (tenant_id, account_id);
CREATE INDEX contacts_tenant_email_idx
  ON contacts (tenant_id, email) WHERE deleted_at IS NULL;
CREATE INDEX contacts_tenant_phone_idx
  ON contacts (tenant_id, phone) WHERE deleted_at IS NULL;
CREATE INDEX contacts_tenant_last_name_idx
  ON contacts (tenant_id, last_name, id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_custom_fields_idx ON contacts USING gin (custom_fields);

-- ---------------------------------------------------------------------------
-- Polymorphic attachments to any record (ADR-0005).
-- These deliberately have no foreign key to the target: object_type decides
-- which table it is, so integrity is the service layer's job and orphans are
-- cleaned up by a worker reacting to delete events.
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text NOT NULL,
  color      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);
CREATE UNIQUE INDEX tags_tenant_name_key ON tags (tenant_id, name);

CREATE TABLE record_tags (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  object_type text NOT NULL,
  record_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  CONSTRAINT record_tags_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal', 'activity'))
);
CREATE UNIQUE INDEX record_tags_unique ON record_tags (tenant_id, tag_id, object_type, record_id);
CREATE INDEX record_tags_target_idx ON record_tags (tenant_id, object_type, record_id);

CREATE TABLE timeline_events (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type     text NOT NULL,
  record_id       uuid NOT NULL,
  event_type      text NOT NULL,
  summary         text NOT NULL,
  detail          jsonb,
  actor_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  -- The outbox event this was projected from. The unique index below is what
  -- makes the projection idempotent under at-least-once delivery (ADR-0006).
  source_event_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  CONSTRAINT timeline_events_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal', 'activity'))
);
CREATE INDEX timeline_events_target_idx
  ON timeline_events (tenant_id, object_type, record_id, created_at);
CREATE UNIQUE INDEX timeline_events_source_key ON timeline_events (tenant_id, source_event_id);
