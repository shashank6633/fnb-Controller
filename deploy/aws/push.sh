#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# push.sh — build locally, ship to the AWS EC2 box over SSH, restart.
#
# AWS equivalent of the GCP push-prebuilt.sh. Builds on your Mac (fast,
# avoids the EC2 RAM ceiling), rsyncs the prebuilt .next + source + package
# files, runs npm install for changed deps, restarts the systemd service.
#
# Usage:
#   EC2_HOST=ubuntu@<elastic-ip> EC2_KEY=~/keys/akan.pem bash deploy/aws/push.sh
#
# Or set these once at the top of the file and just run: bash deploy/aws/push.sh
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── EDIT THESE (or pass as env vars) ──────────────────────────────────────
# Production = AWS EC2 behind https://fnb.akanhyd.com
#   EC2_HOST: ubuntu@<your-elastic-ip>   (fill in your real Elastic IP)
#   EC2_KEY : path to your .pem key      (kept private on your Mac)
EC2_HOST="${EC2_HOST:-ubuntu@CHANGE_ME_ELASTIC_IP}"
EC2_KEY="${EC2_KEY:-$HOME/keys/akan.pem}"
APP_DIR="${APP_DIR:-/opt/fnb-controller}"
# ──────────────────────────────────────────────────────────────────────────

SSH="ssh -i $EC2_KEY -o StrictHostKeyChecking=accept-new $EC2_HOST"
RSYNC_SSH="ssh -i $EC2_KEY -o StrictHostKeyChecking=accept-new"

if [[ "$EC2_HOST" == *CHANGE_ME* ]]; then
  echo "✗ Set EC2_HOST first (edit this file or export EC2_HOST=ubuntu@1.2.3.4)"; exit 1
fi

echo "▶ 1/5 — Building Next.js locally (4GB heap)…"
NODE_OPTIONS="--max-old-space-size=4096" npm run build

echo "▶ 2/5 — Syncing build + source to $EC2_HOST:$APP_DIR …"
# --delete keeps the remote in lockstep, but we PROTECT the live DB, env,
# and node_modules from deletion (they're remote-only / secret).
rsync -az --delete \
  -e "$RSYNC_SSH" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next/cache' \
  --exclude 'fnb-controller.db' \
  --exclude 'fnb-controller.db-shm' \
  --exclude 'fnb-controller.db-wal' \
  --exclude 'fnb-controller.db.bak*' \
  --exclude 'backups' \
  --exclude 'aws-migration' \
  --exclude '.claude' \
  ./ "$EC2_HOST:$APP_DIR/"

echo "▶ 3/5 — Installing changed dependencies on the VM…"
$SSH "cd $APP_DIR && npm install --omit=dev --no-audit --no-fund && npm rebuild better-sqlite3"

echo "▶ 4/5 — Installing systemd unit + restarting service…"
$SSH "sudo cp $APP_DIR/deploy/aws/fnb-controller.service /etc/systemd/system/fnb-controller.service && sudo systemctl daemon-reload && sudo systemctl restart fnb-controller"

echo "▶ 5/5 — Status + health probe…"
sleep 3
$SSH "systemctl is-active fnb-controller && curl -s -o /dev/null -w 'http: %{http_code}\n' http://127.0.0.1:3000/api/build-info && ls -lh $APP_DIR/fnb-controller.db 2>/dev/null | awk '{print \"db: \"\$5}'"

echo ""
echo "✓ Deploy complete → $EC2_HOST"
