#!/usr/bin/env bash
# Scan the whole git history, every ref, for secrets (CLAUDE.md §5.8). Used by CI and by hand.
#
#   scripts/scan-secrets.sh            # this checkout
#   scripts/scan-secrets.sh <path>     # another clone's history, with THIS checkout's rules
#
# Fails CLOSED. gitleaks has a failure mode where it cannot read the repository (a git worktree
# mounted into a container, "dubious ownership" on a CI runner, a shallow clone), prints an error,
# reports "0 commits scanned, no leaks found", and exits 0. This script therefore fails if gitleaks
# exits non-zero, if it logged any error, or if it scanned no commits at all.
#
# Needs a local `gitleaks` or Docker. Findings are redacted; nothing secret is printed.

set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="${1:-$here}"
config="$here/.gitleaks.toml"
IMAGE="ghcr.io/gitleaks/gitleaks:v8.30.1"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

[ -r "$config" ] || { echo "[secrets] cannot read $config" >&2; exit 2; }
[ -e "$repo/.git" ] || { echo "[secrets] $repo is not a git checkout" >&2; exit 2; }

args=(git --config /cfg.toml --log-opts="--all" --redact --no-banner)

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git "$repo" --config "$config" --log-opts="--all" --redact --no-banner >"$log" 2>&1
  status=$?
elif command -v docker >/dev/null 2>&1; then
  # Docker on Windows needs Windows paths for mounts; Git Bash's /tmp/... means nothing to it.
  host_repo="$repo"
  host_config="$config"
  if command -v cygpath >/dev/null 2>&1; then
    host_repo="$(cygpath -m "$repo")"
    host_config="$(cygpath -m "$config")"
  fi
  # safe.directory: the runner owns the checkout, the container runs as root.
  MSYS_NO_PATHCONV=1 docker run --rm \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    -v "$host_repo:/repo:ro" -v "$host_config:/cfg.toml:ro" -w /repo \
    "$IMAGE" "${args[@]}" /repo >"$log" 2>&1
  status=$?
else
  echo "[secrets] neither gitleaks nor Docker is available; nothing was scanned." >&2
  exit 2
fi

plain="$(sed 's/\x1b\[[0-9;]*m//g' "$log")"
echo "$plain"

if [ "$status" -ne 0 ]; then
  echo "[secrets] FAIL: gitleaks exited $status (a finding, or it could not run)." >&2
  exit 1
fi
if echo "$plain" | grep -qE '(^| )ERR( |$)'; then
  echo "[secrets] FAIL: gitleaks logged an error; the scan cannot be trusted." >&2
  exit 1
fi
if ! echo "$plain" | grep -qE '[1-9][0-9]* commits scanned'; then
  echo "[secrets] FAIL: no commits were scanned (shallow clone? unreadable repository?)." >&2
  exit 1
fi
echo "[secrets] OK: history scanned, no leaks."
