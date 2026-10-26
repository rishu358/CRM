# ADR-0043: Bootstrapping on a managed Postgres: the administrative role may not own `public`

- **Status:** Proposed. Reproduced and fixed on a PostgreSQL 16.6 emulation of a managed provider's
  administrative role; **not yet confirmed on a real DigitalOcean cluster**. Becomes Accepted when
  `deploy/verify-managed-postgres.sh probe` prints its VERDICT on a real cluster and the result matches
  §Evidence. Until then the fix lives in that script, not in the repository's bootstrap SQL.
- **Date:** 2026-10-23
- **Related:** ADR-0041 §1 (no superuser required), ADR-0042 (deployment target)

## Context

`packages/db/sql/bootstrap/01-extensions-and-roles.sql` was written to run "as a superuser, or a managed
service's administrative role" (RUNBOOK §2). It had only ever run as a superuser: locally, in
Testcontainers, and in the restore drill. Nothing had run it as the role a managed service actually gives
you.

Line 133 is `ALTER SCHEMA public OWNER TO crm_migrator;`. On DigitalOcean the administrative role
(`doadmin`) can create roles and extensions but is neither a superuser nor able to become the roles it
creates, and the brief flagged this statement as the most likely failure.

## Evidence

Emulated with a non-superuser that has `CREATEROLE`, `CREATEDB` and `BYPASSRLS` and owns its database
(PostgreSQL 16.6, password authentication over a network connection, the repository's file unmodified):

| Step                                                              | Result                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Extensions `citext`, `pg_trgm`, `btree_gin` (lines 30 to 32)      | succeed (all three are "trusted" extensions)                                                      |
| LEAKPROOF block (lines 95 to 103)                                 | degrades to the intended `WARNING`, does not abort                                                |
| Role creation (lines 105 to 130)                                  | succeeds; all five roles `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`                        |
| **`ALTER SCHEMA public OWNER TO crm_migrator` (line 133)**        | **fails: `must be able to SET ROLE "crm_migrator"`**                                              |
| `GRANT crm_migrator TO <admin> WITH SET TRUE`, then the same file | succeeds end to end                                                                               |
| After that, as the real roles                                     | migrator creates tables; `crm_app` is refused `CREATE` on `public`; RLS binds `crm_app`           |
| `REVOKE crm_migrator FROM <admin>` afterwards                     | succeeds                                                                                          |
| `CREATE SCHEMA x AUTHORIZATION crm_migrator` (fallback)           | succeeds once the membership exists (tried only after it); needs application changes to be of use |

**Why it fails.** Changing a schema's owner requires the caller to be able to `SET ROLE` to the new owner.
Since PostgreSQL 16 the creator of a role is given `ADMIN OPTION` on it but **not** `SET` or `INHERIT`.
`doadmin` created `crm_migrator` a statement earlier and still cannot act as it. A superuser can, which is
why this never failed before. The emulation is a model of `doadmin`, not `doadmin`; what differs on the
real service (extra restrictions, how its databases are owned) is exactly what `probe` measures.

## Decision

**Option 1: grant the bootstrapping role `SET` on the migrator for the length of the bootstrap, then
revoke it.**

```sql
-- before ALTER SCHEMA, only when the caller cannot already act as the migrator
GRANT crm_migrator TO "<bootstrapping role>" WITH SET TRUE;
ALTER SCHEMA public OWNER TO crm_migrator;
-- ... the rest of the file ...
REVOKE crm_migrator FROM "<bootstrapping role>";
```

Why this and not the alternatives:

1. **The invariant is unchanged.** `crm_migrator` still owns the schema and every object in it; nobody
   else can create objects there; `crm_app`, `crm_auth`, `crm_worker` and `crm_erasure` still hold `USAGE`
   only. The audit in `verify-managed-postgres.sh` checks all of that after the fact.
2. **It is one statement,** idempotent, and a no-op for a superuser, so the three places the file runs
   (local, Testcontainers, production) can stay one file.
3. **The standing exposure is nil.** The membership exists for seconds, held by the administrative role,
   which can already grant itself anything, and is revoked afterwards.

**Where it goes.** Until a real cluster confirms it, `verify-managed-postgres.sh bootstrap` applies the
grant and the revoke around an **unmodified** copy of the repository's file, and says so when it does. Once
`probe` confirms Option 1 on a real DigitalOcean cluster, move the guarded grant into the SQL file itself
(inside a `DO` block that checks `pg_has_role(current_user, 'crm_migrator', 'SET')`, so a superuser skips
it) and the revoke to its end, and mark this ADR Accepted. That edit touches `packages/db`, whose
Testcontainers harness runs the same file, so it needs the full `test:security` run.

## Alternatives considered

- **Option 2: a dedicated schema owned by `crm_migrator`, leaving `public` alone.** Works at the SQL level
  once the membership exists. PostgreSQL's documentation says `CREATE SCHEMA ... AUTHORIZATION` needs the
  same right as changing an owner, so it probably does not avoid the grant (not tried without it). Then every
  role needs `search_path`, Drizzle needs a schema name, the migration journal needs a home, and every
  hand-written SQL string that says `public` or relies on it changes. A rewrite of the data layer's
  conventions to dodge one `GRANT`. Reserve it for the case where Option 1 fails on the real cluster.
- **Option 3: do not change the owner; grant `CREATE ON SCHEMA public` to the migrator.** Not tested
  end to end. The migrator would own the tables it creates either way, but it would no longer own the
  schema, the audit would have to change, and the database owner (which is the administrative role) would
  remain the schema's owner. A reasonable fallback if Option 1 is refused; it weakens "the migrator owns
  everything" for no gain while Option 1 works.
- **Ask for a superuser or an equivalent.** Not available on the platform, and ADR-0041 §1 already decided
  not to require one.

## If `probe` disagrees

`probe` reports one of three outcomes. **Works as shipped:** nothing to do; mark this ADR Rejected and
delete the grant from the script. **Fails, and Option 1 works:** proceed as above. **Fails, and Option 1
is refused too:** stop. Do not improvise on the real cluster. Options 2 and 3 are then real design work
with their own ADR, and the platform choice (ADR-0042) is reopened for the owner to decide.

## Consequences

- The bootstrap no longer requires a superuser (ADR-0041 §1 held for search; this extends it to schema
  ownership), and the repository records the one thing a provider-administrative role cannot do by default.
- The administrative role keeps `BYPASSRLS`. That is acceptable for bootstrap and migrations and
  forbidden at run time; ADR-0042 §4 adds the startup guard that enforces it.
- A cluster that was bootstrapped with development passwords (running the file as it stands, as RUNBOOK §2
  warned against) keeps those passwords, because role creation is `IF NOT EXISTS`. `verify-managed-postgres.sh
audit` tries each development password and fails if one still works.
