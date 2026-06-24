#!/usr/bin/env bash
# Big Dog auto-update: pull the latest code, rebuild, and restart — but only
# when something actually changed, and only if the build succeeds (a broken
# build leaves the currently-running version untouched). Run on a schedule by
# the bigdog-update.timer systemd unit. Safe to run by hand too.
set -uo pipefail

# Resolve the repo root from this script's location (deploy/ is one level down).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOG=/var/log/bigdog-update.log
exec >>"$LOG" 2>&1

stamp() { date -u '+%Y-%m-%d %H:%M:%S UTC'; }
echo "=== $(stamp) — checking $BRANCH ==="

if ! git fetch origin "$BRANCH" --quiet; then
  echo "git fetch failed (network?) — will retry next run"
  exit 0
fi

LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "already up to date (${LOCAL:0:7})"
  exit 0
fi

echo "update available: ${LOCAL:0:7} -> ${REMOTE:0:7}"
git reset --hard "origin/$BRANCH" || { echo "git reset failed — aborting"; exit 0; }

# Refresh base images (Caddy/Kokoro security patches), best-effort.
docker compose pull --quiet 2>/dev/null || true

# Build first; only swap containers in if the build is clean.
if docker compose build; then
  docker compose up -d
  docker image prune -f >/dev/null 2>&1 || true
  echo "$(stamp) — deployed ${REMOTE:0:7} ✅"
else
  echo "$(stamp) — BUILD FAILED, kept ${LOCAL:0:7} running ❌"
fi
