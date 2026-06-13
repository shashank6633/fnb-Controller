#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# vm-setup.sh — one-time bootstrap of a fresh Ubuntu 22.04 EC2 instance for
# the F&B Controller. Run this ON the EC2 box (via SSH) once, before the
# first deploy.
#
#   scp -i your-key.pem deploy/aws/vm-setup.sh ubuntu@<elastic-ip>:/tmp/
#   ssh -i your-key.pem ubuntu@<elastic-ip> "bash /tmp/vm-setup.sh"
#
# Installs: Node 20, nginx, the systemd unit, app dir. Does NOT touch
# secrets — you create /etc/fnb-controller.env and drop the Google JSON
# key separately (see RUNBOOK).
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="/opt/fnb-controller"
APP_USER="ubuntu"

echo "▶ 1/7 — apt update + base packages"
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg nginx sqlite3 rsync

echo "▶ 2/7 — Node.js 20 (NodeSource)"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v && npm -v

echo "▶ 3/7 — app directory at $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "▶ 4/7 — config dir for secrets at /etc/fnb-controller"
sudo mkdir -p /etc/fnb-controller
sudo chmod 750 /etc/fnb-controller

echo "▶ 5/7 — placeholder env file (EDIT THIS with real values before starting)"
if [[ ! -f /etc/fnb-controller.env ]]; then
  sudo tee /etc/fnb-controller.env >/dev/null <<'EOF'
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
# Path to the Google service-account JSON key you uploaded:
GOOGLE_APPLICATION_CREDENTIALS=/etc/fnb-controller/google-sa.json
# Force in-process scheduler on:
ENABLE_SCHEDULER=1
# Optional — only if you call /api/cron/refresh-parties externally:
# CRON_TOKEN=change-me
EOF
  sudo chmod 600 /etc/fnb-controller.env
  echo "  → created /etc/fnb-controller.env (chmod 600). EDIT the values."
else
  echo "  → /etc/fnb-controller.env already exists — left untouched."
fi

echo "▶ 6/7 — systemd unit"
if [[ -f "$APP_DIR/deploy/aws/fnb-controller.service" ]]; then
  sudo cp "$APP_DIR/deploy/aws/fnb-controller.service" /etc/systemd/system/fnb-controller.service
else
  echo "  ! service file not found yet — copy it after first deploy, then:"
  echo "    sudo cp $APP_DIR/deploy/aws/fnb-controller.service /etc/systemd/system/"
fi
sudo systemctl daemon-reload
sudo systemctl enable fnb-controller || true

echo "▶ 7/7 — nginx reverse proxy"
if [[ -f "$APP_DIR/deploy/aws/nginx.conf" ]]; then
  sudo cp "$APP_DIR/deploy/aws/nginx.conf" /etc/nginx/sites-available/fnb-controller
  sudo ln -sf /etc/nginx/sites-available/fnb-controller /etc/nginx/sites-enabled/fnb-controller
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
else
  echo "  ! nginx.conf not found yet — copy it after first deploy."
fi

echo ""
echo "✓ Base setup done. NEXT:"
echo "  1. Upload Google JSON key  → /etc/fnb-controller/google-sa.json (chmod 600)"
echo "  2. Edit /etc/fnb-controller.env with real values"
echo "  3. Upload the production DB → $APP_DIR/fnb-controller.db"
echo "  4. Run the deploy from your Mac:  bash deploy/aws/push.sh"
echo "  5. sudo systemctl start fnb-controller"
echo "  6. Add TLS:  sudo certbot --nginx -d yourdomain.com"
