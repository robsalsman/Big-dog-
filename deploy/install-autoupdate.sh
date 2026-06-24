#!/usr/bin/env bash
# One-time installer: registers Big Dog's auto-update as a systemd timer so the
# app keeps itself current (code + base images) with no babysitting, and also
# turns on unattended OS security updates. Run once, as root, from the repo:
#   sudo bash deploy/install-autoupdate.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
chmod +x "$REPO_DIR/deploy/autoupdate.sh"

echo "Installing Big Dog auto-update from: $REPO_DIR"

cat >/etc/systemd/system/bigdog-update.service <<EOF
[Unit]
Description=Big Dog auto-update (git pull + rebuild if changed)
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=$REPO_DIR/deploy/autoupdate.sh
EOF

cat >/etc/systemd/system/bigdog-update.timer <<'EOF'
[Unit]
Description=Check for Big Dog updates every 15 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now bigdog-update.timer

# Unattended OS security updates (no auto-reboot by default).
if command -v apt-get >/dev/null 2>&1; then
  echo "Enabling unattended OS security updates…"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 || true
  dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
fi

echo
echo "✅ Auto-update is on. Big Dog now updates itself within ~15 min of any new release."
echo "   Next runs:   systemctl list-timers bigdog-update.timer"
echo "   Update log:  tail -f /var/log/bigdog-update.log"
echo "   Run now:     systemctl start bigdog-update.service"
