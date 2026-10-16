-- Bootstrap: extensions and database roles.
--
-- Runs as a superuser, because role creation is an infrastructure concern that
-- migrations deliberately cannot perform: crm_migrator has NOCREATEROLE, so a
-- compromised migration cannot mint itself a more privileged role.
--
-- The same file runs in three places and must stay idempotent:
--   * local dev, via the Postgres container's entrypoint
--   * the Testcontainers harness in packages/db/src/testing
--   * production, applied once by infrastructure
--
-- Four roles, each with the least privilege its job needs:
--   crm_migrator  owns every object; runs migrations; NOCREATEROLE
--   crm_app       the API: tenant-scoped access to everything, via RLS
--   crm_auth      the auth layer only: global identity tables, no business data
--   crm_worker    the outbox relay: like crm_app, plus cross-tenant outbox reads
--
-- No role has BYPASSRLS or SUPERUSER, and none owns a table, so Row-Level
-- Security always applies to all of them (CLAUDE.md §5.1).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
DECLARE
  -- Development passwords only. Production supplies real secrets out of band
  -- and these roles are created with them; nothing here is ever a real secret.
  role_name text;
  dev_password text;
BEGIN
  FOR role_name, dev_password IN
    SELECT * FROM (VALUES
      ('crm_migrator', 'crm_migrator_dev'),
      ('crm_app',      'crm_app_dev'),
      ('crm_auth',     'crm_auth_dev'),
      ('crm_worker',   'crm_worker_dev')
    ) AS t(r, p)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      -- NOINHERIT so a role can never pick up privileges from a future group.
      EXECUTE format(
        'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
        role_name, dev_password
      );
    END IF;
  END LOOP;
END
$$;

-- The migrator owns the schema; everyone else only gets what is granted.
ALTER SCHEMA public OWNER TO crm_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app, crm_auth, crm_worker;

-- Nobody may create objects in public except the migrator.
REVOKE CREATE ON SCHEMA public FROM crm_app, crm_auth, crm_worker;
