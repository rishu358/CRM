-- Row-Level Security: the isolation boundary itself (ADR-0002, CLAUDE.md §5.1).
--
-- Read this file before changing anything in it. A mistake here is a
-- cross-tenant data breach, not a bug.
--
-- The guarantee has four parts, and all four are required:
--   1. every tenant table has ENABLE + FORCE ROW LEVEL SECURITY
--   2. its policy compares tenant_id to current_tenant_id()
--   3. current_tenant_id() reads a transaction-local GUC set by the request
--   4. no application role owns a table, is a superuser, or has BYPASSRLS
--
-- FORCE matters because the owner of a table is exempt from its policies by
-- default. Without FORCE, anything connecting as crm_migrator would see every
-- tenant's rows, and a misconfigured DATABASE_URL would silently disable
-- isolation rather than fail.

-- ---------------------------------------------------------------------------
-- Request context
-- ---------------------------------------------------------------------------

-- Reads the tenant for the current transaction.
--
-- The second argument to current_setting makes a missing GUC return NULL
-- rather than raise. NULL is the safe outcome: `tenant_id = NULL` is NULL,
-- which is not true, so a query outside a tenant-scoped transaction returns
-- zero rows and an INSERT is rejected. The system fails closed.
CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION current_app_user_id() RETURNS uuid
  LANGUAGE sql
  STABLE
  PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION current_tenant_id() TO crm_app, crm_auth, crm_worker;
GRANT EXECUTE ON FUNCTION current_app_user_id() TO crm_app, crm_auth, crm_worker;

-- ---------------------------------------------------------------------------
-- Tenant-owned tables
-- ---------------------------------------------------------------------------

-- Applies the standard isolation policy to a table with a tenant_id column.
-- Written as a procedure so that every table gets byte-identical rules and a
-- new table cannot quietly receive a weaker variant.
CREATE PROCEDURE apply_tenant_rls(table_name text)
  LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format(
    'CREATE POLICY %I ON %I FOR ALL TO crm_app, crm_worker '
    'USING (tenant_id = current_tenant_id()) '
    'WITH CHECK (tenant_id = current_tenant_id())',
    table_name || '_tenant_isolation',
    table_name
  );
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships',
    'roles',
    'role_permissions',
    'field_permissions',
    'teams',
    'team_members',
    'field_definitions',
    'saved_views',
    'accounts',
    'contacts',
    'tags',
    'record_tags',
    'timeline_events',
    'notifications'
  ] LOOP
    CALL apply_tenant_rls(t);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- tenants: the registry itself. A session sees exactly its own tenant row.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_self ON tenants
  FOR ALL TO crm_app, crm_worker
  USING (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- Signup creates the tenant before any session can name it, so that one write
-- happens as crm_auth, which is the only role allowed to insert here.
CREATE POLICY tenants_auth_all ON tenants
  FOR ALL TO crm_auth
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- users: global identity, so there is no tenant_id to compare (ADR-0014).
--
-- Instead, crm_app may only see users who share a tenant with the current
-- session, resolved through memberships. Without this, the API role could read
-- the entire platform's user directory — every customer's staff names and email
-- addresses — from any tenant's session.
--
-- crm_auth needs the whole table: at login time no tenant has been chosen yet,
-- which is exactly why it is a separate role with no access to business data.
-- ---------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_same_tenant ON users
  FOR SELECT TO crm_app, crm_worker
  USING (
    EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = current_tenant_id()
    )
  );

-- A user may edit their own profile; nobody else's, from the app role.
CREATE POLICY users_self_update ON users
  FOR UPDATE TO crm_app
  USING (id = current_app_user_id())
  WITH CHECK (id = current_app_user_id());

CREATE POLICY users_auth_all ON users
  FOR ALL TO crm_auth
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Auth tables: reachable only by crm_auth.
--
-- RLS is enabled on all of them even though crm_app holds no grant, so that if
-- a grant is ever added by mistake the default-deny of an enabled-but-unmatched
-- policy still applies. Defence in depth against a future careless migration.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'sessions', 'auth_accounts', 'verifications', 'mfa_factors', 'auth_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO crm_auth USING (true) WITH CHECK (true)',
      t || '_auth_all', t
    );
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- audit_logs: tenant-isolated and append-only (CLAUDE.md §5.10).
--
-- Append-only is enforced by withholding UPDATE and DELETE grants further down,
-- not by a policy: a policy can be dropped by a future migration without
-- anything looking unusual, whereas a missing grant makes the attempt fail.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_tenant_read ON audit_logs
  FOR SELECT TO crm_app, crm_worker
  USING (tenant_id = current_tenant_id());

CREATE POLICY audit_logs_tenant_insert ON audit_logs
  FOR INSERT TO crm_app, crm_worker
  WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- outbox_events: tenant-isolated for the API, cross-tenant for the relay.
--
-- The worker has to drain one queue across all tenants; polling 1,000 tenants
-- individually would not keep up. This is the deliberate, documented exception
-- to tenant scoping that ADR-0002 requires to be explicit, and it is confined
-- to this one table and this one role. crm_worker still has to set
-- app.tenant_id before touching anything else.
-- ---------------------------------------------------------------------------
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  FOR ALL TO crm_app
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

CREATE POLICY outbox_events_relay ON outbox_events
  FOR ALL TO crm_worker
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Grants. Least privilege, written out per table rather than wildcarded, so
-- that a table added later is unreachable until someone grants it deliberately.
-- ---------------------------------------------------------------------------

-- Business and configuration data: full CRUD for the API, subject to RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  memberships, roles, role_permissions, field_permissions,
  teams, team_members, field_definitions, saved_views,
  accounts, contacts, tags, record_tags, timeline_events, notifications
TO crm_app, crm_worker;

-- The tenant row is readable and updatable, never insertable or deletable
-- from the application: provisioning and offboarding are deliberate operations.
GRANT SELECT, UPDATE ON tenants TO crm_app, crm_worker;

-- Users: read via the membership policy, update only one's own profile.
GRANT SELECT, UPDATE ON users TO crm_app;
GRANT SELECT ON users TO crm_worker;

-- Audit log: append and read. No UPDATE, no DELETE, deliberately.
GRANT SELECT, INSERT ON audit_logs TO crm_app, crm_worker;

-- Outbox: the API writes events, the worker drains them.
GRANT SELECT, INSERT ON outbox_events TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON outbox_events TO crm_worker;

-- Auth role: identity tables only. It is granted nothing on business tables,
-- so a flaw in the auth layer cannot reach customer data.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, auth_accounts, verifications, mfa_factors, auth_events
TO crm_auth;
GRANT SELECT, INSERT, UPDATE ON tenants TO crm_auth;
GRANT SELECT, INSERT ON memberships TO crm_auth;
GRANT SELECT ON roles TO crm_auth;

-- memberships and roles are RLS-protected and crm_auth has no policy on them,
-- so these grants alone grant nothing; signup sets app.tenant_id first.
CREATE POLICY memberships_auth_all ON memberships
  FOR ALL TO crm_auth
  USING (true)
  WITH CHECK (true);

CREATE POLICY roles_auth_read ON roles
  FOR SELECT TO crm_auth
  USING (true);
