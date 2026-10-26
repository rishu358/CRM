-- Saved views and bulk actions (MVP_SPEC M4, ADR-0056).
--
-- Two changes, both additive and both safe on a large live table:
--
--   1. saved_views already exists (0001) with RLS (0004) but nothing used it. It gains `version`
--      for optimistic locking, the constraints the API relies on, and the three **visibility**
--      rules below, enforced by the database as well as by the service.
--   2. bulk_operations remembers the result of a bulk action that carried an Idempotency-Key, so a
--      retry after a dropped connection replays the answer instead of editing, deleting or
--      tagging the same records twice.
--
-- Nothing here is destructive. `version` is added with a default (no rewrite on Postgres 11+),
-- the CHECK constraints are added NOT VALID and then validated, and bulk_operations is created
-- empty.

-- ---------------------------------------------------------------------------
-- saved_views
-- ---------------------------------------------------------------------------

ALTER TABLE saved_views ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE saved_views
  ADD CONSTRAINT saved_views_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal')) NOT VALID,
  ADD CONSTRAINT saved_views_name_chk
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 80) NOT VALID,
  -- A view always has an owner: the person who made it is the one who may change it.
  ADD CONSTRAINT saved_views_owner_chk
    CHECK (created_by IS NOT NULL) NOT VALID;

ALTER TABLE saved_views VALIDATE CONSTRAINT saved_views_object_type_chk;
ALTER TABLE saved_views VALIDATE CONSTRAINT saved_views_name_chk;
ALTER TABLE saved_views VALIDATE CONSTRAINT saved_views_owner_chk;

-- Who may SEE a view. These are RESTRICTIVE: they are ANDed with the tenant-isolation policy from
-- 0004, so they can only narrow what that policy allows and a mistake here can never widen access
-- across tenants. They name `crm_app` only; the worker (which builds the tenant archive) keeps
-- the plain tenant policy.
--
--   private  the creator only
--   team     the creator and anyone who shares at least one team with them
--   tenant   everyone in the workspace
CREATE POLICY saved_views_visible ON saved_views
  AS RESTRICTIVE FOR SELECT TO crm_app
  USING (
    created_by = current_app_user_id()
    OR visibility = 'tenant'
    OR (
      visibility = 'team'
      AND EXISTS (
        SELECT 1
        FROM team_members mine
        JOIN team_members theirs
          ON theirs.tenant_id = mine.tenant_id
         AND theirs.team_id = mine.team_id
        WHERE mine.tenant_id = saved_views.tenant_id
          AND mine.user_id = current_app_user_id()
          AND theirs.user_id = saved_views.created_by
      )
    )
  );

-- Who may CHANGE a view: its creator, and only as themselves. Sharing a view lets others use it,
-- never edit it.
CREATE POLICY saved_views_own_insert ON saved_views
  AS RESTRICTIVE FOR INSERT TO crm_app
  WITH CHECK (created_by = current_app_user_id());

CREATE POLICY saved_views_own_update ON saved_views
  AS RESTRICTIVE FOR UPDATE TO crm_app
  USING (created_by = current_app_user_id())
  WITH CHECK (created_by = current_app_user_id());

CREATE POLICY saved_views_own_delete ON saved_views
  AS RESTRICTIVE FOR DELETE TO crm_app
  USING (created_by = current_app_user_id());

-- ---------------------------------------------------------------------------
-- bulk_operations
-- ---------------------------------------------------------------------------

CREATE TABLE bulk_operations (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- A key is the caller's own: the same key from two people is two operations.
  idempotency_key text NOT NULL,
  object_type     text NOT NULL,
  action          text NOT NULL,
  -- SHA-256 of the canonical request, so a key reused for a different request is refused rather
  -- than answered with the wrong result.
  request_hash    text NOT NULL,
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL,
  updated_by      uuid,
  CONSTRAINT bulk_operations_key_chk
    CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{1,128}$')
);

CREATE UNIQUE INDEX bulk_operations_key
  ON bulk_operations (tenant_id, created_by, idempotency_key);
-- The retention sweep ("this person's keys older than a day") and nothing else reads by time.
CREATE INDEX bulk_operations_created_idx
  ON bulk_operations (tenant_id, created_by, created_at);

CALL apply_tenant_rls('bulk_operations');

-- A person sees and replays only their own operations, on top of the tenant policy.
CREATE POLICY bulk_operations_own ON bulk_operations
  AS RESTRICTIVE FOR ALL TO crm_app
  USING (created_by = current_app_user_id())
  WITH CHECK (created_by = current_app_user_id());

GRANT SELECT, INSERT, DELETE ON bulk_operations TO crm_app;
GRANT SELECT, DELETE ON bulk_operations TO crm_worker;
