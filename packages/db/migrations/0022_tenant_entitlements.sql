-- Per-workspace entitlement overrides (ADR-0047, ADR-0010).
--
-- A workspace's features come from its plan, in code (@crm/core PLAN_CATALOGUE). This table holds
-- the exceptions: a feature switched on for a pilot before it is ready for everyone, or withdrawn
-- from one customer, whatever the plan says.
--
-- The point of this migration is who may write it. A workspace must never be able to grant itself a
-- feature, so the application role and the worker get SELECT and nothing else, and the only role that
-- can change a row is `crm_auth`: the platform-level role the operator's commands already run as, and
-- the one that creates workspaces and holds the `plan` column. There is no request path that writes
-- here. The grant is the barrier; the policies below restate it so that a later GRANT by mistake would
-- still be stopped by row-level security.
--
-- Created empty, so no index build takes a long lock.

CREATE TABLE tenant_entitlements (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- A feature name from @crm/core FEATURES. Not a CHECK on the list: the list grows in code, and a
  -- migration per feature would be a migration nobody needs. An unknown name is ignored on read.
  feature    text NOT NULL,
  enabled    boolean NOT NULL,
  -- Why this workspace is an exception. Required: an override nobody can explain is the first one
  -- that gets deleted by mistake, or kept for years.
  reason     text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid,

  CONSTRAINT tenant_entitlements_feature_chk
    CHECK (feature ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT tenant_entitlements_reason_chk
    CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500)
);

-- One decision per workspace and feature. It is also the lookup every request makes ("this
-- workspace's overrides"), because the tenant leads the key.
CREATE UNIQUE INDEX tenant_entitlements_feature_key
  ON tenant_entitlements (tenant_id, feature);

ALTER TABLE tenant_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_entitlements FORCE ROW LEVEL SECURITY;

-- A session reads its own workspace's rows only, and cannot write any.
CREATE POLICY tenant_entitlements_read ON tenant_entitlements
  FOR SELECT TO crm_app, crm_worker
  USING (tenant_id = current_tenant_id());

-- The operator's role sees and changes every workspace's, like the other platform-level tables.
CREATE POLICY tenant_entitlements_operator ON tenant_entitlements
  FOR ALL TO crm_auth
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON tenant_entitlements TO crm_app, crm_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_entitlements TO crm_auth;
