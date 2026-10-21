-- ---------------------------------------------------------------------------
-- 0017: company setup, the setup checklist and the sample-data registry
-- (MVP_SPEC M2).
--
-- Three things, in the order they matter.
--
-- 1. THE APP ROLE LOSES ITS BLANKET UPDATE ON `tenants`.
--
--    0004 granted `crm_app` and `crm_worker` table-wide UPDATE on `tenants`.
--    RLS limits them to their own tenant's row, but not to any particular
--    column, so a bug anywhere in a request path could have rewritten `plan`,
--    `status`, `slug` or `region` on the row it was serving. Nothing did,
--    because no endpoint wrote to `tenants` at all: sign-up activates a tenant
--    as `crm_auth`, and the one test fixture that touches the table is a
--    superuser. That is the kind of grant that is harmless until the day the
--    first endpoint arrives — and this migration is that day, because company
--    setup is the first thing that lets a user edit their own tenant.
--
--    So the broad grant is withdrawn and the app role gets UPDATE on the
--    columns a company-profile screen edits, and nothing else. It is a grant
--    rather than a policy for the reason 0004 gave about the audit log: a
--    policy can be dropped by a later migration without anything looking
--    unusual, whereas a missing grant makes the attempt fail. The worker keeps
--    SELECT and loses UPDATE; nothing in it writes the table.
--
-- 2. `industry` and `setup_completed_at` on `tenants`.
--
--    `industry` is a short key (the contract holds the list, so adding one
--    needs no migration) and is nullable: a tenant that skipped the question
--    is not an invalid tenant. `setup_completed_at` is what decides whether a
--    founding administrator is sent to the setup screen. Every tenant that
--    already exists is marked complete here, so a deployment does not put a
--    wizard in front of people who have been working for months.
--
-- 3. `sample_records`.
--
--    "Remove sample data deletes only seeded records" needs the seeded records
--    to be knowable. A flag column on accounts, contacts, leads, deals and
--    activities would put an ALTER on five of the largest tables for a feature
--    that touches a few dozen rows once per tenant (CLAUDE.md section 7), and
--    would leave every new object type to remember to add its own. A registry
--    keyed `(object_type, record_id)` is the polymorphic-link shape ADR-0005
--    already chose, so custom objects plug in later without a migration. Rows
--    are facts about how a record began: nothing updates them, so `crm_app`
--    is given no UPDATE.
--
-- `tenant_settings` is a new object type, granted to Owner and Admin by
-- backfill below, like `role` and `team` were in 0013. Every tenant that
-- already exists needs the rows or the screens this migration exists for would
-- be unreachable by their own administrators. A custom role gets nothing: that
-- is the right default-deny answer.
-- ---------------------------------------------------------------------------

-- ---- 1 and 2: tenants ------------------------------------------------------
ALTER TABLE tenants ADD COLUMN industry text;
ALTER TABLE tenants ADD COLUMN setup_completed_at timestamptz;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_industry_chk
  CHECK (industry IS NULL OR length(btrim(industry)) BETWEEN 1 AND 80);

-- `tenants` has FORCE ROW LEVEL SECURITY, which applies to its owner too, so a
-- backfill has to be allowed explicitly and disallowed again in this same
-- transaction (the pattern 0007, 0010 and 0016 established).
CREATE POLICY tenants_m2_backfill ON tenants
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);

UPDATE tenants SET setup_completed_at = created_at WHERE setup_completed_at IS NULL;

DROP POLICY tenants_m2_backfill ON tenants;

REVOKE UPDATE ON tenants FROM crm_app, crm_worker;
GRANT UPDATE (name, default_currency, timezone, locale, fiscal_year_start_month,
              industry, setup_completed_at, updated_at)
  ON tenants TO crm_app;

-- ---- 3: the sample-data registry ------------------------------------------
CREATE TABLE sample_records (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  object_type text NOT NULL,
  record_id   uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,

  CONSTRAINT sample_records_object_type_chk
    CHECK (object_type IN ('account', 'contact', 'lead', 'deal', 'activity'))
);

-- One registration per record, and the lookup removal makes: "every sample
-- record of this type in this tenant". Tenant first, like every index here.
CREATE UNIQUE INDEX sample_records_target_key
  ON sample_records (tenant_id, object_type, record_id);

CALL apply_tenant_rls('sample_records');

-- The API registers records as it loads them and deregisters the ones removal
-- keeps. The worker's purge sweep deletes a purged record's registration, as it
-- does for every other polymorphic reference (ADR-0005), so it needs DELETE.
GRANT SELECT, INSERT, DELETE ON sample_records TO crm_app;
GRANT SELECT, DELETE ON sample_records TO crm_worker;

-- ---- backfill the new grants ----------------------------------------------
CREATE POLICY role_permissions_m2_backfill ON role_permissions
  FOR ALL TO crm_migrator USING (true) WITH CHECK (true);
CREATE POLICY roles_m2_backfill ON roles
  FOR SELECT TO crm_migrator USING (true);

INSERT INTO role_permissions (id, tenant_id, role_id, object_type, action, scope,
                              created_at, updated_at)
SELECT gen_random_uuid(), r.tenant_id, r.id, 'tenant_settings', a.action, 'all', now(), now()
FROM roles r
CROSS JOIN (VALUES ('read'), ('update')) AS a(action)
WHERE r.is_system AND r.name IN ('Owner', 'Admin')
ON CONFLICT (tenant_id, role_id, object_type, action) DO NOTHING;

DROP POLICY role_permissions_m2_backfill ON role_permissions;
DROP POLICY roles_m2_backfill ON roles;
