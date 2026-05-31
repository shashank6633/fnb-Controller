#!/usr/bin/env bash
# Push your local code to the GCP VM.
#
# Two modes:
#   bash deploy/push-code.sh                 → safe code-only push (default).
#                                              Preserves node_modules + .next +
#                                              fnb-controller.db on the VM.
#                                              Use this for every iteration.
#
#   bash deploy/push-code.sh --with-db       → also overwrite the VM's DB with
#                                              your local copy. Use ONLY for the
#                                              initial migration. Otherwise you'll
#                                              destroy live testing data.
#
# Always runs `npm install && npm run build && systemctl restart` on the VM.
set -euo pipefail

[[ -f deploy/.gcp-state ]] && source deploy/.gcp-state
VM_NAME="${VM_NAME:-fnb-controller}"
ZONE="${ZONE:-asia-south1-a}"

WITH_DB=0
[[ "${1:-}" == "--with-db" ]] && WITH_DB=1

if [[ ! -f "package.json" ]]; then
  echo "ERROR: run from repo root (where package.json lives)" >&2
  exit 1
fi

# Tar with safe excludes. fnb-controller.db is excluded by default to protect
# live VM data; opt in with --with-db when you actually want to overwrite.
echo "▶ Packing code into a tarball…"
TARBALL=/tmp/fnb-controller-deploy.tgz
DB_EXCLUDE=()
if [[ $WITH_DB -eq 0 ]]; then
  DB_EXCLUDE=(--exclude='fnb-controller.db' --exclude='fnb-controller.db-shm' --exclude='fnb-controller.db-wal')
  echo "  (fnb-controller.db EXCLUDED — VM data preserved. Pass --with-db to override.)"
else
  echo "  ⚠ fnb-controller.db INCLUDED — will overwrite VM data."
fi

tar -czf "$TARBALL" \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='backups' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  --exclude='deploy/.gcp-state' \
  "${DB_EXCLUDE[@]}" \
  .

SIZE=$(du -h "$TARBALL" | cut -f1)
echo "  Tarball: $TARBALL ($SIZE)"

echo "▶ Uploading to VM ($VM_NAME)…"
gcloud compute scp "$TARBALL" "$VM_NAME:~/fnb-controller-deploy.tgz" --zone="$ZONE" --quiet

# Extract OVER the existing dir (no rm -rf), preserving node_modules + .next
# + fnb-controller.db. Then run install + build + restart in one shot.
echo "▶ Unpacking on the VM (preserving node_modules / .next / DB)…"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command='
  set -e
  cd ~ && mkdir -p ~/fnb-controller
  tar -xzf ~/fnb-controller-deploy.tgz -C ~/fnb-controller --no-same-owner
  rm ~/fnb-controller-deploy.tgz
  cd ~/fnb-controller
  echo ""
  echo "▶ npm install (only changed deps will fetch)…"
  npm install --no-audit --no-fund --silent
  echo ""
  echo "▶ Building Next.js (capped at 3GB heap for 2GB VM + swap)…"
  rm -rf .next
  NODE_OPTIONS="--max-old-space-size=3072" npm run build
  echo ""
  echo "▶ Restarting service…"
  sudo systemctl restart fnb-controller
  sleep 6
  echo ""
  echo "Service status:" $(sudo systemctl is-active fnb-controller)
  echo "DB size:        " $(ls -lh fnb-controller.db 2>/dev/null | awk "{print \$5}" || echo "MISSING")
  echo "HTTP test:      " $(curl -sI http://localhost 2>/dev/null | head -1 || echo "FAILED")
'

rm "$TARBALL"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Push + build + restart complete"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Open in browser:    http://${STATIC_IP:-34.14.181.77}"
echo "  Tail logs:          gcloud compute ssh $VM_NAME --zone=$ZONE -- sudo journalctl -u fnb-controller -f"
