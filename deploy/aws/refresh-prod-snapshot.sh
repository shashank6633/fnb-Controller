#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# refresh-prod-snapshot.sh — pull a FRESH, consistent copy of the live GCP
# production database into aws-migration/fnb-controller.db.
#
# Run this RIGHT BEFORE the AWS cutover so the migration carries the latest
# data (any requisitions / approvals / GRNs made since the last pull).
#
# What it does on the GCP prod VM:
#   1. PRAGMA wal_checkpoint(TRUNCATE)  — merge the WAL into the main DB
#   2. sqlite3 .backup                  — safe online snapshot (app stays up)
#   3. PRAGMA integrity_check           — verify the snapshot isn't corrupt
#   4. prints row counts                — sanity (users / requisitions / materials)
# Then downloads it to aws-migration/fnb-controller.db and re-verifies locally.
#
# Usage:
#   bash deploy/aws/refresh-prod-snapshot.sh
#
# Prereqs: gcloud CLI authed, IAP tunnel access to the fnb-controller VM.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ZONE="${ZONE:-asia-south1-a}"
VM="${VM:-fnb-controller}"
PROJECT="${PROJECT:-f-and-b-controller}"
REMOTE_DIR="${REMOTE_DIR:-/home/shashankeurpaka_gmail_com/fnb-controller}"
OUT="${OUT:-aws-migration/fnb-controller.db}"

GCLOUD_FILTER='grep -v "WARNING\|NumPy\|cloud.google\|^$"'

mkdir -p "$(dirname "$OUT")"

echo "▶ 1/3 — Checkpoint WAL + create consistent snapshot on $VM…"
gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --command="
  set -e
  cd '$REMOTE_DIR'
  sqlite3 fnb-controller.db 'PRAGMA wal_checkpoint(TRUNCATE);'
  rm -f /tmp/fnb-cutover.db
  sqlite3 fnb-controller.db \".backup '/tmp/fnb-cutover.db'\"
  echo -n 'integrity: '; sqlite3 /tmp/fnb-cutover.db 'PRAGMA integrity_check;' | head -1
  echo -n 'users=';        sqlite3 /tmp/fnb-cutover.db 'SELECT count(*) FROM users;'
  echo -n 'requisitions='; sqlite3 /tmp/fnb-cutover.db 'SELECT count(*) FROM requisitions;'
  echo -n 'raw_materials=';sqlite3 /tmp/fnb-cutover.db 'SELECT count(*) FROM raw_materials;'
  echo -n 'size=';         du -h /tmp/fnb-cutover.db | cut -f1
" 2>&1 | eval "$GCLOUD_FILTER"

echo "▶ 2/3 — Downloading snapshot → $OUT …"
gcloud compute scp --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap \
  "$VM:/tmp/fnb-cutover.db" "$OUT" 2>&1 | eval "$GCLOUD_FILTER" || true

echo "▶ 3/3 — Verifying local copy…"
LOCAL_INTEGRITY="$(sqlite3 "$OUT" 'PRAGMA integrity_check;' | head -1)"
LOCAL_USERS="$(sqlite3 "$OUT" 'SELECT count(*) FROM users;')"
LOCAL_REQS="$(sqlite3 "$OUT" 'SELECT count(*) FROM requisitions;')"
echo "  local integrity: $LOCAL_INTEGRITY"
echo "  local users=$LOCAL_USERS · requisitions=$LOCAL_REQS"
echo "  $(ls -lh "$OUT" | awk '{print "size: "$5}')"

if [[ "$LOCAL_INTEGRITY" != "ok" ]]; then
  echo "✗ Local integrity check FAILED — do NOT use this snapshot."; exit 1
fi

echo ""
echo "✓ Fresh production snapshot ready at $OUT"
echo "  Next: scp it to the EC2 box (RUNBOOK §4 or §10) and restart the service."
