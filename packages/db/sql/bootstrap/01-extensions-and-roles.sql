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

-- ---------------------------------------------------------------------------
-- Two text-matching operators, marked LEAKPROOF (ADR-0028 §7).
--
-- Read the ADR before changing this. It is a deliberate, narrow weakening of
-- a Postgres safety default, and it is the only reason global search can use
-- an index at all.
--
-- The problem: a table with Row-Level Security gets a *security barrier*.
-- Postgres will not evaluate a qual that is not marked LEAKPROOF before the
-- policy has filtered the rows, which means such a qual can never become an
-- index condition. `tsvector @@ tsquery` and pg_trgm's `<%` are not marked
-- leakproof in core, so on `search_documents` — which has RLS, like every
-- tenant table — the planner was reduced to:
--
--     Bitmap Index Scan ... Index Cond: (tenant_id = ...)
--     Filter: (search_vector @@ ...)
--
-- that is, fetch every one of the tenant's index entries and re-check the
-- match on the heap. Measured: a sequential scan of the whole table, for a
-- query that should touch a hundred rows. At a thousand tenants holding a
-- million records each, that is not a slow feature, it is an unusable one.
-- No index shape fixes it; the ordering rule is about the operator, not the
-- index.
--
-- Why these two are safe to mark:
--
--   * LEAKPROOF means "reveals nothing about its arguments except through its
--     return value" — in practice, raises no error whose occurrence or text
--     depends on the data. Both of these return a boolean and have no
--     data-dependent error path: `@@` walks a tsvector against an already
--     parsed tsquery (parsing, which *can* fail, happens in to_tsquery,
--     outside the operator), and `<%` compares trigram sets.
--   * The barrier exists to stop a *caller-supplied* qual from seeing rows
--     before the policy does. No caller here can supply a qual: every
--     predicate on every table is built in application code from a closed set
--     of whitelisted fields and operators (CLAUDE.md §5.7), and the tenant
--     predicate is additionally written into the query itself rather than
--     left to the policy alone.
--   * It is narrow. Two functions, named explicitly; not a class, not an
--     extension, not `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`. Row
--     security itself is untouched: the policy still filters every row, and
--     the isolation suite still proves it.
--
-- What it does **not** do: it does not let anybody read another tenant's
-- rows. A leakproof qual is still applied to rows the policy allows; marking
-- it only lets the planner apply it earlier, which is where the index is.
--
-- Superuser-only, which is why it lives here and not in a migration:
-- crm_migrator is deliberately not a superuser and does not own these
-- functions. Idempotent, like everything else in this file.
-- ---------------------------------------------------------------------------
ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF;
ALTER FUNCTION word_similarity_op(text, text) LEAKPROOF;

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
