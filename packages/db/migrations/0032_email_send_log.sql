-- Email sent from a record, and the log of it (ADR-0073).
--
--   email_messages       one row per email: what was sent, to whom, and where it got to (the log)
--   email_message_links  what each email is about: (object_type, record_id), like activity_links
--   email_sender_config  one row per workspace: the name mail is sent under, the reply address, a footer
--   email_daily_counts   the send caps, counted here so they hold without Redis
--
-- Read ADR-0073 before changing the grants below: they ARE part of the design.
--
-- Who may touch what:
--   crm_app    INSERT and SELECT on email_messages, and nothing else. It CANNOT UPDATE a message, so no
--              bug or crafted request in the API can mark an email "sent": only the worker can say what
--              the provider did. A retry is a new row (retry_of), never an edit.
--   crm_worker SELECT, a column-limited UPDATE (status, provider id, failure code, attempts and times,
--              and the fields an erasure scrubs) and DELETE (a purge of a message nothing links to).
--
-- Size: all four tables are created empty, so nothing here takes a lock worth naming. The backfill at
-- the end touches a handful of role_permissions rows per workspace; the runner wraps the file in one
-- transaction.

-- ---------------------------------------------------------------------------
-- email_messages
-- ---------------------------------------------------------------------------
CREATE TABLE email_messages (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- 'inbound' is allowed now so a later step needs no CHECK rewrite; nothing writes it yet.
  direction           text NOT NULL DEFAULT 'outbound',
  -- 'delivered', 'bounced' and 'complained' are likewise reserved for the provider's own reports.
  status              text NOT NULL DEFAULT 'queued',
  -- What the user sent it from: the record they were on. For a deal, contact_id is the person written to.
  source_object_type  text NOT NULL,
  source_record_id    uuid NOT NULL,
  contact_id          uuid,
  -- What was actually used, kept so the log stays true if configuration changes later.
  from_name           text NOT NULL,
  from_address        text NOT NULL,
  reply_to            citext,
  -- Nullable only after an erasure scrubbed it (erased_at).
  to_address          citext,
  subject             text NOT NULL,
  -- Plain text only (ADR-0073): nothing stored here is ever rendered as markup.
  body_text           text NOT NULL,
  -- Our own Message-ID (<id@domain>), unique per workspace.
  message_id          text NOT NULL,
  provider_message_id text,
  -- A code from a closed list, never a provider's own words (they can repeat the address).
  failure_code        text,
  attempts            integer NOT NULL DEFAULT 0,
  -- The email this one is a second try of; the failed one stays as it was.
  retry_of            uuid,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  sending_started_at  timestamptz,
  sent_at             timestamptz,
  failed_at           timestamptz,
  erased_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,

  CONSTRAINT email_messages_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT email_messages_direction_chk CHECK (direction IN ('outbound', 'inbound')),
  CONSTRAINT email_messages_status_chk
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'delivered', 'bounced', 'complained')),
  CONSTRAINT email_messages_source_chk CHECK (source_object_type IN ('contact', 'lead', 'deal')),
  CONSTRAINT email_messages_failure_chk
    CHECK (failure_code IS NULL
           OR failure_code IN ('rejected', 'invalid_recipient', 'provider_unavailable', 'timeout',
                               'outcome_unknown', 'not_configured')),
  -- A failed message always says why.
  CONSTRAINT email_messages_failed_has_code_chk CHECK (status <> 'failed' OR failure_code IS NOT NULL),
  CONSTRAINT email_messages_attempts_chk CHECK (attempts >= 0),
  CONSTRAINT email_messages_from_name_chk CHECK (char_length(from_name) BETWEEN 1 AND 80),
  CONSTRAINT email_messages_subject_chk
    CHECK (char_length(subject) <= 200 AND (erased_at IS NOT NULL OR char_length(subject) >= 1)),
  CONSTRAINT email_messages_body_chk CHECK (char_length(body_text) <= 10000),
  -- Only a scrubbed row may be missing its recipient.
  CONSTRAINT email_messages_to_chk CHECK (erased_at IS NOT NULL OR to_address IS NOT NULL),
  CONSTRAINT email_messages_retry_fkey
    FOREIGN KEY (tenant_id, retry_of) REFERENCES email_messages (tenant_id, id) ON DELETE SET NULL (retry_of)
);

CREATE UNIQUE INDEX email_messages_tenant_message_id_key ON email_messages (tenant_id, message_id);
-- A record's emails, newest first (keyset on created_at, id).
CREATE INDEX email_messages_tenant_created_idx ON email_messages (tenant_id, created_at, id);
-- One retry per failed email: two people pressing Retry at once get one new email and one 409.
CREATE UNIQUE INDEX email_messages_retry_key ON email_messages (tenant_id, retry_of) WHERE retry_of IS NOT NULL;
-- The worker's sweep for messages stuck in flight.
CREATE INDEX email_messages_in_flight_idx
  ON email_messages (tenant_id, status, updated_at) WHERE status IN ('queued', 'sending');
-- An erasure finds a person's mail by their contact.
CREATE INDEX email_messages_contact_idx ON email_messages (tenant_id, contact_id) WHERE contact_id IS NOT NULL;

CALL apply_tenant_rls('email_messages');
GRANT SELECT, INSERT ON email_messages TO crm_app;
GRANT SELECT, DELETE ON email_messages TO crm_worker;
GRANT UPDATE (status, provider_message_id, failure_code, attempts, sending_started_at, sent_at,
              failed_at, erased_at, to_address, reply_to, subject, body_text, updated_at)
  ON email_messages TO crm_worker;

-- ---------------------------------------------------------------------------
-- email_message_links
-- ---------------------------------------------------------------------------
CREATE TABLE email_message_links (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email_message_id uuid NOT NULL,
  -- Polymorphic, so no foreign key on this side (ADR-0005): the service keeps targets honest on write
  -- and the worker clears links to records that are really gone.
  object_type      text NOT NULL,
  record_id        uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_by       uuid,

  CONSTRAINT email_message_links_type_chk CHECK (object_type IN ('account', 'contact', 'lead', 'deal')),
  CONSTRAINT email_message_links_message_fkey
    FOREIGN KEY (tenant_id, email_message_id) REFERENCES email_messages (tenant_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX email_message_links_unique
  ON email_message_links (tenant_id, email_message_id, object_type, record_id);
-- "The emails on this record", which is how a record page reads them.
CREATE INDEX email_message_links_target_idx
  ON email_message_links (tenant_id, object_type, record_id, email_message_id);

CALL apply_tenant_rls('email_message_links');
-- A merge moves a link to the surviving record, so the app role may UPDATE the target columns only.
GRANT SELECT, INSERT ON email_message_links TO crm_app;
GRANT UPDATE (record_id, updated_at, updated_by) ON email_message_links TO crm_app;
GRANT SELECT, DELETE ON email_message_links TO crm_worker;
GRANT UPDATE (record_id, updated_at, updated_by) ON email_message_links TO crm_worker;

-- ---------------------------------------------------------------------------
-- email_sender_config: the workspace's sender identity (one row)
-- ---------------------------------------------------------------------------
CREATE TABLE email_sender_config (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  from_name   text NOT NULL,
  -- Null: replies go to the person who sent the email.
  reply_to    citext,
  footer_text text,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,

  CONSTRAINT email_sender_config_tenant_key UNIQUE (tenant_id),
  CONSTRAINT email_sender_config_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT email_sender_config_version_chk CHECK (version > 0),
  CONSTRAINT email_sender_config_from_name_chk CHECK (char_length(from_name) BETWEEN 1 AND 80),
  CONSTRAINT email_sender_config_reply_to_chk CHECK (reply_to IS NULL OR char_length(reply_to) <= 254),
  CONSTRAINT email_sender_config_footer_chk CHECK (footer_text IS NULL OR char_length(footer_text) <= 500)
);

CALL apply_tenant_rls('email_sender_config');
GRANT SELECT, INSERT, UPDATE ON email_sender_config TO crm_app;
GRANT SELECT ON email_sender_config TO crm_worker;

-- ---------------------------------------------------------------------------
-- email_daily_counts: the send caps (per person, summed for the workspace), counted here
-- ---------------------------------------------------------------------------
CREATE TABLE email_daily_counts (
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  -- The day in the workspace's own time zone, so a cap does not reset at half past five in India.
  day        date NOT NULL,
  sent       integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, user_id, day),
  CONSTRAINT email_daily_counts_sent_chk CHECK (sent >= 0)
);

CREATE INDEX email_daily_counts_tenant_day_idx ON email_daily_counts (tenant_id, day);

CALL apply_tenant_rls('email_daily_counts');
GRANT SELECT, INSERT, UPDATE ON email_daily_counts TO crm_app;
GRANT SELECT ON email_daily_counts TO crm_worker;

-- ---------------------------------------------------------------------------
-- Backfill for workspaces that already exist
-- ---------------------------------------------------------------------------
-- The migration role owns these tables and FORCE ROW LEVEL SECURITY applies to owners, so the
-- backfill needs a narrow, temporary policy for it (the pattern 0024 and 0027 used).
CREATE POLICY role_permissions_email_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_email_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);

-- `email_message` is a new administrative object type: Owner, Admin, Manager and Sales Rep may send
-- and read the emails on records they can see; Read-only and any custom role get nothing (default deny).
INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'email_message', a.action, 'all', now(), now()
FROM roles r
CROSS JOIN (VALUES ('read'), ('create')) AS a(action)
WHERE r.is_system AND r.name IN ('Owner', 'Admin', 'Manager', 'Sales Rep')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY role_permissions_email_backfill ON role_permissions;
DROP POLICY roles_email_backfill ON roles;
