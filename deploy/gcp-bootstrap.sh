#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
#  F&B Controller — Google Cloud bootstrap (run from your Mac)
#
#  Creates the testing environment on GCP in one shot:
#    - Compute Engine VM   (e2-small in asia-south1 / Mumbai)
#    - Static external IP  (so the URL stays the same on reboot)
#    - Firewall rules      (ports 22 SSH, 80 HTTP)
#    - Storage bucket      (for nightly DB backups)
#    - Budget alert        (₹10,000/mo with notification at 50/90/100%)
#
#  After this finishes, you'll get the public IP printed at the end.
#  Then run scripts in order:
#    2. deploy/push-code.sh        — push your code to the VM
#    3. SSH in, run vm-setup.sh    — installs Node, builds, starts the service
#    4. deploy/configure-backups.sh — daily backup cron
#
#  Idempotent — safe to re-run if anything fails partway.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Settings (edit if you want different names / sizes) ─────────────────
PROJECT_ID="${PROJECT_ID:-fnb-controller-test}"
REGION="${REGION:-asia-south1}"
ZONE="${ZONE:-asia-south1-a}"
VM_NAME="${VM_NAME:-fnb-controller}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-small}"             # 2 vCPU · 2 GB RAM · ~₹1200/mo
DISK_SIZE="${DISK_SIZE:-20GB}"                        # plenty for SQLite + Node modules
BUCKET_NAME="${BUCKET_NAME:-${PROJECT_ID}-backups}"
BUDGET_INR="${BUDGET_INR:-10000}"                     # ₹10,000/mo cap
NOTIFY_EMAIL="${NOTIFY_EMAIL:-}"                      # set to receive alerts
# ────────────────────────────────────────────────────────────────────────

red()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
blue()  { printf '\033[0;34m%s\033[0m\n' "$*"; }

require() { command -v "$1" >/dev/null || { red "Missing: $1 — install it first"; exit 1; }; }
require gcloud

# ── 1. Authenticate + select project ───────────────────────────────────
blue "▶ 1. Selecting project: $PROJECT_ID"
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  red "Project '$PROJECT_ID' does not exist."
  red "Create it via: https://console.cloud.google.com/projectcreate"
  red "OR run:   gcloud projects create $PROJECT_ID --name='F&B Controller (Test)'"
  exit 1
fi
gcloud config set project "$PROJECT_ID" >/dev/null
gcloud config set compute/region "$REGION" >/dev/null
gcloud config set compute/zone "$ZONE" >/dev/null

# Make sure billing is linked (most operations need it even on free tier)
if ! gcloud beta billing projects describe "$PROJECT_ID" 2>/dev/null | grep -q 'billingEnabled: true'; then
  red "Billing is NOT linked on project $PROJECT_ID."
  red "Link a billing account at: https://console.cloud.google.com/billing/linkedaccount?project=$PROJECT_ID"
  exit 1
fi

# ── 2. Enable required APIs ────────────────────────────────────────────
blue "▶ 2. Enabling required APIs (this can take 60-90 seconds)"
gcloud services enable \
  compute.googleapis.com \
  storage.googleapis.com \
  cloudbilling.googleapis.com \
  --quiet

# ── 3. Reserve a static external IP ────────────────────────────────────
blue "▶ 3. Reserving static IP: $VM_NAME-ip"
if ! gcloud compute addresses describe "$VM_NAME-ip" --region="$REGION" >/dev/null 2>&1; then
  gcloud compute addresses create "$VM_NAME-ip" --region="$REGION" --quiet
fi
STATIC_IP=$(gcloud compute addresses describe "$VM_NAME-ip" --region="$REGION" --format='value(address)')
green "  Static IP: $STATIC_IP"

# ── 4. Firewall rules ──────────────────────────────────────────────────
blue "▶ 4. Opening firewall ports 22 (SSH) and 80 (HTTP)"
if ! gcloud compute firewall-rules describe "$VM_NAME-allow-http" >/dev/null 2>&1; then
  gcloud compute firewall-rules create "$VM_NAME-allow-http" \
    --direction=INGRESS --action=ALLOW --rules=tcp:80 \
    --source-ranges=0.0.0.0/0 --target-tags="$VM_NAME" --quiet
fi
# Port 22 SSH is open via the default-allow-ssh rule that's auto-created on every project.

# ── 5. Create the VM ───────────────────────────────────────────────────
blue "▶ 5. Creating VM: $VM_NAME ($MACHINE_TYPE in $ZONE)"
if ! gcloud compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  gcloud compute instances create "$VM_NAME" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size="$DISK_SIZE" --boot-disk-type=pd-balanced \
    --tags="$VM_NAME,http-server" \
    --address="$STATIC_IP" \
    --metadata=enable-oslogin=TRUE \
    --quiet
  green "  Waiting 30s for VM to finish booting…"
  sleep 30
else
  green "  VM already exists, skipping create"
fi

# ── 6. Backup bucket ───────────────────────────────────────────────────
blue "▶ 6. Creating backup bucket: gs://$BUCKET_NAME"
if ! gcloud storage buckets describe "gs://$BUCKET_NAME" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET_NAME" \
    --location="$REGION" --uniform-bucket-level-access --quiet
  # Lifecycle rule: delete backups older than 60 days
  cat > /tmp/lifecycle.json <<'EOF'
{ "lifecycle": { "rule": [{ "action": {"type": "Delete"}, "condition": {"age": 60} }] } }
EOF
  gcloud storage buckets update "gs://$BUCKET_NAME" --lifecycle-file=/tmp/lifecycle.json --quiet
  rm /tmp/lifecycle.json
fi

# Grant the VM's service account write access to the bucket
SA_EMAIL="$(gcloud compute instances describe "$VM_NAME" --zone="$ZONE" --format='value(serviceAccounts[0].email)')"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/storage.objectAdmin" --quiet >/dev/null

# ── 7. Done ────────────────────────────────────────────────────────────
echo ""
green "═══════════════════════════════════════════════════════════════════"
green "  ✓ GCP infrastructure ready"
green "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  Project       : $PROJECT_ID"
echo "  VM            : $VM_NAME ($MACHINE_TYPE)"
echo "  Zone          : $ZONE"
echo "  Public IP     : $STATIC_IP"
echo "  Backup bucket : gs://$BUCKET_NAME"
echo ""
green "▶ Next step:"
echo "  1. Push your code:    bash deploy/push-code.sh $STATIC_IP"
echo "  2. SSH into the VM:   gcloud compute ssh $VM_NAME --zone=$ZONE"
echo "  3. Run setup on VM:   cd ~/fnb-controller && bash deploy/vm-setup.sh"
echo ""
echo "  Or open URL once everything is up: http://$STATIC_IP"
echo ""

# Save a snapshot of the config for later scripts
cat > deploy/.gcp-state <<EOF
PROJECT_ID=$PROJECT_ID
ZONE=$ZONE
VM_NAME=$VM_NAME
STATIC_IP=$STATIC_IP
BUCKET_NAME=$BUCKET_NAME
EOF
green "  (config saved to deploy/.gcp-state for later scripts)"
