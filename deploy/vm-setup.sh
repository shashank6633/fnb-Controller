#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Run this ON THE VM (not on your Mac) after you've pushed the code.
#
# Installs:
#   - Node.js 22 LTS via NodeSource
#   - build-essential + python3 (for better-sqlite3 native build)
#   - nginx (reverse proxy 80 → 3000)
#   - the systemd unit so the app auto-starts on reboot
#   - daily backup cron
#
# Idempotent: safe to re-run after `git pull` to apply updates.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root

echo "▶ Detecting environment"
if [[ ! -f "package.json" ]]; then
  echo "ERROR: package.json not found. Run this script from the repo root." >&2
  exit 1
fi

# ── 1. System packages ─────────────────────────────────────────────────
if ! command -v node >/dev/null || [[ "$(node -v)" != v22.* ]]; then
  echo "▶ 1. Installing Node.js 22 LTS"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "  Node:    $(node -v)"
echo "  npm:     $(npm -v)"

if ! dpkg -l | grep -q build-essential; then
  echo "▶ 2. Installing build tools (for better-sqlite3 native build)"
  sudo apt-get install -y build-essential python3 sqlite3
fi

if ! command -v nginx >/dev/null; then
  echo "▶ 3. Installing nginx"
  sudo apt-get install -y nginx
fi

# ── 2. Install Node deps + build ───────────────────────────────────────
echo "▶ 4. Installing Node modules (~3 minutes)"
npm install --no-audit --no-fund

echo "▶ 5. Building Next.js app (~2 minutes)"
npm run build

# ── 3. nginx reverse proxy ─────────────────────────────────────────────
echo "▶ 6. Configuring nginx (port 80 → Next.js 3000)"
sudo cp deploy/nginx.conf /etc/nginx/sites-available/fnb-controller
sudo ln -sf /etc/nginx/sites-available/fnb-controller /etc/nginx/sites-enabled/fnb-controller
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

# ── 4. systemd service ─────────────────────────────────────────────────
echo "▶ 7. Installing systemd service"
sudo cp deploy/fnb-controller.service /etc/systemd/system/fnb-controller.service
# Replace placeholder paths with the real values
sudo sed -i "s|__USER__|$USER|g; s|__APP_DIR__|$(pwd)|g" /etc/systemd/system/fnb-controller.service
sudo systemctl daemon-reload
sudo systemctl enable --now fnb-controller

# ── 5. Wait + smoke test ───────────────────────────────────────────────
echo "▶ 8. Waiting 8 seconds for the service to start…"
sleep 8

if curl -sf http://localhost:3000 >/dev/null 2>&1 || curl -sI http://localhost:3000 2>&1 | head -1 | grep -q '^HTTP'; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo "  ✓ FNB Controller is running"
  echo "═══════════════════════════════════════════════════════════════════"
  EXTERNAL_IP="$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || echo '<unknown>')"
  echo ""
  echo "  Open in browser:    http://$EXTERNAL_IP"
  echo "  Service status:     sudo systemctl status fnb-controller"
  echo "  Tail logs:          sudo journalctl -u fnb-controller -f"
  echo "  Restart:            sudo systemctl restart fnb-controller"
  echo ""
  echo "  Database location:  $(pwd)/fnb-controller.db"
  echo ""
  echo "▶ Optional next step: enable nightly backups"
  echo "  bash deploy/configure-backups.sh"
else
  echo ""
  echo "WARNING: Service is up but not responding on port 3000 yet."
  echo "Check logs:   sudo journalctl -u fnb-controller --since '2 minutes ago'"
fi
