#!/usr/bin/env bash
# Verify a managed Postgres 16 cluster can host this CRM, and bootstrap it (ADR-0042, ADR-0043).
#
# Written for DigitalOcean Managed PostgreSQL, where the administrative role (`doadmin`) can create
# roles and extensions but is neither a superuser nor the owner of the `public` schema. Nothing in
# this repository had been run against such a cluster when this was written; this script is how you
# find out, in a few minutes and without touching anything you care about.
#
#   probe      Create a THROWAWAY database and throwaway `crmv_*` roles, run the repository's
#              bootstrap SQL there exactly as shipped, and report. Leaves nothing behind (drops
#              both, unless --keep). Run this first, on a fresh cluster.
#   bootstrap  The real thing: run the bootstrap in the database you name, with generated
#              passwords, and write the connection strings to a file only you can read. Refuses
#              to run if the crm_* roles already exist (their passwords would not be the ones it
#              generated). Applies the membership grant of ADR-0043 if, and only if, it is needed.
#   audit      Read-only. Check a bootstrapped database: role attributes, no development passwords,
#              schema ownership, extensions, the LEAKPROOF state. Run it after `bootstrap`, and any
#              time you doubt the cluster.
#
# Usage (needs psql 14+; on Windows or without psql, run it in a container, see docs/RUNBOOK.md §9):
#
#   ADMIN_DATABASE_URL='postgres://doadmin:...@host:25060/defaultdb?sslmode=require' \
#     deploy/verify-managed-postgres.sh probe
#   ADMIN_DATABASE_URL=... deploy/verify-managed-postgres.sh bootstrap --db crm --out deploy/do-app.secrets.env
#   ADMIN_DATABASE_URL=... deploy/verify-managed-postgres.sh audit --db crm
#
# Environment:
#   ADMIN_DATABASE_URL  required. The admin connection string from the provider's console. Read from
#                       the environment, never from an argument, so it is not in `ps` output.
#   DB_CA_CERT          optional path to the provider's CA certificate. If set, the connection is
#                       verified (sslmode=verify-full). Otherwise sslmode from the URL, else require.
#
# It never prints a password or a connection string. Generated passwords exist in a 0600 temporary
# directory (removed on exit) and, for `bootstrap`, in the output file you asked for.
# Exit status: 0 if nothing FAILed (WARNs are allowed and are explained), 1 otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP_SQL="$REPO_ROOT/packages/db/sql/bootstrap/01-extensions-and-roles.sql"
ROLES=(migrator app auth worker erasure)
declare -A PW # generated role passwords, by role (never printed)

PASSES=0 FAILS=0 WARNS=0
SHIPPED_FAIL_FIXED=0
pass() { PASSES=$((PASSES + 1)); printf '[PASS] %s\n' "$*"; }
fail() { FAILS=$((FAILS + 1)); printf '[FAIL] %s\n' "$*"; }
warn() { WARNS=$((WARNS + 1)); printf '[WARN] %s\n' "$*"; }
info() { printf '[INFO] %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }
die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }

# ---- connection ----------------------------------------------------------------------------------

parse_admin_url() {
  [[ -n "${ADMIN_DATABASE_URL:-}" ]] || die "ADMIN_DATABASE_URL is not set (the admin connection string from the provider's console)."
  local re='^postgres(ql)?://([^:@/]+):([^@]*)@([^:/?]+)(:([0-9]+))?/([^?]*)(\?(.*))?$'
  [[ "$ADMIN_DATABASE_URL" =~ $re ]] || die "ADMIN_DATABASE_URL is not a postgres:// URL of the form user:password@host:port/database."
  ADMIN_USER="${BASH_REMATCH[2]}"
  local raw="${BASH_REMATCH[3]}"
  ADMIN_PASS="$(printf '%b' "${raw//%/\\x}")"
  export PGHOST="${BASH_REMATCH[4]}" PGPORT="${BASH_REMATCH[6]:-5432}"
  ADMIN_DB="${BASH_REMATCH[7]:-defaultdb}"
  local query="${BASH_REMATCH[9]:-}"
  [[ "$ADMIN_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "The admin user name has characters this script will not put in SQL."
  if [[ -z "${PGSSLMODE:-}" ]]; then
    if [[ "$query" =~ sslmode=([a-z-]+) ]]; then PGSSLMODE="${BASH_REMATCH[1]}"; else PGSSLMODE=require; fi
  fi
  if [[ -n "${DB_CA_CERT:-}" ]]; then
    [[ -r "$DB_CA_CERT" ]] || die "DB_CA_CERT is not a readable file."
    PGSSLMODE=verify-full
    export PGSSLROOTCERT="$DB_CA_CERT"
  fi
  export PGSSLMODE PGCONNECT_TIMEOUT=15
}

# psql as the admin, or as a named role. ON_ERROR_STOP so a failed statement is a failed command.
padm() { local db=$1; shift; PGUSER="$ADMIN_USER" PGPASSWORD="$ADMIN_PASS" PGDATABASE="$db" psql -X -v ON_ERROR_STOP=1 -qAt "$@"; }
prole() { local role=$1 pw=$2 db=$3; shift 3; PGUSER="$role" PGPASSWORD="$pw" PGDATABASE="$db" psql -X -v ON_ERROR_STOP=1 -qAt "$@"; }

rand_hex() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }

TMP="$(mktemp -d)"
chmod 700 "$TMP"

# ---- the bootstrap file, with real names and passwords ------------------------------------------

# make_bootstrap <role-prefix> <out> — the repository's file, with the role names re-prefixed
# (probe only) and each development password replaced by a generated one (kept in PW[<role>]).
# Same line count as the original, so an error's line number is the repository file's.
make_bootstrap() {
  local prefix=$1 out=$2 r
  if [[ "$prefix" == "crm_" ]]; then cp "$BOOTSTRAP_SQL" "$out"; else sed "s/crm_/${prefix}/g" "$BOOTSTRAP_SQL" > "$out"; fi
  for r in "${ROLES[@]}"; do
    PW[$r]="$(rand_hex)"
    sed -i "s/'${prefix}${r}_dev'/'${PW[$r]}'/" "$out"
  done
  # If the file's format ever changes so a development password survives, stop rather than create
  # a role anyone can log into.
  if grep -q "_dev'" "$out"; then die "A development password is still in the bootstrap file after substitution; the file's format changed. Not running it."; fi
  chmod 600 "$out"
}

# run_bootstrap <db> <sql-file> <log>: sets LAST_ERR_LINE / LAST_ERR_MSG on failure.
run_bootstrap() {
  local db=$1 file=$2 log=$3
  padm "$db" -f "$file" > "$log" 2>&1
  local rc=$?
  LAST_ERR_LINE="" LAST_ERR_MSG=""
  if [[ $rc -ne 0 ]]; then
    local hit; hit="$(sed -n 's/^psql:[^:]*:\([0-9][0-9]*\): ERROR:  \(.*\)$/\1|\2/p' "$log" | head -1)"
    LAST_ERR_LINE="${hit%%|*}" LAST_ERR_MSG="${hit#*|}"
    [[ -n "$hit" ]] || LAST_ERR_MSG="$(grep -m1 -i 'error\|fatal' "$log" || echo 'unknown error')"
  fi
  return $rc
}

describe_failed_line() { [[ -n "$LAST_ERR_LINE" ]] && sed -n "${LAST_ERR_LINE}p" "$BOOTSTRAP_SQL"; }

# ---- checks shared by every subcommand -----------------------------------------------------------

check_connection_and_admin() {
  section "Connection and the administrative role"
  local v; v="$(padm "$ADMIN_DB" -c 'show server_version_num' 2>"$TMP/e")" || { fail "Could not connect (sslmode=$PGSSLMODE): $(head -c 300 "$TMP/e")"; return 1; }
  pass "Connected as $ADMIN_USER (TLS mode: $PGSSLMODE)"
  if (( v >= 160000 )); then pass "PostgreSQL ${v:0:2} (16 or later required)"; else fail "PostgreSQL major version is ${v:0:2}; 16 or later is required"; fi
  local flags; flags="$(padm "$ADMIN_DB" -F'|' -c "select rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user")"
  IFS='|' read -r su cr cd by <<< "$flags"
  [[ "$cr" == t ]] && pass "$ADMIN_USER can create roles" || fail "$ADMIN_USER cannot create roles; the bootstrap cannot run"
  [[ "$cd" == t ]] && pass "$ADMIN_USER can create databases" || warn "$ADMIN_DB: $ADMIN_USER cannot create databases; 'probe' needs to (create the database yourself for 'bootstrap')"
  if [[ "$su" == t ]]; then
    warn "$ADMIN_USER is a SUPERUSER. That is fine for bootstrap, but it makes this probe less informative: the LEAKPROOF step will succeed here and may not elsewhere."
  else
    pass "$ADMIN_USER is not a superuser (as expected on a managed service)"
  fi
  if [[ "$by" == t ]]; then
    info "$ADMIN_USER has BYPASSRLS. Expected, and the reason it must NEVER be a runtime connection: the app connects as crm_app (docs/RUNBOOK.md §9.4)."
  fi
  local mc; mc="$(padm "$ADMIN_DB" -c 'show max_connections' 2>/dev/null)"
  [[ -n "$mc" ]] && info "max_connections = $mc. Pools: API app pool + auth pool (about a quarter of it) + worker pool + 2 erasure + 1 migrate must fit, with headroom for the provider's own use (RUNBOOK §9.7)."
  return 0
}

check_roles_and_schema() { # <db> <prefix>
  local db=$1 p=$2 r
  section "Roles in $db"
  for r in "${ROLES[@]}"; do
    local flags; flags="$(padm "$db" -F'|' -c "select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname = '${p}${r}'")"
    if [[ -z "$flags" ]]; then fail "Role ${p}${r} does not exist"; continue; fi
    IFS='|' read -r su by cr cd lg <<< "$flags"
    if [[ "$su" == f && "$by" == f && "$cr" == f && "$cd" == f && "$lg" == t ]]; then
      pass "${p}${r}: NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB LOGIN"
    else
      fail "${p}${r}: superuser=$su bypassrls=$by createrole=$cr createdb=$cd login=$lg (all but login must be f)"
    fi
  done
  section "Schema ownership and privileges in $db"
  local owner; owner="$(padm "$db" -c "select nspowner::regrole from pg_namespace where nspname = 'public'")"
  [[ "$owner" == "${p}migrator" ]] && pass "Schema public is owned by ${p}migrator" || fail "Schema public is owned by '$owner', not ${p}migrator"
  for r in app auth worker erasure; do
    local c u; c="$(padm "$db" -c "select has_schema_privilege('${p}${r}', 'public', 'CREATE')")"; u="$(padm "$db" -c "select has_schema_privilege('${p}${r}', 'public', 'USAGE')")"
    [[ "$c" == f && "$u" == t ]] && pass "${p}${r}: USAGE on public, no CREATE" || fail "${p}${r}: usage=$u create=$c on public (want t/f)"
  done
  local pc; pc="$(padm "$db" -c "select has_schema_privilege('public', 'public', 'CREATE')" 2>/dev/null || true)"
  [[ "${pc:-f}" == f ]] && pass "PUBLIC has no CREATE on schema public" || fail "PUBLIC can create objects in schema public"
  for e in citext pg_trgm btree_gin; do
    [[ "$(padm "$db" -c "select count(*) from pg_extension where extname = '$e'")" == 1 ]] && pass "Extension $e is installed" || fail "Extension $e is not installed"
  done
  local lp; lp="$(padm "$db" -F'=' -c "select proname, proleakproof from pg_proc where proname in ('ts_match_vq','word_similarity_op') order by 1" | tr '\n' ' ')"
  if [[ "$lp" == *"=f"* ]]; then
    warn "LEAKPROOF marks are NOT set ($lp). Accepted (ADR-0041 §1, RUNBOOK §0): search works, a mistyped search on a very large company returns 503 SEARCH_TIMEOUT after 2 s."
  else
    pass "LEAKPROOF marks are set ($lp)"
  fi
}

# ---- probe ---------------------------------------------------------------------------------------

cmd_probe() {
  local keep=$1
  check_connection_and_admin || return
  if [[ -n "$(padm "$ADMIN_DB" -c "select 1 from pg_roles where rolname like 'crmv\_%' limit 1")" ]]; then
    fail "Roles named crmv_* already exist, left by an earlier probe --keep. Their passwords are not ones this run knows. Drop the old crmv_probe_* database(s) and then: DROP ROLE crmv_migrator, crmv_app, crmv_auth, crmv_worker, crmv_erasure;"
    return
  fi
  local suffix; suffix="$(rand_hex | head -c 8)"
  PROBE_DB="crmv_probe_${suffix}"
  PROBE_CLEANUP=1
  section "Throwaway database and roles"
  info "Using database $PROBE_DB and roles crmv_* (the repository's SQL with crm_ renamed to crmv_; nothing else changed)."
  if padm "$ADMIN_DB" -c "create database $PROBE_DB" 2>"$TMP/e"; then pass "Created scratch database $PROBE_DB"; else fail "Could not create a database: $(head -c 300 "$TMP/e")"; return; fi
  make_bootstrap crmv_ "$TMP/bootstrap.sql"

  section "Check 1: ALTER SCHEMA public OWNER TO crm_migrator (line 133), exactly as shipped"
  if run_bootstrap "$PROBE_DB" "$TMP/bootstrap.sql" "$TMP/run1.log"; then
    pass "The whole bootstrap ran end to end as $ADMIN_USER, unmodified. ALTER SCHEMA succeeded."
  else
    local stmt; stmt="$(describe_failed_line)"
    fail "The bootstrap stopped at line $LAST_ERR_LINE: $LAST_ERR_MSG"
    [[ -n "$stmt" ]] && info "That line is: $stmt"
    if [[ "$stmt" == *"ALTER SCHEMA public OWNER"* ]]; then
      local can; can="$(padm "$PROBE_DB" -c "select pg_has_role('$ADMIN_USER', 'crmv_migrator', 'SET')")"
      info "Can $ADMIN_USER SET ROLE to the migrator? $can. Changing a schema's owner requires it (PostgreSQL 16 no longer gives a role's creator that right)."
      section "Check 1b: does the ADR-0043 fix work? (GRANT migrator TO $ADMIN_USER WITH SET TRUE, then rerun)"
      if padm "$PROBE_DB" -c "grant crmv_migrator to \"$ADMIN_USER\" with set true" 2>"$TMP/e"; then
        pass "Membership grant accepted"
        if run_bootstrap "$PROBE_DB" "$TMP/bootstrap.sql" "$TMP/run2.log"; then
          pass "With the grant, the whole bootstrap ran end to end. Fix 1 of ADR-0043 works on this cluster."
          # The as-shipped failure above is real and stays printed; it is resolved by a fix this
          # script can apply, so it should not also make the whole run read as broken.
          FAILS=$((FAILS - 1)); SHIPPED_FAIL_FIXED=1
        else
          fail "Still failing at line $LAST_ERR_LINE: $LAST_ERR_MSG"
          probe_dedicated_schema
        fi
      else
        fail "Membership grant refused: $(head -c 300 "$TMP/e")"
        probe_dedicated_schema
      fi
    fi
  fi

  # Only meaningful once the bootstrap has completed, as shipped or with the grant.
  if (( FAILS == 0 )); then probe_after_bootstrap; fi

  section "Check 3: LEAKPROOF degrades to a warning instead of aborting"
  if cat "$TMP"/run*.log 2>/dev/null | grep -q 'Could not mark ts_match_vq'; then
    pass "The LEAKPROOF statements hit insufficient_privilege and the bootstrap carried on (warning printed, as ADR-0041 intends)."
  elif [[ "$(padm "$PROBE_DB" -c "select bool_and(proleakproof) from pg_proc where proname in ('ts_match_vq','word_similarity_op')" 2>/dev/null)" == t ]]; then
    pass "The LEAKPROOF marks were applied (this admin may set them; search will be fast)."
  else
    fail "Neither the LEAKPROOF warning nor the marks were seen; read $TMP/run1.log (kept until this script exits)."
  fi

  if [[ "$keep" == 1 ]]; then
    PROBE_CLEANUP=0
    warn "--keep: database $PROBE_DB and roles crmv_* are left in place, with generated passwords you were never shown. Drop them: DROP DATABASE $PROBE_DB; DROP ROLE crmv_migrator, crmv_app, crmv_auth, crmv_worker, crmv_erasure;"
  fi
}

probe_dedicated_schema() {
  section "Check 1c: fallback — a dedicated schema owned by the migrator (ADR-0043, Fix 2)"
  if padm "$PROBE_DB" -c "create schema crmv_probe_schema authorization crmv_migrator" 2>"$TMP/e"; then
    pass "CREATE SCHEMA ... AUTHORIZATION crm_migrator works here. Fix 2 is possible, but it needs application changes (search_path, migrations): see ADR-0043 before choosing it."
  else
    fail "Dedicated schema also refused: $(head -c 300 "$TMP/e"). This provider may not be usable without a superuser-equivalent; stop and read ADR-0043."
  fi
}

probe_after_bootstrap() {
  check_roles_and_schema "$PROBE_DB" crmv_
  section "Check 2: row-level security binds a non-admin role on this cluster"
  local ok=1
  prole crmv_migrator "${PW[migrator]}" "$PROBE_DB" -c "create table probe_t (id int, tenant_id uuid not null); alter table probe_t enable row level security; alter table probe_t force row level security; create policy tenant on probe_t using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid); grant select, insert on probe_t to crmv_app" >/dev/null 2>"$TMP/e" || { fail "crm_migrator could not create a table under RLS: $(head -c 300 "$TMP/e")"; ok=0; }
  local ta=11111111-1111-1111-1111-111111111111 tb=22222222-2222-2222-2222-222222222222
  if (( ok )); then
    prole crmv_migrator "${PW[migrator]}" "$PROBE_DB" -c "begin; set local app.tenant_id = '$ta'; insert into probe_t values (1, '$ta'); commit; begin; set local app.tenant_id = '$tb'; insert into probe_t values (2, '$tb'); commit" >/dev/null 2>"$TMP/e" || { fail "Could not seed the RLS probe: $(head -c 300 "$TMP/e")"; ok=0; }
  fi
  if (( ok )); then
    local mine none
    mine="$(prole crmv_app "${PW[app]}" "$PROBE_DB" -c "begin; set local app.tenant_id = '$ta'; select count(*) from probe_t; commit" 2>"$TMP/e" | grep -E '^[0-9]+$' | head -1)"
    none="$(prole crmv_app "${PW[app]}" "$PROBE_DB" -c "select count(*) from probe_t" 2>"$TMP/e" | head -1)"
    [[ "$mine" == 1 ]] && pass "crm_app with tenant A set sees 1 of 2 rows (tenant B's row is hidden)" || fail "crm_app with tenant A set saw '$mine' rows, expected 1"
    [[ "$none" == 0 ]] && pass "crm_app with no tenant set sees 0 rows" || fail "crm_app with no tenant set saw '$none' rows, expected 0"
    if prole crmv_app "${PW[app]}" "$PROBE_DB" -c "create table x (i int)" >/dev/null 2>&1; then fail "crm_app could create a table in public"; else pass "crm_app cannot create objects in public"; fi
    local all; all="$(padm "$PROBE_DB" -c "select count(*) from probe_t" 2>&1 | head -1)"
    if [[ "$all" == 2 ]]; then
      info "For contrast, $ADMIN_USER reading the same table with no tenant set sees all 2 rows: BYPASSRLS ignores the policy. That is why it must never be a runtime role."
    else
      info "For contrast, $ADMIN_USER reading the same table says: '$all'."
    fi
  fi
}

# ---- bootstrap -----------------------------------------------------------------------------------

cmd_bootstrap() {
  local db=$1 out=$2
  DB=$db
  check_connection_and_admin || return
  [[ -n "$db" ]] || die "bootstrap needs --db <database name> (create it first in the console, or let this script create it)."
  [[ "$db" =~ ^[a-z][a-z0-9_]*$ ]] || die "Database name must be lowercase letters, digits and underscores."
  [[ -n "$out" ]] || die "bootstrap needs --out <file> for the connection strings (git-ignored: deploy/*.env)."
  [[ ! -e "$out" ]] || die "$out already exists; refusing to overwrite secrets. Move it or choose another name."
  section "Bootstrap $db"
  local have; have="$(padm "$ADMIN_DB" -c "select string_agg(rolname, ', ') from pg_roles where rolname in ('crm_migrator','crm_app','crm_auth','crm_worker','crm_erasure')")"
  [[ -z "$have" ]] || die "Roles already exist ($have). Their passwords are not the ones this run would generate. To rotate, use ALTER ROLE ... PASSWORD; to start over, drop the roles."
  if [[ "$(padm "$ADMIN_DB" -c "select count(*) from pg_database where datname = '$db'")" == 0 ]]; then
    padm "$ADMIN_DB" -c "create database $db" 2>"$TMP/e" && pass "Created database $db" || { fail "Could not create database $db: $(head -c 300 "$TMP/e")"; return; }
  else
    info "Database $db exists."
  fi
  make_bootstrap crm_ "$TMP/bootstrap.sql"
  if run_bootstrap "$db" "$TMP/bootstrap.sql" "$TMP/run1.log"; then
    pass "Bootstrap ran as shipped."
  else
    local stmt; stmt="$(describe_failed_line)"
    if [[ "$stmt" == *"ALTER SCHEMA public OWNER"* && "$LAST_ERR_MSG" == *"SET ROLE"* ]]; then
      info "Expected on a managed service (ADR-0043): $ADMIN_USER may not SET ROLE to crm_migrator. Granting that, once, and rerunning the same file."
      padm "$db" -c "grant crm_migrator to \"$ADMIN_USER\" with set true" 2>"$TMP/e" || { fail "Membership grant refused: $(head -c 300 "$TMP/e")"; return; }
      if run_bootstrap "$db" "$TMP/bootstrap.sql" "$TMP/run2.log"; then pass "Bootstrap completed after the ADR-0043 grant."; else fail "Bootstrap still failing at line $LAST_ERR_LINE: $LAST_ERR_MSG"; return; fi
      padm "$db" -c "revoke crm_migrator from \"$ADMIN_USER\"" >/dev/null 2>&1 && pass "Revoked the temporary membership ($ADMIN_USER can no longer act as the migrator)." || warn "Could not revoke the temporary membership of $ADMIN_USER in crm_migrator; harmless (the admin bypasses everything anyway) but untidy."
    else
      fail "Bootstrap stopped at line $LAST_ERR_LINE: $LAST_ERR_MSG"
      [[ -n "$stmt" ]] && info "That line is: $stmt"
      warn "Roles created before the failure remain, with passwords you were not shown. Drop them (DROP ROLE crm_...) before trying again."
      return
    fi
  fi
  # The connection strings. sslmode=require is what the provider shows; whether the app can verify
  # the provider's CA is a separate question (RUNBOOK §9.6) and is answered by deploy/check-app-connection.mjs.
  umask 077
  {
    echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by verify-managed-postgres.sh bootstrap. Secrets: never commit, never paste."
    echo "# Inputs for deploy/render-do-app-spec.sh. Fill in the blank ones (Resend, Spaces, Valkey, hosts) yourself."
    echo "# The URLs say sslmode=require; the app ignores it when DATABASE_CA_CERT is set and verifies the server"
    echo "# against that CA instead (ADR-0042). Check it with deploy/check-app-connection.mjs before deploying."
    echo "DATABASE_CA_CERT=$(ca_cert_base64)"
    echo "AUTH_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n')"
    for r in app auth worker erasure migrator; do
      local var
      case $r in app) var=DATABASE_URL;; auth) var=DATABASE_AUTH_URL;; worker) var=DATABASE_WORKER_URL;; erasure) var=DATABASE_ERASURE_URL;; migrator) var=DATABASE_MIGRATION_URL;; esac
      echo "${var}=postgres://crm_${r}:${PW[$r]}@${PGHOST}:${PGPORT}/${db}?sslmode=require"
    done
    echo "REDIS_URL="
    echo "RESEND_API_KEY="
    echo "EMAIL_FROM="
    echo "WEB_URL="
    echo "API_URL="
    echo "S3_BUCKET="
    echo "# Spaces: sign with us-east-1 and let the endpoint choose the datacenter (DigitalOcean's SDK examples)."
    echo "S3_REGION=us-east-1"
    echo "S3_ENDPOINT=https://blr1.digitaloceanspaces.com"
    echo "S3_PUBLIC_ENDPOINT=https://blr1.digitaloceanspaces.com"
    echo "S3_ACCESS_KEY_ID="
    echo "S3_SECRET_ACCESS_KEY="
    echo "CRM_VERSION="
  } > "$out"
  chmod 600 "$out"
  pass "Wrote connection strings and a generated AUTH_SECRET to $out (mode 600). They were not printed."
  check_roles_and_schema "$db" crm_
  audit_dev_passwords
}

# ---- audit ---------------------------------------------------------------------------------------

audit_dev_passwords() {
  section "No role can be logged into with its development password"
  local r
  for r in "${ROLES[@]}"; do
    if prole "crm_${r}" "crm_${r}_dev" "$DB" -c 'select 1' >/dev/null 2>&1; then
      fail "crm_${r} accepts the development password from the bootstrap file. Anyone who has read this repository can log in. Run: ALTER ROLE crm_${r} PASSWORD '<generated>';"
    else
      pass "crm_${r} rejects the development password"
    fi
  done
}

cmd_audit() {
  DB=$1
  check_connection_and_admin || return
  [[ -n "$DB" ]] || die "audit needs --db <database name>."
  check_roles_and_schema "$DB" crm_
  audit_dev_passwords
}

# DATABASE_CA_CERT for the app: the base64 of the CA file given for psql (DB_CA_CERT), or blank to fill in.
ca_cert_base64() {
  if [[ -n "${DB_CA_CERT:-}" ]]; then base64 < "$DB_CA_CERT" | tr -d '
'; fi
}

# ---- main ----------------------------------------------------------------------------------------

cleanup() {
  local rc=$?
  if [[ "${PROBE_CLEANUP:-0}" == 1 && -n "${PROBE_DB:-}" ]]; then
    section "Cleanup"
    local r ok=1
    padm "$ADMIN_DB" -c "drop database if exists $PROBE_DB with (force)" >/dev/null 2>"$TMP/e" || { ok=0; warn "Could not drop $PROBE_DB: $(head -c 200 "$TMP/e")"; }
    for r in "${ROLES[@]}"; do padm "$ADMIN_DB" -c "drop role if exists crmv_${r}" >/dev/null 2>"$TMP/e" || { ok=0; warn "Could not drop role crmv_${r}: $(head -c 200 "$TMP/e")"; }; done
    (( ok )) && pass "Dropped $PROBE_DB and the crmv_* roles; nothing was left on the cluster"
  fi
  rm -rf "$TMP"
  printf '\n== Summary: %d passed, %d failed, %d warnings ==\n' "$PASSES" "$FAILS" "$WARNS"
  if (( SHIPPED_FAIL_FIXED == 1 )); then
    echo "VERDICT: the repository's bootstrap SQL FAILS as shipped on this cluster (line 133) and WORKS with the"
    echo "         membership grant in docs/adr/0043-managed-postgres-schema-ownership.md. 'bootstrap' applies it."
  elif (( FAILS == 0 )) && [[ "${sub:-}" == probe ]]; then
    echo "VERDICT: the repository's bootstrap SQL works as shipped on this cluster."
  fi
  if (( FAILS > 0 )); then
    echo "Some checks failed. Read the FAIL lines above, then docs/adr/0043-managed-postgres-schema-ownership.md."
    [[ $rc -eq 0 ]] && rc=1
  fi
  exit "$rc"
}
trap cleanup EXIT

sub="${1:-}"; shift || true
DB_ARG="" OUT_ARG="" KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB_ARG="${2:-}"; shift 2;;
    --out) OUT_ARG="${2:-}"; shift 2;;
    --keep) KEEP=1; shift;;
    *) die "Unknown argument: $1";;
  esac
done

command -v psql >/dev/null || die "psql is not installed. Run this in a container; see docs/RUNBOOK.md §9.3."
[[ -r "$BOOTSTRAP_SQL" ]] || die "Cannot read $BOOTSTRAP_SQL; run this from a checkout of the repository."
parse_admin_url

case "$sub" in
  probe) cmd_probe "$KEEP";;
  bootstrap) cmd_bootstrap "$DB_ARG" "$OUT_ARG";;
  audit) cmd_audit "$DB_ARG";;
  *) sed -n '2,38p' "${BASH_SOURCE[0]}"; exit 2;;
esac
