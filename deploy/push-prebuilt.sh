#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# push-prebuilt.sh — build locally, ship the .next/ tarball to the VM.
#
# Why this exists: the 2GB VM (e2-small) OOMs when running `next build`
# even with 4GB swap — Turbopack thrashes for 10+ min or dies silently.
# Building on the Mac takes ~10s and avoids the VM's RAM ceiling
# entirely.
#
# What it does:
#   1. Builds Next.js locally with a 4GB heap cap
#   2. Tars .next/ + source + package files into one ~40MB archive
#   3. SCPs the tarball to the VM via IAP tunnel (direct SSH is flaky
#      when the service is crash-looping)
#   4. Extracts on the VM, runs `npm install` for any changed deps,
#      restarts the systemd service
#   5. Prints service status + HTTP probe so you know it landed clean
#
# Usage:
#   bash deploy/push-prebuilt.sh
#
# Prereqs (one-time): gcloud CLI configured, IAP firewall rule open,
# fnb-controller VM in asia-south1-a.
# ─────────────────────────────────────────────────────────────────────

set -e

ZONE="asia-south1-a"
VM="fnb-controller"
PROJECT="f-and-b-controller"
TARBALL="/tmp/fnb-deploy.tgz"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_DIR"

echo "▶ Building Next.js locally (4GB heap)…"
rm -rf .next
NODE_OPTIONS="--max-old-space-size=4096" npm run build

echo ""
echo "▶ Packing .next + source…"
tar czf "$TARBALL" .next src package.json package-lock.json next.config.ts
SIZE=$(ls -lh "$TARBALL" | awk '{print $5}')
echo "  tarball size: $SIZE"

echo ""
echo "▶ Uploading to VM via IAP tunnel…"
gcloud compute scp --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap \
  "$TARBALL" \
  "$VM:/tmp/fnb-deploy.tgz"

echo ""
echo "▶ Extracting + installing deps + restarting service…"
gcloud compute ssh "$VM" --project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --command='
  set -e
  cd ~/fnb-controller
  sudo systemctl stop fnb-controller || true
  rm -rf .next
  tar xzf /tmp/fnb-deploy.tgz
  rm /tmp/fnb-deploy.tgz
  npm install --no-audit --no-fund --silent
  # Rebuild native modules in case node_modules was ever copied from a
  # different platform (better-sqlite3 has a per-OS .node binary).
  npm rebuild better-sqlite3 --silent
  sudo systemctl start fnb-controller
  sleep 6
  echo ""
  echo "▶ Status:"
  echo "  service: $(sudo systemctl is-active fnb-controller)"
  echo "  http:    $(curl -sI http://localhost | head -1 | tr -d "\r")"
  echo "  db size: $(ls -lh fnb-controller.db 2>/dev/null | awk "{print \$5}" || echo MISSING)"
'

# Local cleanup
rm -f "$TARBALL"

echo ""
echo "✓ Deploy complete. Visit http://34.14.181.77"
