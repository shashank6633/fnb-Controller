#!/usr/bin/env bash
# Run on the VM to set up nightly backups of fnb-controller.db to Cloud Storage.
# Reads the bucket name from the project metadata (set by gcp-bootstrap.sh).
set -euo pipefail

cd "$(dirname "$0")/.."

# Try to detect the bucket name from common project metadata, else ask
PROJECT_ID="$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/project/project-id || echo '')"
BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-backups}"
APP_DIR="$(pwd)"
DB_PATH="$APP_DIR/fnb-controller.db"

echo "▶ Backup config:"
echo "  Project    : $PROJECT_ID"
echo "  Bucket     : gs://$BUCKET_NAME"
echo "  DB path    : $DB_PATH"
echo "  Schedule   : Daily at 02:30 IST"
echo ""

if ! command -v gsutil >/dev/null && ! command -v gcloud >/dev/null; then
  echo "ERROR: gcloud CLI not installed on this VM."
  echo "Install: https://cloud.google.com/sdk/docs/install#deb"
  exit 1
fi

# Make sure the bucket actually exists and we can write to it
if ! gcloud storage buckets describe "gs://$BUCKET_NAME" >/dev/null 2>&1; then
  echo "ERROR: Bucket gs://$BUCKET_NAME doesn't exist or no permission."
  echo "Ran the bootstrap script? It creates this bucket."
  exit 1
fi

# Drop the backup script in /usr/local/bin so cron can find it
sudo tee /usr/local/bin/fnb-backup.sh >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
TS=\$(date -u +%Y-%m-%dT%H-%M-%SZ)
TMP=/tmp/fnb-backup-\$TS.sql.gz
# Use sqlite3 .dump (consistent across WAL state) instead of cp the live file
sqlite3 "$DB_PATH" .dump | gzip > "\$TMP"
gcloud storage cp "\$TMP" "gs://$BUCKET_NAME/daily/backup-\$TS.sql.gz" --quiet
rm "\$TMP"
echo "[\$(date -u)] backup-\$TS.sql.gz uploaded"
EOF
sudo chmod +x /usr/local/bin/fnb-backup.sh

# Cron entry — runs at 02:30 server time (UTC), which is 08:00 IST.
# Adjust as needed; using UTC keeps it predictable across timezones.
( sudo crontab -l 2>/dev/null | grep -v fnb-backup.sh; echo "30 2 * * * /usr/local/bin/fnb-backup.sh >> /var/log/fnb-backup.log 2>&1" ) | sudo crontab -

# Run one immediately to verify everything works
echo "▶ Running first backup right now to verify…"
sudo /usr/local/bin/fnb-backup.sh

echo ""
echo "✓ Backups configured."
echo ""
echo "  Daily: 02:30 UTC = 08:00 IST"
echo "  Live log:    sudo tail -f /var/log/fnb-backup.log"
echo "  List backups: gcloud storage ls gs://$BUCKET_NAME/daily/"
echo "  Restore:     gcloud storage cp gs://$BUCKET_NAME/daily/backup-XXX.sql.gz - | gunzip | sqlite3 $DB_PATH"
