# AWS Migration Runbook — F&B Controller

Move the **live GCP production** to AWS EC2, preserving all data. You keep
every secret; nothing sensitive is committed to the repo.

---

## 0. What you already have (in this repo)

| File | Purpose |
|---|---|
| `aws-migration/fnb-controller.db` | **Live production DB snapshot** (11 users, 1,639 requisitions, 935 materials — WAL checkpointed, integrity verified). This is your real data. |
| `deploy/aws/vm-setup.sh` | One-time EC2 bootstrap (Node 20, nginx, systemd, dirs) |
| `deploy/aws/push.sh` | Build-local → rsync → restart (run from your Mac) |
| `deploy/aws/fnb-controller.service` | systemd unit (loads `/etc/fnb-controller.env`) |
| `deploy/aws/nginx.conf` | Reverse proxy :80 → :3000 |
| `deploy/aws/backup-db.sh` | Daily SQLite → S3 backup (cron) |

## What YOU prepare (never commit / never share)

| Secret | How to get it |
|---|---|
| **Google service-account JSON key** | GCP Console → IAM → Service Accounts → create key (JSON). Enable **Google Sheets API**. **Share the AKAN sheet** with the SA's `client_email` as Viewer. |
| **EC2 SSH key** (`.pem`) | AWS downloads once when you create the instance |
| **S3 bucket name** | You create it (e.g. `akan-fnb-backups`) |
| (optional) `CRON_TOKEN` | Any random string — only if using the external cron route |

---

## 1. Provision EC2 (AWS Console)

- **Region**: `ap-south-1` (Mumbai) — low latency for India
- **Instance**: `t3.large` (or `t3.medium` to start), Ubuntu 22.04 LTS
- **Storage**: 30 GB gp3
- **Security Group**: allow `22` (SSH, your IP only), `80` + `443` (anywhere)
- **Elastic IP**: allocate one, attach to the instance (sticky public IP)
- **IAM role**: create a role with `s3:PutObject` + `s3:ListBucket` on your
  backup bucket, attach to the instance (so backups need no access keys)

## 2. Bootstrap the box (one-time)

```bash
# From your Mac:
scp -i ~/keys/akan.pem deploy/aws/vm-setup.sh ubuntu@<elastic-ip>:/tmp/
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip> "bash /tmp/vm-setup.sh"
```

This installs Node/nginx/systemd and writes a **placeholder** `/etc/fnb-controller.env`.

## 3. Upload your secrets (you do this — not in repo)

```bash
# Google service-account JSON key:
scp -i ~/keys/akan.pem ~/Downloads/akan-sheets-key.json \
    ubuntu@<elastic-ip>:/tmp/google-sa.json
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip> \
    "sudo mv /tmp/google-sa.json /etc/fnb-controller/google-sa.json && sudo chmod 600 /etc/fnb-controller/google-sa.json"

# Edit the env file with real values:
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip> "sudo nano /etc/fnb-controller.env"
```

Confirm `/etc/fnb-controller.env` has:
```
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
GOOGLE_APPLICATION_CREDENTIALS=/etc/fnb-controller/google-sa.json
ENABLE_SCHEDULER=1
```

## 4. Upload the production DB (your real data)

```bash
scp -i ~/keys/akan.pem aws-migration/fnb-controller.db \
    ubuntu@<elastic-ip>:/opt/fnb-controller/fnb-controller.db
```

## 5. First deploy (from your Mac)

```bash
EC2_HOST=ubuntu@<elastic-ip> EC2_KEY=~/keys/akan.pem bash deploy/aws/push.sh
```

This builds locally, rsyncs (the `--exclude fnb-controller.db` protects the DB
you just uploaded), installs deps, rebuilds `better-sqlite3` for the EC2 arch,
installs the systemd unit, and restarts.

## 6. Start + verify

```bash
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip> "sudo systemctl start fnb-controller"
# Probe:
curl http://<elastic-ip>/healthz          # → ok
curl -s -o /dev/null -w '%{http_code}\n' http://<elastic-ip>/   # → 307 (login redirect)
```

Open `http://<elastic-ip>` in a browser → log in with an existing account
(passwords carried over in the DB) → check `/party-events` Refresh populates
(confirms Google Sheets auth works on AWS).

## 7. Domain + HTTPS (Hostinger → AWS)

1. Hostinger DNS panel → **A record**: `@` and `www` → `<elastic-ip>`
2. Wait for propagation (5 min – 2 h). Test: `dig yourdomain.com +short`
3. Edit `server_name _;` → `server_name yourdomain.com www.yourdomain.com;`
   in `/etc/nginx/sites-available/fnb-controller`, then:
   ```bash
   sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
   ```
   certbot adds the :443 block + auto-renews every 90 days.

## 8. Daily backups

```bash
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip>
sudo crontab -e
# add:
0 2 * * * BUCKET=s3://akan-fnb-backups /opt/fnb-controller/deploy/aws/backup-db.sh >> /var/log/fnb-backup.log 2>&1
```

## 9. Cutover + decommission GCP

- Keep the GCP VM running 1–2 days as fallback.
- **Freeze writes on GCP during final DB copy** (or accept that any party
  requisitions made on GCP after step 4's snapshot won't be on AWS). If you
  need a zero-loss cutover: re-run the snapshot+upload (steps in §10) right
  before flipping DNS.
- Once AWS is confirmed good for 48h, stop/delete the GCP VM + disk + IP.

---

## 10. Re-sync the DB right before cutover (zero data loss)

If users kept working on GCP after your first snapshot, grab a final copy
just before DNS flips:

```bash
# Pull fresh from GCP (checkpoints WAL first):
gcloud compute ssh fnb-controller --zone=asia-south1-a --project=f-and-b-controller --tunnel-through-iap \
  --command="cd ~/fnb-controller && sqlite3 fnb-controller.db 'PRAGMA wal_checkpoint(TRUNCATE);' && sqlite3 fnb-controller.db \".backup /tmp/final.db\""
gcloud compute scp --zone=asia-south1-a --project=f-and-b-controller --tunnel-through-iap \
  fnb-controller:/tmp/final.db ./final.db

# Stop AWS app, swap DB, restart:
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip> "sudo systemctl stop fnb-controller"
scp -i ~/keys/akan.pem ./final.db ubuntu@<elastic-ip>:/opt/fnb-controller/fnb-controller.db
ssh -i ~/keys/akan.pem ubuntu@<elastic-ip> "rm -f /opt/fnb-controller/fnb-controller.db-shm /opt/fnb-controller/fnb-controller.db-wal; sudo systemctl start fnb-controller"
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/party-events` Refresh fails | Google JSON key missing / sheet not shared with SA email / Sheets API not enabled |
| `better-sqlite3` errors on start | `cd /opt/fnb-controller && npm rebuild better-sqlite3` (arch mismatch) |
| 502 from nginx | `sudo systemctl status fnb-controller` + `journalctl -u fnb-controller -n 50` |
| Everyone logged out after cutover | Expected once — cookie was bound to the old host. Re-login. |
| Wrong timestamps | App formats IST in-app; server TZ doesn't matter. No action. |

## Notes on what does NOT need migrating

- **Session secret**: none — tokens are random + stored in the DB.
- **Slack webhook**: lives in the DB `settings` table — migrates with the DB.
- **Spreadsheet ID**: hardcoded in source (`1VYpx…FbJI`) — already in the build.
- **Outlets / page-access / unit-audit locks / categories**: all in the DB.
