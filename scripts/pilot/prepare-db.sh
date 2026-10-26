#!/usr/bin/env bash
# Create (or rebuild) the separate pilot database `crm_pilot` in the local compose Postgres, apply the
# bootstrap and the migrations. It only ever touches a database called crm_pilot: the name is fixed here and
# the env file's database URLs are checked against it before anything runs.
#
#   bash scripts/pilot/prepare-db.sh <env file>             create it if it is missing, then migrate
#   bash scripts/pilot/prepare-db.sh <env file> --reset     DROP crm_pilot first (stop the API and worker first)
#
# Needs: the compose Postgres container (default name crm-postgres), a built repository (pnpm build), Docker.
set -euo pipefail

ENV_FILE="${1:?usage: prepare-db.sh <env file> [--reset]}"
RESET="${2:-}"
DB=crm_pilot
CONTAINER="${PILOT_PG_CONTAINER:-crm-postgres}"
cd "$(dirname "$0")/../.."

echo "target database: $DB (container $CONTAINER)"
for name in DATABASE_URL DATABASE_AUTH_URL DATABASE_WORKER_URL DATABASE_ERASURE_URL DATABASE_MIGRATION_URL; do
  line="$(grep -E "^${name}=" "$ENV_FILE" || true)"
  [ -z "$line" ] && continue
  case "$line" in
    *"/$DB") ;;
    *) echo "refusing: $name in $ENV_FILE does not end in /$DB"; exit 1 ;;
  esac
done

if [ "$RESET" = "--reset" ]; then
  echo "dropping database: $DB"
  docker exec "$CONTAINER" psql -U postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
fi

exists="$(docker exec "$CONTAINER" psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB'" || true)"
if [ "$exists" = "1" ]; then
  echo "$DB already exists: reusing it"
else
  docker exec "$CONTAINER" psql -U postgres -c "CREATE DATABASE $DB" > /dev/null
  echo "created $DB"
fi

docker exec -i "$CONTAINER" psql -U postgres -d "$DB" < packages/db/sql/bootstrap/01-extensions-and-roles.sql > /dev/null
echo "bootstrap applied"

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
pnpm db:migrate
echo "migrated: $(docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc 'SELECT count(*) FROM schema_migrations') migration(s) recorded"
