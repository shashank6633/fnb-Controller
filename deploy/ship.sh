#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# ship.sh — one command to deploy to either environment.
#
#   bash deploy/ship.sh testing      → GCP VM (34.14.181.77) via IAP tunnel
#   bash deploy/ship.sh production    → AWS EC2 (fnb.akanhyd.com) via SSH
#
# Both build locally first (fast, avoids the VM RAM ceiling), then push the
# prebuilt .next + source and restart the service.
#
# THE GOLDEN RULE: always ship to `testing` first, verify on 34.14.181.77,
# THEN ship the SAME code to `production`. Never push straight to production.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "$ENV" in
  testing|test|gcp|staging)
    echo "════════════════════════════════════════════════════"
    echo "  Deploying to  TESTING  (GCP · http://34.14.181.77)"
    echo "════════════════════════════════════════════════════"
    bash "$ROOT/deploy/push-prebuilt.sh"
    ;;

  production|prod|aws|live)
    echo "════════════════════════════════════════════════════"
    echo "  Deploying to  PRODUCTION  (AWS · https://fnb.akanhyd.com)"
    echo "════════════════════════════════════════════════════"
    # Safety prompt — production is real users.
    read -r -p "  ⚠  Ship to PRODUCTION? Did you verify on testing first? [y/N] " ok
    [[ "$ok" == "y" || "$ok" == "Y" ]] || { echo "  aborted."; exit 1; }
    # EC2_HOST + EC2_KEY come from your shell env or deploy/aws/push.sh defaults.
    bash "$ROOT/deploy/aws/push.sh"
    ;;

  *)
    echo "Usage: bash deploy/ship.sh <testing|production>"
    echo ""
    echo "  testing      → GCP  (http://34.14.181.77)        — verify here first"
    echo "  production   → AWS  (https://fnb.akanhyd.com)    — only after testing passes"
    exit 1
    ;;
esac
