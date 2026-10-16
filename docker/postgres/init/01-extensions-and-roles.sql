-- Runs once, as superuser, when the Postgres volume is first created.
-- Mirrors the role split that production must also use (CLAUDE.md §5.1):
--   crm_migrator  owns every object and runs migrations
--   crm_app       is what the API connects as: no BYPASSRLS, owns nothing
--
-- Testcontainers-based suites apply the same split via packages/db/src/testing.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_migrator') THEN
    CREATE ROLE crm_migrator LOGIN PASSWORD 'crm_migrator_dev' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    -- NOINHERIT so crm_app can never pick up privileges from a future group membership.
    CREATE ROLE crm_app LOGIN PASSWORD 'crm_app_dev' NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- The migrator owns the schema; the app may only use what is granted to it explicitly.
ALTER SCHEMA public OWNER TO crm_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app;

-- Anything the migrator creates later is automatically usable (but not ownable) by the app.
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crm_app;
