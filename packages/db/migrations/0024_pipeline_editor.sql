-- Pipeline and stage editor (MVP_SPEC M5, M9; ADR-0062).
--
-- Until now a pipeline's stages were written once, by provisioning, and read
-- ever after. A company editing its own pipeline needs four things the tables
-- did not have:
--
--   1. a `version` on a stage and on its pipeline, so an editor holding a stale
--      copy gets a 409 instead of silently overwriting a colleague
--   2. a way to retire a stage without deleting it (`archived_at`), because
--      deals, past events and reports still point at it
--   3. positions that are unique among the stages in use, and names that are
--      unique among them ignoring case, enforced here as well as in the service
--   4. a database refusal for the two ways a retirement could leave a wrong row:
--      retiring a stage that still holds deals, and putting a deal into a
--      retired stage
--
-- Size: `pipelines` and `pipeline_stages` hold a handful of rows per tenant (a
-- pipeline has at most a few dozen stages, and a tenant a few pipelines), so
-- the unique index builds below read a few thousand rows in total and take no
-- meaningful lock. They run in the migration's own transaction, which is why
-- they are not CREATE INDEX CONCURRENTLY. The new columns are nullable or
-- carry a constant default, so adding them rewrites nothing.
--
-- Existing data satisfies the new unique indexes: provisioning and the seed
-- space positions by ten inside one pipeline, and no name repeats inside one.
-- If a hand-edited database held a duplicate the migration would stop here,
-- loudly, rather than start with a broken pipeline.

-- ---- 1 and 2: the columns --------------------------------------------------
ALTER TABLE pipelines ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE pipelines ADD CONSTRAINT pipelines_version_chk CHECK (version > 0);

ALTER TABLE pipeline_stages ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE pipeline_stages ADD COLUMN archived_at timestamptz;
ALTER TABLE pipeline_stages ADD COLUMN archived_by uuid;
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_version_chk CHECK (version > 0);
-- Retired by someone, at a time; or neither.
ALTER TABLE pipeline_stages ADD CONSTRAINT pipeline_stages_archived_chk
  CHECK (archived_at IS NOT NULL OR archived_by IS NULL);

-- ---- 3: unique among the stages in use -------------------------------------
-- Partial, so a retired stage gives up its position and its name: a new stage
-- may be called "Proposal" again, and a restored one is placed afresh.
CREATE UNIQUE INDEX pipeline_stages_active_position_key
  ON pipeline_stages (tenant_id, pipeline_id, position)
  WHERE archived_at IS NULL;
CREATE UNIQUE INDEX pipeline_stages_active_name_key
  ON pipeline_stages (tenant_id, pipeline_id, lower(name))
  WHERE archived_at IS NULL;

-- ---- 4a. a deal cannot sit in a retired stage ------------------------------
-- The deals trigger from 0008, restated with one more rule. The new rule reads
-- the stage a deal is being placed in, and only when that placement is new (an
-- insert, or a changed stage_id), so editing a deal that is already where it is
-- never pays for it. The retirement itself moves the deals first, so by the
-- time a stage is retired there is nothing left to refuse.
CREATE OR REPLACE FUNCTION deals_assert_stage_state() RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  kind text;
  retired timestamptz;
BEGIN
  SELECT s.stage_type, s.archived_at INTO kind, retired
    FROM pipeline_stages s
   WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.stage_id;

  IF retired IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id) THEN
    RAISE EXCEPTION 'A deal cannot be placed in a retired stage'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_active';
  END IF;

  IF kind = 'won' AND (NEW.closed_at IS NULL OR NEW.probability <> 100 OR NEW.lost_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'A deal in a won stage must be closed, at probability 100, with no lost reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_state';
  ELSIF kind = 'lost' AND (NEW.closed_at IS NULL OR NEW.probability <> 0 OR NEW.lost_reason IS NULL) THEN
    RAISE EXCEPTION 'A deal in a lost stage must be closed, at probability 0, with a lost reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_state';
  ELSIF kind = 'open' AND (NEW.closed_at IS NOT NULL OR NEW.lost_reason IS NOT NULL) THEN
    RAISE EXCEPTION 'A deal in an open stage cannot be closed or carry a lost reason'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'deals_stage_state';
  END IF;

  RETURN NEW;
END
$$;

-- ---- 4b. a stage that holds deals cannot be retired ------------------------
-- "Holds" counts soft-deleted deals too: one restored from the Recycle Bin
-- would otherwise come back into a retired stage.
CREATE FUNCTION pipeline_stages_assert_empty_before_retire() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM deals d
     WHERE d.tenant_id = OLD.tenant_id AND d.stage_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Stage % holds deals, so it cannot be retired', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'pipeline_stages_empty_before_retire';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER pipeline_stages_empty_before_retire
  BEFORE UPDATE OF archived_at ON pipeline_stages
  FOR EACH ROW
  WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION pipeline_stages_assert_empty_before_retire();

GRANT EXECUTE ON FUNCTION pipeline_stages_assert_empty_before_retire() TO crm_app, crm_worker;

-- ---- the grant -------------------------------------------------------------
-- `pipeline` is a new object type (like `tenant_settings` in 0017): Owner and
-- Admin get it for every tenant that already exists. A custom role gets
-- nothing, which is the right default-deny answer.
CREATE POLICY role_permissions_m5_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_m5_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'pipeline', a.action, 'all', now(), now()
FROM roles r
CROSS JOIN (VALUES ('read'), ('create'), ('update'), ('delete')) AS a(action)
WHERE r.is_system AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY role_permissions_m5_backfill ON role_permissions;
DROP POLICY roles_m5_backfill ON roles;
