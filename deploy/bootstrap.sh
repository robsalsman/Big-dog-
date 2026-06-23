#!/usr/bin/env bash
# One-shot deploy for Big Dog on a fresh Ubuntu server (e.g. an IONOS VPS).
# Installs Docker, fetches the code, configures, and launches the app behind
# Caddy with automatic HTTPS at bigdog.builda.company.
#
# Usage (as root):
#   bash deploy/bootstrap.sh
# or fully non-interactive:
#   GH_USER=you GH_TOKEN=ghp_xxx ANTHROPIC_API_KEY=sk-ant-xxx \
#     DOMAIN=bigdog.builda.company bash deploy/bootstrap.sh
set -euo pipefail

DOMAIN="${DOMAIN:-bigdog.builda.company}"
BRANCH="${BRANCH:-claude/big-dog-sales-assistant-h82vpz}"
REPO="${REPO:-github.com/robsalsman/big-dog-.git}"
APP_DIR="${APP_DIR:-/opt/bigdog}"

echo "== Big Dog deploy → ${DOMAIN} =="

# 1. Docker + git
if ! command -v docker >/dev/null 2>&1; then
  echo "-- installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -y && apt-get install -y git; }

# 2. Firewall — keep SSH, open web ports for Caddy/ACME
if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
  yes | ufw enable || true
fi

# 3. Fetch the code (private repo → needs a GitHub username + token)
if [ ! -d "${APP_DIR}/.git" ]; then
  : "${GH_USER:=}"; : "${GH_TOKEN:=}"
  if [ -z "${GH_USER}" ]; then read -rp "GitHub username: " GH_USER; fi
  if [ -z "${GH_TOKEN}" ]; then read -rsp "GitHub token (PAT, repo read): " GH_TOKEN; echo; fi
  git clone -b "${BRANCH}" "https://${GH_USER}:${GH_TOKEN}@${REPO}" "${APP_DIR}"
else
  echo "-- ${APP_DIR} exists, pulling latest"
  git -C "${APP_DIR}" pull --ff-only || true
fi
cd "${APP_DIR}"

# 4. Configure .env (preserve an existing one)
if [ ! -f .env ]; then
  cp .env.example .env
  PW="$(openssl rand -base64 18)"
  sed -i "s|^BIGDOG_PASSWORD=.*|BIGDOG_PASSWORD=${PW}|" .env
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}|" .env
  fi
  echo "${PW}" > .bigdog_password
  echo "-- generated dashboard password (saved to ${APP_DIR}/.bigdog_password)"
fi

# 5. Point Caddy at the chosen domain
sed -i "s|^bigdog\.builda\.company|${DOMAIN}|" Caddyfile || true

# 6. Build + launch
echo "-- building and starting (first build pulls Chrome; give it a few minutes)"
docker compose up -d --build

echo
echo "== Done. =="
echo "Dashboard:  https://${DOMAIN}"
[ -f .bigdog_password ] && echo "Password:   $(cat .bigdog_password)"
echo "TLS issues automatically once ${DOMAIN} points at this server (DNS A record)."
echo "Logs:       docker compose logs -f bigdog   |   docker compose logs -f caddy"
