#!/usr/bin/env bash
#
# Nightly SQLite backup with 30-day rotation.
# Cron suggestion (every night at 2:30 AM):
#   30 2 * * * /Users/shashankreddy/Desktop/Claude/fnb-controller/scripts/backup-db.sh >> /Users/shashankreddy/Desktop/Claude/fnb-controller/backups/backup.log 2>&1
#
# Uses VACUUM INTO (binary snapshot) — see the comment at the backup step for
# why .dump was retired when the HRMS document vault (BLOBs) arrived.
# Gzipped, dated. Restore:
#   gunzip -c backups/backup-YYYY-MM-DD.db.gz > restored.db   (binary snapshot — use directly)
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

OUT="$BACKUP_DIR/backup-$DATE_STAMP.db.gz"

# VACUUM INTO, not .dump: the HRMS document vault (hr_documents.data) stores
# BLOBs, and .dump renders a BLOB as X'..' hex — 2 text bytes per byte of
# file that gzip cannot compress, so a document vault would hex-double every
# nightly backup on this 40GB disk (docs/HRMS_DECISIONS.md D4). VACUUM INTO
# writes a consistent, compacted binary snapshot through SQLite itself (WAL
# included), which gzip then compresses normally. Restore: gunzip and use the
# .db directly — no .read step anymore.
TMP_DB="$BACKUP_DIR/.snapshot-$DATE_STAMP.db"
# Failure-path cleanup: with set -e, a failure between VACUUM INTO and the
# final mv would otherwise strand an uncompressed .snapshot-*.db and/or a
# *.gz.tmp that rotation never matches. The happy path mv's $OUT.tmp away and
# rm's $TMP_DB before EXIT fires, so this trap is a no-op on success.
trap 'rm -f "$TMP_DB" "$OUT.tmp"' EXIT
rm -f "$TMP_DB"
# Open the source PLAIN (read-write, exactly as the old .dump did) — NOT
# mode=ro: a read-only open cannot recover a WAL that needs it (app crashed
# and not restarted), which is precisely the window a backup matters most.
# A read transaction cannot corrupt the source; VACUUM INTO is still a
# consistent snapshot.
sqlite3 "$DB_PATH" "VACUUM INTO '$TMP_DB'"
gzip -9 < "$TMP_DB" > "$OUT.tmp"
rm -f "$TMP_DB"
mv "$OUT.tmp" "$OUT"

SIZE_KB=$(du -k "$OUT" | cut -f1)
ROW_COUNT=$(sqlite3 "$DB_PATH" "SELECT (SELECT COUNT(*) FROM sales) + (SELECT COUNT(*) FROM purchases) + (SELECT COUNT(*) FROM raw_materials);")

echo "[$(date)] ✓ Backup written: $OUT (${SIZE_KB} KB, ${ROW_COUNT} canonical rows)"

# Rotate — delete backups older than retention window
find "$BACKUP_DIR" \( -name 'backup-*.sql.gz' -o -name 'backup-*.db.gz' \) -mtime "+${RETENTION_DAYS}" -delete

# Keep a stable symlink for the latest. One-time migration cleanup: the old
# latest.sql.gz points at .sql.gz backups rotation will delete — remove it so
# no restore habit follows a dangling link.
rm -f "$BACKUP_DIR/latest.sql.gz"
ln -sf "backup-$DATE_STAMP.db.gz" "$BACKUP_DIR/latest.db.gz"

echo "[$(date)] ✓ Rotation complete — keeping last $RETENTION_DAYS days"
