-- Delivery status, bounces and the address block list (ADR-0075, PR 3a of the email plan).
--
--   email_provider_events  one row per event the mail service reported, so a replay changes nothing
--   email_suppressions     addresses a company's email is not written to, by hash, never the address
--   email_pauses           a company's email switched off after a bad run of bounces or complaints
--   email_messages         gains bounce_reason, and a column-limited read for the platform's routing role
--
-- Read ADR-0075 before changing the grants: they are part of the design of the public door that feeds these.
--
-- Size: the three tables are created empty. email_messages gains one nullable column with no default (no
-- rewrite) and one partial index on a table that is new in 0032 and small; the runner wraps the file in one
-- transaction.
--
-- Who may touch what:
--   crm_auth   (the platform's routing role) SELECT of three columns of email_messages, so an event that names
--              only the provider's id can be turned into (company, message). It sees no address, subject or body.
--   crm_app    the door's tenant step INSERTs the event row; the API reads suppressions and pauses, and may lift
--              a suppression or end a pause (a column-limited UPDATE).
--   crm_worker applies the event: it already holds the narrow UPDATE on a message's status, and now INSERTs
--              suppressions and pauses.

-- ---------------------------------------------------------------------------
-- email_messages: why a message bounced, and the routing read
-- ---------------------------------------------------------------------------
ALTER TABLE email_messages ADD COLUMN bounce_reason text;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_bounce_reason_chk
  CHECK (bounce_reason IS NULL
         OR bounce_reason IN ('mailbox_not_found', 'domain_not_found', 'mailbox_full', 'blocked', 'other'));

GRANT UPDATE (bounce_reason) ON email_messages TO crm_worker;

-- The provider's id is looked up before the company is known. Not unique: a provider id is unique in practice,
-- but a refusal here would break the worker's "sent" step, so an ambiguous id is ignored by the reader instead.
CREATE INDEX email_messages_provider_id_idx
  ON email_messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

GRANT SELECT (id, tenant_id, provider_message_id) ON email_messages TO crm_auth;
CREATE POLICY email_messages_route ON email_messages FOR SELECT TO crm_auth USING (true);

-- ---------------------------------------------------------------------------
-- email_provider_events
-- ---------------------------------------------------------------------------
CREATE TABLE email_provider_events (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider          text NOT NULL,
  -- The provider's id for this delivery of the event (Svix's message id for Resend): what a replay repeats.
  provider_event_id text NOT NULL,
  email_message_id  uuid NOT NULL,
  event_type        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_by        uuid,

  CONSTRAINT email_provider_events_type_chk CHECK (event_type IN ('delivered', 'bounced', 'complained')),
  CONSTRAINT email_provider_events_provider_chk CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT email_provider_events_event_id_chk CHECK (char_length(provider_event_id) BETWEEN 1 AND 128),
  CONSTRAINT email_provider_events_message_fkey
    FOREIGN KEY (tenant_id, email_message_id) REFERENCES email_messages (tenant_id, id) ON DELETE CASCADE
);

-- One row per event: a second delivery of the same event is recognised here and does nothing.
CREATE UNIQUE INDEX email_provider_events_once_key
  ON email_provider_events (tenant_id, provider, provider_event_id);
CREATE INDEX email_provider_events_message_idx ON email_provider_events (tenant_id, email_message_id);

CALL apply_tenant_rls('email_provider_events');
GRANT SELECT, INSERT ON email_provider_events TO crm_app;
GRANT SELECT ON email_provider_events TO crm_worker;

-- ---------------------------------------------------------------------------
-- email_suppressions
-- ---------------------------------------------------------------------------
CREATE TABLE email_suppressions (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- SHA-256 of the tenant and the lower-cased address: the list needs to recognise an address, not to hold
  -- it, so an erasure of a person leaves nothing of theirs here. The screen shows the address from the
  -- email that caused the block, while that email still holds it.
  address_hash    bytea NOT NULL,
  reason          text NOT NULL,
  source_email_id uuid,
  lifted_at       timestamptz,
  lifted_by       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,

  CONSTRAINT email_suppressions_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT email_suppressions_hash_chk CHECK (octet_length(address_hash) = 32),
  CONSTRAINT email_suppressions_reason_chk CHECK (reason IN ('hard_bounce', 'complaint', 'unsubscribed')),
  -- A complaint or an unsubscribe is the person's own refusal and cannot be undone by anyone here. Only a
  -- bounce can be lifted, after the address has been corrected. The database says so, not only the service.
  CONSTRAINT email_suppressions_lift_chk CHECK (lifted_at IS NULL OR reason = 'hard_bounce'),
  CONSTRAINT email_suppressions_lift_pair_chk CHECK ((lifted_at IS NULL) = (lifted_by IS NULL)),
  CONSTRAINT email_suppressions_source_fkey
    FOREIGN KEY (tenant_id, source_email_id) REFERENCES email_messages (tenant_id, id)
    ON DELETE SET NULL (source_email_id)
);

-- One live block per address in a company.
CREATE UNIQUE INDEX email_suppressions_live_key
  ON email_suppressions (tenant_id, address_hash) WHERE lifted_at IS NULL;
CREATE INDEX email_suppressions_tenant_created_idx ON email_suppressions (tenant_id, created_at, id);

CALL apply_tenant_rls('email_suppressions');
GRANT SELECT ON email_suppressions TO crm_app;
GRANT UPDATE (lifted_at, lifted_by, updated_at, updated_by) ON email_suppressions TO crm_app;
GRANT SELECT, INSERT ON email_suppressions TO crm_worker;

-- ---------------------------------------------------------------------------
-- email_pauses
-- ---------------------------------------------------------------------------
CREATE TABLE email_pauses (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  reason      text NOT NULL,
  paused_at   timestamptz NOT NULL DEFAULT now(),
  resumed_at  timestamptz,
  resumed_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,

  CONSTRAINT email_pauses_reason_chk CHECK (reason IN ('bounces', 'complaints')),
  CONSTRAINT email_pauses_resume_pair_chk CHECK ((resumed_at IS NULL) = (resumed_by IS NULL))
);

-- One pause at a time in a company: a second bad run while paused changes nothing.
CREATE UNIQUE INDEX email_pauses_live_key ON email_pauses (tenant_id) WHERE resumed_at IS NULL;

CALL apply_tenant_rls('email_pauses');
GRANT SELECT ON email_pauses TO crm_app;
GRANT UPDATE (resumed_at, resumed_by, updated_at, updated_by) ON email_pauses TO crm_app;
GRANT SELECT, INSERT ON email_pauses TO crm_worker;
