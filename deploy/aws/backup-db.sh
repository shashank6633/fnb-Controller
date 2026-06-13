#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# backup-db.sh — checkpoint the SQLite WAL, snapshot the DB, upload to S3.
# Runs ON the EC2 box via cron. Keeps the last 30 daily snapshots on disk
# and pushes each to S3 (S3 lifecycle policy can expire old ones).
#
# Prereqs on the box:
#   - aws CLI installed (sudo snap install aws-cli --classic)
#   - EC2 instance has an IAM role with s3:PutObject on the bucket
#     (no access keys needed when using an instance role)
#
# Cron (daily 02:00 server time):
#   sudo crontab -e
#   0 2 * * * BUCKET=s3://akan-fnb-backups /opt/fnb-controller/deploy/aws/backup-db.sh >> /var/log/fnb-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fnb-controller}"
DB="$APP_DIR/fnb-controller.db"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-$APP_DIR/backups}"
BUCKET="${BUCKET:-}"                 # e.g. s3://akan-fnb-backups  (required for S3 upload)
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$LOCAL_BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$LOCAL_BACKUP_DIR/fnb-controller-$STAMP.db"

echo "[$(date)] checkpointing WAL + snapshotting…"
# Merge WAL into the main DB so the snapshot is complete + consistent.
sqlite3 "$DB" 'PRAGMA wal_checkpoint(TRUNCATE);'
# Use sqlite's online backup API (safe even while the app is writing).
sqlite3 "$DB" ".backup '$OUT'"
sqlite3 "$OUT" 'PRAGMA integrity_check;' | head -1

# Compress to save space + transfer.
gzip -f "$OUT"
echo "[$(date)] wrote ${OUT}.gz"

# Upload to S3 if a bucket is configured.
if [[ -n "$BUCKET" ]]; then
  aws s3 cp "${OUT}.gz" "$BUCKET/$(basename "${OUT}.gz")"
  echo "[$(date)] uploaded to $BUCKET"
else
  echo "[$(date)] BUCKET not set — kept local only."
fi

# Prune local snapshots older than KEEP_DAYS.
find "$LOCAL_BACKUP_DIR" -name 'fnb-controller-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "[$(date)] pruned local backups older than ${KEEP_DAYS}d."
