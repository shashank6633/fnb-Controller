#!/usr/bin/env bash
# Pull the live source + DB from the GCP VM down to your Mac.
# Two output modes:
#
#   bash deploy/pull-code.sh                       → save tarball to ~/Desktop
#                                                    (default — safest, doesn't
#                                                    touch your local working tree)
#
#   bash deploy/pull-code.sh --extract <dir>       → extract directly into <dir>
#                                                    (use for reviewing the live
#                                                    state side-by-side; never
#                                                    overwrites the dir you ran
#                                                    the command from)
#
#   bash deploy/pull-code.sh --db-only             → only pulls fnb-controller.db
#                                                    (saved to ~/Desktop/vm-snapshot-DATE.db)
#
# Excludes: node_modules, .next, backups, .git
set -euo pipefail

[[ -f deploy/.gcp-state ]] && source deploy/.gcp-state
VM_NAME="${VM_NAME:-fnb-controller}"
ZONE="${ZONE:-asia-south1-a}"

MODE="full"
EXTRACT_DIR=""
case "${1:-}" in
  --db-only) MODE="db-only" ;;
  --extract) MODE="extract"; EXTRACT_DIR="${2:-}"
             [[ -z "$EXTRACT_DIR" ]] && { echo "Usage: $0 --extract <target-dir>"; exit 1; } ;;
esac

DATE_TAG="$(date +%Y-%m-%d_%H%M)"

# ── DB-only mode ──
if [[ "$MODE" == "db-only" ]]; then
  OUT="$HOME/Desktop/vm-snapshot-${DATE_TAG}.db"
  echo "▶ Downloading live SQLite DB to $OUT"
  gcloud compute scp "${VM_NAME}:~/fnb-controller/fnb-controller.db" "$OUT" --zone="$ZONE" --quiet
  SIZE=$(du -h "$OUT" | cut -f1)
  ROWS=$(sqlite3 "$OUT" "SELECT COUNT(*) FROM sales;" 2>/dev/null || echo "?")
  echo ""
  echo "✓ Saved $OUT ($SIZE, $ROWS sales rows)"
  exit 0
fi

# ── Full source mode ──
echo "▶ Building tarball on the VM (excluding node_modules, .next, backups, .git)…"
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="
  set -e
  cd ~
  tar -czf ~/fnb-controller-source.tgz \
    --exclude='fnb-controller/node_modules' \
    --exclude='fnb-controller/.next' \
    --exclude='fnb-controller/backups' \
    --exclude='fnb-controller/.git' \
    --exclude='fnb-controller/.DS_Store' \
    --exclude='fnb-controller/*.log' \
    fnb-controller/
  echo '  Tarball:' \$(du -h ~/fnb-controller-source.tgz | cut -f1)
"

if [[ "$MODE" == "extract" ]]; then
  # Extract directly into a target directory on the Mac (creates if missing)
  mkdir -p "$EXTRACT_DIR"
  ABS_DIR=$(cd "$EXTRACT_DIR" && pwd)
  if [[ "$ABS_DIR" == "$(pwd)" ]]; then
    echo "ERROR: --extract target must NOT be the current directory (would overwrite your edits)" >&2
    exit 1
  fi
  echo "▶ Streaming + extracting into $ABS_DIR"
  gcloud compute scp "${VM_NAME}:~/fnb-controller-source.tgz" /tmp/fnb-pull.tgz --zone="$ZONE" --quiet
  tar -xzf /tmp/fnb-pull.tgz -C "$ABS_DIR" --strip-components=1
  rm /tmp/fnb-pull.tgz
  echo ""
  echo "✓ Extracted to $ABS_DIR"
  echo "  Files:" $(ls "$ABS_DIR" | wc -l | tr -d ' ')
  echo "  DB:" $(ls -lh "$ABS_DIR/fnb-controller.db" 2>/dev/null | awk '{print $5}' || echo 'absent')
else
  # Default — save tarball to ~/Desktop
  OUT="$HOME/Desktop/fnb-controller-source-${DATE_TAG}.tgz"
  echo "▶ Downloading tarball to $OUT"
  gcloud compute scp "${VM_NAME}:~/fnb-controller-source.tgz" "$OUT" --zone="$ZONE" --quiet
  SIZE=$(du -h "$OUT" | cut -f1)
  echo ""
  echo "✓ Saved $OUT ($SIZE)"
  echo ""
  echo "  Inspect:        tar -tzf \"$OUT\" | head -30"
  echo "  Extract:        tar -xzf \"$OUT\" -C ~/Desktop/"
fi

# Clean up tarball on VM
gcloud compute ssh "$VM_NAME" --zone="$ZONE" --quiet --command="rm -f ~/fnb-controller-source.tgz"
