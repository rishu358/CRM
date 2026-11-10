#!/usr/bin/env bash
# Render deploy/do-app-platform.yaml: fill each @@NAME@@ from a secrets file and print the spec to
# stdout, for `doctl apps create|update --spec -`. ADR-0042.
#
#   deploy/render-do-app-spec.sh deploy/do-app.secrets.env | doctl apps update <app-id> --spec -
#   deploy/render-do-app-spec.sh --check deploy/do-app.secrets.env        # validate only
#
# The secrets file is KEY=value lines (the file `verify-managed-postgres.sh bootstrap` writes; the
# `deploy/*.env` pattern is git-ignored). It is read as data, never sourced, so a stray `$(...)` in a
# value is text, not code.
#
# This script prints no value and writes no file: the rendered spec exists only on the pipe. It
# refuses to run if a required value is missing, still a placeholder, or the wrong shape, and above
# all if any database URL names the managed-database admin role.

set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true # bash 5.2: `&` in a replacement is special otherwise

CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; shift; fi
ENV_FILE="${1:-}"
[[ -n "$ENV_FILE" && -r "$ENV_FILE" ]] || { echo "usage: $0 [--check] <secrets-file>" >&2; exit 2; }
TEMPLATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/do-app-platform.yaml"

REQUIRED=(CRM_VERSION WEB_URL API_URL AUTH_SECRET EMAIL_UNSUBSCRIBE_SECRET DATABASE_CA_CERT
  DATABASE_URL DATABASE_AUTH_URL DATABASE_WORKER_URL DATABASE_ERASURE_URL DATABASE_MIGRATION_URL
  EMAIL_FROM RESEND_API_KEY
  S3_BUCKET S3_REGION S3_ENDPOINT S3_PUBLIC_ENDPOINT S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY)
OPTIONAL=(REDIS_URL DEPLOYMENT_MODE)

declare -A V
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]] || { echo "Unreadable line in $ENV_FILE (expected KEY=value)." >&2; exit 1; }
  V["${BASH_REMATCH[1]}"]="${BASH_REMATCH[2]}"
done < "$ENV_FILE"

# Not secret and has a safe default: an installation that says nothing is a multi-tenant one.
: "${V[DEPLOYMENT_MODE]:=multi_tenant}"
problems=()
for k in "${REQUIRED[@]}"; do
  [[ -n "${V[$k]:-}" ]] || problems+=("$k is not set")
done
# Values go inside double-quoted YAML scalars: refuse what would break out of one.
for k in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
  [[ "${V[$k]:-}" =~ [\"\[:cntrl:]] ]] && problems+=("$k contains a quote, backslash or control character")
done
for k in DATABASE_URL DATABASE_AUTH_URL DATABASE_WORKER_URL DATABASE_ERASURE_URL DATABASE_MIGRATION_URL; do
  v="${V[$k]:-}"; [[ -z "$v" ]] && continue
  [[ "$v" =~ ^postgres(ql)?://([^:@/]+): ]] || { problems+=("$k is not a postgres:// URL with a user and password"); continue; }
  user="${BASH_REMATCH[2]}"
  case "$user" in
    doadmin|postgres|admin|root) problems+=("$k connects as '$user', an administrative role that bypasses row-level security; use the crm_* role") ;;
  esac
  [[ "$k" == DATABASE_URL && "$user" != crm_app ]] && problems+=("DATABASE_URL must be crm_app (it is '$user')")
  [[ "$k" == DATABASE_AUTH_URL && "$user" != crm_auth ]] && problems+=("DATABASE_AUTH_URL must be crm_auth (it is '$user')")
  [[ "$k" == DATABASE_WORKER_URL && "$user" != crm_worker ]] && problems+=("DATABASE_WORKER_URL must be crm_worker (it is '$user')")
  [[ "$k" == DATABASE_ERASURE_URL && "$user" != crm_erasure ]] && problems+=("DATABASE_ERASURE_URL must be crm_erasure (it is '$user')")
  [[ "$k" == DATABASE_MIGRATION_URL && "$user" != crm_migrator ]] && problems+=("DATABASE_MIGRATION_URL must be crm_migrator (it is '$user')")
done
for k in WEB_URL API_URL S3_ENDPOINT S3_PUBLIC_ENDPOINT; do
  [[ -z "${V[$k]:-}" || "${V[$k]}" == https://* ]] || problems+=("$k must be an https URL")
done
[[ -z "${V[REDIS_URL]:-}" || "${V[REDIS_URL]}" == rediss://* ]] || problems+=("REDIS_URL must be a TLS (rediss://) URL")
# The CA is public but must be a certificate: base64 of a PEM (one line, so it fits an env value).
if [[ -n "${V[DATABASE_CA_CERT]:-}" ]] && ! printf '%s' "${V[DATABASE_CA_CERT]}" | base64 -d 2>/dev/null | grep -q 'BEGIN CERTIFICATE'; then
  problems+=("DATABASE_CA_CERT must be the base64 of the provider's CA certificate (base64 -w0 ca.crt)")
fi
case "${V[DEPLOYMENT_MODE]}" in multi_tenant | single_tenant) ;; *) problems+=("DEPLOYMENT_MODE must be multi_tenant or single_tenant") ;; esac
[[ "${V[CRM_VERSION]:-}" != latest ]] || problems+=("CRM_VERSION must name a release, not 'latest'")
[[ ${#V[AUTH_SECRET]} -ge 32 || -z "${V[AUTH_SECRET]:-}" ]] || problems+=("AUTH_SECRET must be at least 32 characters")
[[ ${#V[EMAIL_UNSUBSCRIBE_SECRET]} -ge 32 || -z "${V[EMAIL_UNSUBSCRIBE_SECRET]:-}" ]] || problems+=("EMAIL_UNSUBSCRIBE_SECRET must be at least 32 characters")
[[ -z "${V[EMAIL_UNSUBSCRIBE_SECRET]:-}" || "${V[EMAIL_UNSUBSCRIBE_SECRET]}" != "${V[AUTH_SECRET]:-}" ]] || problems+=("EMAIL_UNSUBSCRIBE_SECRET must not be the same value as AUTH_SECRET")

API_HOST=""
if [[ "${V[API_URL]:-}" =~ ^https://([^/:?]+) ]]; then API_HOST="${BASH_REMATCH[1]}"; V[API_HOST]="$API_HOST"; fi

if (( ${#problems[@]} > 0 )); then
  printf 'Refusing to render:\n' >&2
  printf ' - %s\n' "${problems[@]}" >&2
  exit 1
fi

# Comments explain the template to people; the rendered spec does not need them, and some of them
# mention @@NAME@@ in prose, which the leftover-placeholder check below must not trip over.
out="$(grep -Ev '^[[:space:]]*#|^[[:space:]]*$' "$TEMPLATE")"
if [[ -z "${V[REDIS_URL]:-}" ]]; then
  out="$(printf '%s\n' "$out" | grep -v '@@REDIS_URL@@')" # an empty env value is not worth sending
fi
for k in "${REQUIRED[@]}" API_HOST "${OPTIONAL[@]}"; do
  out="${out//@@${k}@@/${V[$k]:-}}"
done
if [[ "$out" == *@@* ]]; then echo "Refusing to render: the template has a placeholder this script does not know." >&2; exit 1; fi

if (( CHECK )); then echo "ok: every required value is present and well-formed (nothing rendered)." >&2; exit 0; fi
printf '%s\n' "$out"
