#!/usr/bin/env bash
#
# Nightly SQLite backup with 30-day rotation.
# Cron suggestion (every night at 2:30 AM):
#   30 2 * * * /Users/shashankreddy/Desktop/Claude/fnb-controller/scripts/backup-db.sh >> /Users/shashankreddy/Desktop/Claude/fnb-controller/backups/backup.log 2>&1
#
# Uses sqlite3 .dump (text SQL) so backups survive better-sqlite3 version bumps.
# Gzipped, dated. Restore:
#   gunzip -c backups/backup-2026-05-12.sql.gz | sqlite3 restored.db
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$REPO_DIR/fnb-controller.db"
BACKUP_DIR="$REPO_DIR/backups"
DATE_STAMP="$(date +%F)"           # YYYY-MM-DD
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[$(date)] ✗ DB not found at $DB_PATH — abort" >&2
  exit 1
fi

OUT="$BACKUP_DIR/backup-$DATE_STAMP.sql.gz"

# Use .dump (portable) inside a transaction for a consistent snapshot
sqlite3 "$DB_PATH" ".dump" | gzip -9 > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"

SIZE_KB=$(du -k "$OUT" | cut -f1)
ROW_COUNT=$(sqlite3 "$DB_PATH" "SELECT (SELECT COUNT(*) FROM sales) + (SELECT COUNT(*) FROM purchases) + (SELECT COUNT(*) FROM raw_materials);")

echo "[$(date)] ✓ Backup written: $OUT (${SIZE_KB} KB, ${ROW_COUNT} canonical rows)"

# Rotate — delete backups older than retention window
find "$BACKUP_DIR" -name 'backup-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete

# Keep a stable symlink for the latest
ln -sf "backup-$DATE_STAMP.sql.gz" "$BACKUP_DIR/latest.sql.gz"

echo "[$(date)] ✓ Rotation complete — keeping last $RETENTION_DAYS days"
