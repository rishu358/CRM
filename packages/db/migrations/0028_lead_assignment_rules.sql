-- Lead assignment rules (ADR-0065 10): who gets a new lead.
--
--   lead_assignment_rules     an ordered list per company: conditions on a lead, and one action
--   lead_assignment_pointers  where each team round-robin rule has got to (one row per rule)
--   lead_assignment_settings  the company's default owner
--
-- The pointer row is what makes round-robin fair under concurrency: a submission locks it
-- (SELECT ... FOR UPDATE) inside its own transaction, so two simultaneous submissions take turns.
--
-- All three are created empty, so nothing takes a lock worth naming. The backfill gives Owner and
-- Admin of every existing company the new `lead_assignment` grant; a custom role gets nothing.

CREATE TABLE lead_assignment_rules (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Rules are tried in this order (ties by id). Rewritten whole by a reorder.
  position    integer NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  -- web_form, manual, import: only web_form is acted on in this version.
  applies_to  text[] NOT NULL DEFAULT '{web_form}',
  -- [{ field, operator, value? }], all of which must hold. Empty: matches every lead.
  conditions  jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { type: 'user', userId } | { type: 'team_round_robin', teamId } | { type: 'default_owner' }
  action      jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,

  CONSTRAINT lead_assignment_rules_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT lead_assignment_rules_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT lead_assignment_rules_version_chk CHECK (version > 0),
  CONSTRAINT lead_assignment_rules_applies_chk
    CHECK (cardinality(applies_to) BETWEEN 1 AND 3
           AND applies_to <@ ARRAY['web_form', 'manual', 'import']),
  CONSTRAINT lead_assignment_rules_conditions_chk
    CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) <= 10),
  CONSTRAINT lead_assignment_rules_action_chk
    CHECK (jsonb_typeof(action) = 'object'
           AND action ->> 'type' IN ('user', 'team_round_robin', 'default_owner'))
);

CREATE UNIQUE INDEX lead_assignment_rules_name_key
  ON lead_assignment_rules (tenant_id, lower(name));
CREATE INDEX lead_assignment_rules_order_idx
  ON lead_assignment_rules (tenant_id, position, id);

-- At most 50 rules per company, whoever writes them: counted under an advisory lock so two
-- administrators adding a rule at once cannot both be the fifty-first.
CREATE FUNCTION lead_assignment_rules_cap() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('lead_assignment_rules:' || NEW.tenant_id::text, 0));
  IF (SELECT count(*) FROM lead_assignment_rules WHERE tenant_id = NEW.tenant_id) >= 50 THEN
    RAISE EXCEPTION 'A company can have at most 50 assignment rules'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'lead_assignment_rules_cap';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER lead_assignment_rules_cap
  BEFORE INSERT ON lead_assignment_rules
  FOR EACH ROW EXECUTE FUNCTION lead_assignment_rules_cap();

GRANT EXECUTE ON FUNCTION lead_assignment_rules_cap() TO crm_app;

CALL apply_tenant_rls('lead_assignment_rules');
GRANT SELECT, INSERT, UPDATE, DELETE ON lead_assignment_rules TO crm_app;
GRANT SELECT ON lead_assignment_rules TO crm_worker;

CREATE TABLE lead_assignment_pointers (
  tenant_id    uuid NOT NULL,
  rule_id      uuid NOT NULL,
  -- The last person this rule gave a lead to; null before the first.
  last_user_id uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, rule_id),
  CONSTRAINT lead_assignment_pointers_rule_fkey
    FOREIGN KEY (tenant_id, rule_id) REFERENCES lead_assignment_rules (tenant_id, id)
    ON DELETE CASCADE
);

CALL apply_tenant_rls('lead_assignment_pointers');
GRANT SELECT, INSERT, UPDATE ON lead_assignment_pointers TO crm_app;
GRANT SELECT ON lead_assignment_pointers TO crm_worker;

CREATE TABLE lead_assignment_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Who gets a lead when no rule decides, if still able to work leads.
  default_owner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid,

  CONSTRAINT lead_assignment_settings_version_chk CHECK (version > 0)
);

CALL apply_tenant_rls('lead_assignment_settings');
GRANT SELECT, INSERT, UPDATE ON lead_assignment_settings TO crm_app;
GRANT SELECT ON lead_assignment_settings TO crm_worker;

-- ---------------------------------------------------------------------------
-- The grant, for workspaces that already exist (the pattern 0024 and 0027 used)
-- ---------------------------------------------------------------------------
CREATE POLICY role_permissions_lead_assignment_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_lead_assignment_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'lead_assignment', a.action, 'all', now(), now()
FROM roles r
CROSS JOIN (VALUES ('read'), ('create'), ('update'), ('delete')) AS a(action)
WHERE r.is_system AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY role_permissions_lead_assignment_backfill ON role_permissions;
DROP POLICY roles_lead_assignment_backfill ON roles;
