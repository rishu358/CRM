#!/usr/bin/env bash
# Backup and restore drill (MVP_SPEC §8 "restore tested", ADR-0041, docs/RUNBOOK.md).
#
# A backup nobody has restored is a hope. This takes a logical dump of a database, restores it
# into a brand-new one, and then checks the things a restore can silently lose and an outage
# cannot afford to:
#
#   1. the DATA     row counts and an order-independent checksum of every record table;
#   2. TENANT ISOLATION   row-level security enabled AND forced on every table with a tenant_id,
#                   the same policies, and the application role still without BYPASSRLS;
#   3. PRIVILEGES   the column-level grants and role attributes the application relies on (a dump
#                   without `--no-privileges` carries them; one restored without the roles does not);
#   4. MIGRATIONS   the restored database is exactly at the repository's schema version;
#   5. THE APP      the real API boots on the restored database, signs a user in and lists records,
#                   and a request for another tenant's id still answers 404.
#
# It measures how long dump and restore take at the size of the database it is run against, which
# is the honest input to an RTO. It never touches the source database except to read it.
#
# Usage (local stack from docker-compose.yml):
#   deploy/backup-drill.sh [source_db]            # default: crm_perf
#
# Environment:
#   DRILL_CONTAINER   the Postgres container       (default crm-postgres)
#   DRILL_PGUSER      a superuser                   (default postgres)
#   DRILL_JOBS        pg_restore parallel jobs      (default 4)
#   DRILL_API_ENV     an env file for the API       (needed for step 5; skipped if unset)
#   DRILL_API_PORT    port for the drill API        (default 3012)
#   DRILL_REPO        the repository root           (default: this script's parent directory)
#
# Production variant: the same dump/restore commands run against a managed instance with
# `pg_dump "$DATABASE_URL"`; point-in-time recovery is the managed service's job and is drilled
# through its console (see docs/RUNBOOK.md). Exit status is non-zero if any check fails.

set -u -o pipefail

SOURCE_DB="${1:-crm_perf}"
CONTAINER="${DRILL_CONTAINER:-crm-postgres}"
SUPER="${DRILL_PGUSER:-postgres}"
JOBS="${DRILL_JOBS:-4}"
API_PORT="${DRILL_API_PORT:-3012}"
REPO="${DRILL_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
DRILL_DB="${SOURCE_DB}_restore_drill"
DUMP_IN_CONTAINER="/tmp/${DRILL_DB}.dump"

failures=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }
step() { printf '\n== %s\n' "$1"; }
psql_src() { docker exec -i "$CONTAINER" psql -U "$SUPER" -d "$SOURCE_DB" -At -v ON_ERROR_STOP=1 "$@"; }
psql_drill() { docker exec -i "$CONTAINER" psql -U "$SUPER" -d "$DRILL_DB" -At -v ON_ERROR_STOP=1 "$@"; }
now() { date +%s; }

cleanup() {
  docker exec "$CONTAINER" rm -f "$DUMP_IN_CONTAINER" > /dev/null 2>&1
  if [ -n "${API_PID:-}" ]; then kill "$API_PID" > /dev/null 2>&1; fi
  docker exec "$CONTAINER" psql -U "$SUPER" -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" > /dev/null 2>&1
}
trap cleanup EXIT

step "Source: $SOURCE_DB"
size=$(psql_src -c "select pg_size_pretty(pg_database_size('$SOURCE_DB'))") || { echo "cannot read $SOURCE_DB"; exit 2; }
echo "  size on disk: $size"

# A fingerprint that is the same for the same data whatever order Postgres returns it in.
fingerprint_sql() {
  cat <<'SQL'
select t.table_name || '=' || (xpath('/row/c/text()',
         query_to_xml(format('select count(*) as c from %I', t.table_name), false, true, '')))[1]::text
from information_schema.tables t
where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
  and t.table_name not like 'audit_logs\_%' and t.table_name not like 'schema_migrations'
order by 1;
SQL
}
checksum_sql() {
  cat <<'SQL'
select 'contacts', md5(string_agg(id::text || email::text || coalesce(phone, ''), ',' order by id)) from contacts
union all select 'accounts', md5(string_agg(id::text || name, ',' order by id)) from accounts
union all select 'leads', md5(string_agg(id::text || last_name, ',' order by id)) from leads
union all select 'deals', md5(string_agg(id::text || name || coalesce(amount_minor::text, ''), ',' order by id)) from deals
union all select 'audit_logs', md5(string_agg(id::text, ',' order by id)) from audit_logs
union all select 'users', md5(string_agg(id::text || email::text, ',' order by id)) from users;
SQL
}
rls_sql() {
  cat <<'SQL'
select 'tenant_tables_total', count(*) from information_schema.columns c
  join pg_class r on r.relname = c.table_name and r.relkind in ('r', 'p')
  join pg_namespace n on n.oid = r.relnamespace and n.nspname = 'public'
  where c.table_schema = 'public' and c.column_name = 'tenant_id' and r.relispartition = false
union all
select 'rls_enabled_and_forced', count(*) from pg_class r
  join pg_namespace n on n.oid = r.relnamespace and n.nspname = 'public'
  where r.relkind in ('r', 'p') and r.relispartition = false and r.relrowsecurity and r.relforcerowsecurity
    and exists (select 1 from information_schema.columns c where c.table_schema = 'public'
                and c.table_name = r.relname and c.column_name = 'tenant_id')
union all select 'policies', count(*) from pg_policies where schemaname = 'public'
union all select 'column_grants', count(*) from information_schema.column_privileges
  where table_schema = 'public' and grantee like 'crm\_%'
union all select 'table_grants', count(*) from information_schema.table_privileges
  where table_schema = 'public' and grantee like 'crm\_%'
union all select 'indexes', count(*) from pg_indexes where schemaname = 'public'
union all select 'triggers', count(*) from pg_trigger t join pg_class r on r.oid = t.tgrelid
  join pg_namespace n on n.oid = r.relnamespace and n.nspname = 'public' where not t.tgisinternal
union all select 'constraints', count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace and n.nspname = 'public'
union all select 'migrations', count(*) from schema_migrations
order by 1;
SQL
}

step "Fingerprint of the source"
fingerprint_sql | psql_src > /tmp/drill-src-counts.txt
checksum_sql | psql_src > /tmp/drill-src-sums.txt
rls_sql | psql_src > /tmp/drill-src-rls.txt
echo "  $(wc -l < /tmp/drill-src-counts.txt | tr -d ' ') tables counted, $(wc -l < /tmp/drill-src-sums.txt | tr -d ' ') checksums, $(wc -l < /tmp/drill-src-rls.txt | tr -d ' ') structural facts"

step "Dump"
t0=$(now)
# Custom format, compressed, parallel-restorable. Ownership and privileges are KEPT: the grants are
# part of the security model (column-level UPDATE on field_definitions, no DELETE on audit_logs).
docker exec "$CONTAINER" pg_dump -U "$SUPER" -d "$SOURCE_DB" -Fc -Z 6 -f "$DUMP_IN_CONTAINER" || { echo "dump failed"; exit 2; }
dump_seconds=$(( $(now) - t0 ))
dump_size=$(docker exec "$CONTAINER" sh -c "du -h $DUMP_IN_CONTAINER | cut -f1")
echo "  dump: ${dump_seconds}s, $dump_size"

step "Restore into a new database ($DRILL_DB)"
docker exec "$CONTAINER" psql -U "$SUPER" -d postgres -c "DROP DATABASE IF EXISTS \"$DRILL_DB\" WITH (FORCE)" > /dev/null
docker exec "$CONTAINER" psql -U "$SUPER" -d postgres -c "CREATE DATABASE \"$DRILL_DB\"" > /dev/null
# Extensions first, from the same script a fresh environment is bootstrapped with; the restore
# then needs nothing that was not written down. (Roles are cluster-wide and already exist here; on a
# new cluster this same script creates them, which is exactly the step being rehearsed.)
if [ -f "$REPO/packages/db/sql/bootstrap/01-extensions-and-roles.sql" ]; then
  docker exec -i "$CONTAINER" psql -U "$SUPER" -d "$DRILL_DB" -v ON_ERROR_STOP=0 -q \
    < "$REPO/packages/db/sql/bootstrap/01-extensions-and-roles.sql" > /dev/null 2>&1
fi
t0=$(now)
docker exec "$CONTAINER" pg_restore -U "$SUPER" -d "$DRILL_DB" -j "$JOBS" --exit-on-error "$DUMP_IN_CONTAINER" 2> /tmp/drill-restore.err
restore_status=$?
restore_seconds=$(( $(now) - t0 ))
if [ "$restore_status" -eq 0 ]; then pass "pg_restore finished without error in ${restore_seconds}s"; else fail "pg_restore failed (see /tmp/drill-restore.err)"; head -5 /tmp/drill-restore.err; fi

step "1. The data"
fingerprint_sql | psql_drill > /tmp/drill-dst-counts.txt
checksum_sql | psql_drill > /tmp/drill-dst-sums.txt
if diff -q /tmp/drill-src-counts.txt /tmp/drill-dst-counts.txt > /dev/null; then pass "every table has the same number of rows"; else fail "row counts differ:"; diff /tmp/drill-src-counts.txt /tmp/drill-dst-counts.txt | head; fi
if diff -q /tmp/drill-src-sums.txt /tmp/drill-dst-sums.txt > /dev/null; then pass "the record checksums are identical"; else fail "checksums differ:"; diff /tmp/drill-src-sums.txt /tmp/drill-dst-sums.txt | head; fi

step "2 and 3. Tenant isolation, privileges and the structure that carries them"
rls_sql | psql_drill > /tmp/drill-dst-rls.txt
if diff -q /tmp/drill-src-rls.txt /tmp/drill-dst-rls.txt > /dev/null; then pass "policies, grants, indexes, triggers and constraints match the source"; else fail "structure differs:"; diff /tmp/drill-src-rls.txt /tmp/drill-dst-rls.txt; fi
total=$(grep '^tenant_tables_total|' /tmp/drill-dst-rls.txt | cut -d'|' -f2)
forced=$(grep '^rls_enabled_and_forced|' /tmp/drill-dst-rls.txt | cut -d'|' -f2)
if [ -n "$total" ] && [ "$total" = "$forced" ]; then pass "row-level security is enabled and forced on all $total tables with a tenant_id"; else fail "RLS enabled+forced on $forced of $total tenant tables"; fi
bypass=$(psql_drill -c "select count(*) from pg_roles where rolname like 'crm\\_%' and (rolbypassrls or rolsuper)")
if [ "$bypass" = "0" ]; then pass "no application role has BYPASSRLS or superuser"; else fail "$bypass application role(s) can bypass row-level security"; fi

# The isolation property itself, as the application role, on the restored data.
tenant=$(psql_drill -c "select tenant_id from contacts group by 1 order by count(*) desc limit 1")
expected=$(psql_drill -c "select count(*) from contacts where tenant_id = '$tenant' and deleted_at is null")
# One psql session per probe: become crm_app, optionally name a tenant, run a count, roll back.
# Only the numeric line is kept, so the set_config echo cannot be mistaken for the answer.
as_tenant() {
  local setter=""
  if [ -n "$1" ]; then setter="select set_config('app.tenant_id', '$1', true);"; fi
  printf "begin;
set local role crm_app;
%s
%s
rollback;
" "$setter" "$2"     | docker exec -i "$CONTAINER" psql -U "$SUPER" -d "$DRILL_DB" -At -q | grep -E "^[0-9]+$" | tail -n 1
}
seen=$(as_tenant "$tenant" "select count(*) from contacts where deleted_at is null;")
other=$(as_tenant "00000000-0000-7000-8000-000000000000" "select count(*) from contacts;")
none=$(as_tenant "" "select count(*) from contacts;")
if [ "$seen" = "$expected" ]; then pass "crm_app sees its own tenant's $expected contacts"; else fail "crm_app saw $seen contacts, expected $expected"; fi
if [ "$other" = "0" ]; then pass "crm_app with another tenant's id sees 0 contacts"; else fail "crm_app saw $other contacts of a tenant it should not read"; fi
if [ "$none" = "0" ]; then pass "crm_app with no tenant set sees 0 contacts (fails closed)"; else fail "crm_app with no tenant saw $none contacts"; fi

step "4. Migrations"
if [ "$(grep '^migrations|' /tmp/drill-dst-rls.txt | cut -d'|' -f2)" = "$(ls "$REPO/packages/db/migrations"/*.sql | wc -l | tr -d ' ')" ]; then
  pass "the restored database is at the repository's migration version ($(ls "$REPO/packages/db/migrations"/*.sql | wc -l | tr -d ' ') migrations)"
else
  fail "restored migrations do not match the repository's files"
fi

step "5. The application on the restored database"
if [ -n "${DRILL_API_ENV:-}" ] && [ -f "$DRILL_API_ENV" ]; then
  swap() { sed "s#/$SOURCE_DB#/$DRILL_DB#g" "$DRILL_API_ENV" > /tmp/drill-api.env; }
  swap
  echo "API_PORT=$API_PORT" >> /tmp/drill-api.env
  (cd "$REPO" && node --env-file="$(cygpath -w /tmp/drill-api.env 2>/dev/null || echo /tmp/drill-api.env)" apps/api/dist/main.js > /tmp/drill-api.log 2>&1) &
  API_PID=$!
  up=0
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://localhost:$API_PORT/api/v1/health" && { up=1; break; }; sleep 1; done
  if [ "$up" = "1" ]; then
    pass "the API started against the restored database"
    owner=$(psql_drill -c "select email from users where email like 'owner-%@example.com' order by created_at limit 1")
    token=$(curl -s -X POST "http://localhost:$API_PORT/api/v1/auth/sign-in" -H 'content-type: application/json' \
      -d "{\"email\":\"$owner\",\"password\":\"demo-password-not-for-production\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
    if [ -n "$token" ]; then pass "a user signed in with their original password (credentials survived the restore)"; else fail "sign-in failed on the restored database"; fi
    listed=$(curl -s -H "Authorization: Bearer $token" "http://localhost:$API_PORT/api/v1/contacts?limit=5" | grep -o '"id"' | wc -l | tr -d ' ')
    if [ "${listed:-0}" -ge 1 ]; then pass "the contacts list returned $listed records"; else fail "the contacts list was empty or failed"; fi
    foreign=$(psql_drill -c "select id from contacts where tenant_id <> (select tenant_id from contacts where tenant_id = '$tenant' limit 1) limit 1")
    if [ -n "$foreign" ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "http://localhost:$API_PORT/api/v1/contacts/$foreign")
      if [ "$code" = "404" ]; then pass "another tenant's contact answers 404, not 403 and not data"; else fail "another tenant's contact answered $code"; fi
    fi
  else
    fail "the API did not come up on the restored database (see /tmp/drill-api.log)"
    tail -5 /tmp/drill-api.log
  fi
else
  echo "  skipped: set DRILL_API_ENV to an env file for the API to include this step"
fi

step "Result"
echo "  dump ${dump_seconds}s ($dump_size), restore ${restore_seconds}s, database $size, jobs $JOBS"
if [ "$failures" -eq 0 ]; then echo "  DRILL PASSED"; exit 0; else echo "  DRILL FAILED: $failures check(s)"; exit 1; fi
