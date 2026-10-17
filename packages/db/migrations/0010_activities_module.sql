-- Activities, tasks, My Day and notifications (MVP_SPEC §M6, §6.2).
--
-- Four things, in order of how badly each one hurts if it is missing:
--   1. `activities` and `activity_links`, with the ownership column being
--      `assigned_to` rather than `owner_id` (ADR-0026)
--   2. the states an activity can be in, agreed between columns so no code
--      path can produce a half-completed task
--   3. the polymorphic target side has no foreign key (ADR-0005) but is still
--      constrained to the closed set of linkable object types
--   4. notifications and recently-viewed, plus the backfill that gives the
--      tenants that already exist their activity permissions and field
--      metadata — a migration that only equips *new* tenants leaves every
--      existing one unable to see the feature at all
--
-- Every table here is created empty, so none of the index builds takes a long
-- lock. The two ALTERs are `ADD COLUMN ... NULL`, which is metadata-only in
-- Postgres 16 and safe on a large live table.

-- ---------------------------------------------------------------------------
-- 1. Activities
-- ---------------------------------------------------------------------------
CREATE TABLE activities (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- The ownership column. Record scope, My Day and can() all read this one;
  -- there is deliberately no owner_id beside it (ADR-0026).
  assigned_to    uuid REFERENCES users (id) ON DELETE SET NULL,
  type           text NOT NULL,
  subject        text NOT NULL,
  -- Sanitized HTML. The allow-list lives in @crm/core/html and runs on write
  -- and again on read (ADR-0024); this column stores whatever survived it.
  body           text,
  due_at         timestamptz,
  completed_at   timestamptz,
  priority       text NOT NULL DEFAULT 'normal',
  status         text NOT NULL DEFAULT 'open',
  reminder_at    timestamptz,
  custom_fields  jsonb NOT NULL DEFAULT '{}'::jsonb,
  version        integer NOT NULL DEFAULT 1,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,

  -- Lets other tenant tables reference an activity without being able to
  -- reach across tenants, the pattern 0007–0009 use.
  CONSTRAINT activities_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT activities_version_chk CHECK (version > 0),
  CONSTRAINT activities_subject_chk CHECK (length(btrim(subject)) > 0),
  CONSTRAINT activities_subject_length_chk CHECK (length(subject) <= 200),
  CONSTRAINT activities_body_length_chk CHECK (body IS NULL OR length(body) <= 32000),
  CONSTRAINT activities_type_chk CHECK (type IN ('task', 'call', 'meeting', 'note')),
  CONSTRAINT activities_priority_chk CHECK (priority IN ('low', 'normal', 'high')),
  CONSTRAINT activities_status_chk CHECK (status IN ('open', 'completed', 'cancelled')),

  -- 2. "Completed" is one fact told two ways; they must agree. Without this a
  --    task could read completed with no completion time, or sit in the open
  --    list with one — and My Day would disagree with the record page.
  CONSTRAINT activities_completed_state_chk CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  -- A note records something that happened. It has nothing to be due, nothing
  -- to complete and nobody to remind, and allowing any of those would put
  -- notes in somebody's overdue list (@crm/core isSchedulable says the same).
  CONSTRAINT activities_note_not_schedulable_chk CHECK (
    type <> 'note'
    OR (due_at IS NULL AND reminder_at IS NULL AND completed_at IS NULL AND status <> 'completed')
  ),
  -- A reminder with nothing to be reminded about would fire forever.
  CONSTRAINT activities_reminder_needs_due_chk CHECK (reminder_at IS NULL OR due_at IS NOT NULL)
);

-- Keyset default order (ADR-0012), live rows only.
CREATE INDEX activities_tenant_created_idx
  ON activities (tenant_id, created_at, id) WHERE deleted_at IS NULL;
-- My Day's query: my open work, by when it is due (MVP_SPEC M6).
CREATE INDEX activities_tenant_assignee_due_idx
  ON activities (tenant_id, assigned_to, due_at, id)
  WHERE deleted_at IS NULL AND status = 'open';
CREATE INDEX activities_tenant_due_idx
  ON activities (tenant_id, due_at, id) WHERE deleted_at IS NULL;
CREATE INDEX activities_tenant_assignee_idx ON activities (tenant_id, assigned_to);
CREATE INDEX activities_custom_fields_idx ON activities USING gin (custom_fields);

-- ---------------------------------------------------------------------------
-- 3. Polymorphic links (ADR-0005)
--
-- The activity side keeps a real composite foreign key — nothing in ADR-0005
-- asks us to give that one up, and ON DELETE CASCADE means a hard-deleted
-- activity cannot leave links behind.
--
-- The target side has **no foreign key**. That is the price of the decision,
-- and it is paid in two places: the service refuses to create a link to a
-- record the caller cannot read, and the worker clears links whose target has
-- really gone (`pruneActivityLinks`). The CHECK below is not a substitute for
-- either — it only keeps `object_type` inside the closed set that
-- LINK_TARGET_TYPES names in @crm/core, so a typo cannot create a link that
-- nothing will ever resolve or clean up.
-- ---------------------------------------------------------------------------
CREATE TABLE activity_links (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  activity_id  uuid NOT NULL,
  object_type  text NOT NULL,
  record_id    uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,

  CONSTRAINT activity_links_activity_fkey
    FOREIGN KEY (tenant_id, activity_id) REFERENCES activities (tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT activity_links_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal'))
);

CREATE UNIQUE INDEX activity_links_unique
  ON activity_links (tenant_id, activity_id, object_type, record_id);
-- "The activities on this record" — how a record page reads its list.
CREATE INDEX activity_links_target_idx
  ON activity_links (tenant_id, object_type, record_id, activity_id);

-- ---------------------------------------------------------------------------
-- 4a. Notifications gain a digest marker and an idempotency key
--
-- Both nullable, so both are metadata-only ALTERs. `source_event_id` is what
-- makes the worker's notification handler idempotent under the at-least-once
-- delivery ADR-0006 promises: a redelivered event writes nothing the second
-- time rather than notifying somebody twice.
-- ---------------------------------------------------------------------------
ALTER TABLE notifications ADD COLUMN digested_at timestamptz;
ALTER TABLE notifications ADD COLUMN source_event_id uuid;

CREATE UNIQUE INDEX notifications_source_key
  ON notifications (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;
-- The bell: my unread notifications, newest first.
CREATE INDEX notifications_tenant_user_unread_idx
  ON notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;
-- The digest sweep: what this person has not been emailed about yet.
CREATE INDEX notifications_tenant_user_undigested_idx
  ON notifications (tenant_id, user_id, created_at) WHERE digested_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4b. Recently viewed (MVP_SPEC M6)
-- ---------------------------------------------------------------------------
CREATE TABLE record_views (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  object_type  text NOT NULL,
  record_id    uuid NOT NULL,
  viewed_at    timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,

  CONSTRAINT record_views_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal'))
);

-- One row per person per record, moved forward on each view: "recent" stays a
-- short indexed read instead of a growing log that has to be de-duplicated.
CREATE UNIQUE INDEX record_views_unique
  ON record_views (tenant_id, user_id, object_type, record_id);
CREATE INDEX record_views_recent_idx
  ON record_views (tenant_id, user_id, viewed_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security and grants (0004)
-- ---------------------------------------------------------------------------
CALL apply_tenant_rls('activities');
CALL apply_tenant_rls('activity_links');
CALL apply_tenant_rls('record_views');

GRANT SELECT, INSERT, UPDATE, DELETE ON activities TO crm_app, crm_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON activity_links TO crm_app, crm_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON record_views TO crm_app;
-- The worker only ever clears rows pointing at records that are gone
-- (`pruneActivityLinks`), so it needs to find them and delete them, nothing more.
GRANT SELECT, DELETE ON record_views TO crm_worker;
-- The worker writes notifications; 0004 already granted the app its reads and
-- its "mark as read" update.
GRANT SELECT, INSERT, UPDATE ON notifications TO crm_worker;

-- ---------------------------------------------------------------------------
-- Backfill for tenants that already exist
--
-- `provisionTenantDefaults` equips new tenants. Everyone already on the
-- platform needs the same two things, or activities would be invisible to
-- them: role grants, and the field metadata every form, filter and export
-- reads instead of a hardcoded list (ADR-0004).
--
-- Grants are copied from each role's **contact** grants rather than invented,
-- so a role that was narrowed by an admin — say, read-only on contacts — gets
-- exactly the same reach over activities and no more. A role with no contact
-- grants gets nothing, which is the right default-deny answer.
--
-- The temporary migrator policies are the pattern 0007 established: every
-- tenant table has FORCE ROW LEVEL SECURITY, which applies to the owner too,
-- so a backfill has to be allowed explicitly and then disallowed again. They
-- are dropped below, in this same transaction.
--
-- gen_random_uuid() rather than a UUIDv7 (ADR-0003): these ids are never
-- exposed in an API, never sorted on and never paged through, and Postgres 16
-- has no v7 generator. The application still mints v7 for every row it writes.
-- ---------------------------------------------------------------------------
CREATE POLICY role_permissions_activity_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY field_definitions_activity_backfill ON field_definitions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY tenants_activity_backfill ON tenants
  FOR SELECT TO crm_migrator USING (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), rp.tenant_id, rp.role_id, 'activity', rp.action, rp.scope,
       now(), now()
FROM role_permissions rp
WHERE rp.object_type = 'contact'
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

INSERT INTO field_definitions (id, tenant_id, object_type, key, label, type, required,
                               is_unique, options, position, is_system, is_active,
                               created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'activity', f.key, f.label, f.type, f.required,
       false, f.options, f.position, true, true, now(), now()
FROM tenants t
CROSS JOIN (
  VALUES
    ('type', 'Type', 'picklist', false,
     '[{"value":"task","label":"Task"},{"value":"call","label":"Call"},{"value":"meeting","label":"Meeting"},{"value":"note","label":"Note"}]'::jsonb,
     10),
    ('subject', 'Subject', 'text', true, NULL::jsonb, 20),
    ('body', 'Notes', 'long_text', false, NULL::jsonb, 30),
    ('due_at', 'Due', 'datetime', false, NULL::jsonb, 40),
    ('priority', 'Priority', 'picklist', false,
     '[{"value":"low","label":"Low"},{"value":"normal","label":"Normal"},{"value":"high","label":"High"}]'::jsonb,
     50),
    ('status', 'Status', 'picklist', false,
     '[{"value":"open","label":"Open"},{"value":"completed","label":"Completed"},{"value":"cancelled","label":"Cancelled"}]'::jsonb,
     60),
    ('assigned_to', 'Assigned to', 'user_lookup', false, NULL::jsonb, 70)
) AS f(key, label, type, required, options, position)
ON CONFLICT (tenant_id, object_type, key) DO NOTHING;

DROP POLICY role_permissions_activity_backfill ON role_permissions;
DROP POLICY field_definitions_activity_backfill ON field_definitions;
DROP POLICY tenants_activity_backfill ON tenants;
