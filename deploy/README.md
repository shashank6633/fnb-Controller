# F&B Controller — Google Cloud Deployment (Testing)

End-to-end migration from your Mac to a Google Cloud Compute Engine VM.
Total time: ~45 minutes start to finish. Estimated cost: **~₹1,200-1,800/month**.

You have **₹15,000 credits** → roughly 8-12 months of free testing runway.

## Architecture

```
   ┌────────────────┐                ┌──────────────────────────────┐
   │  Browser / App │  HTTP :80      │   Compute Engine VM           │
   │  (anywhere)    │ ─────────────▶ │   asia-south1-a (Mumbai)      │
   └────────────────┘                │                               │
                                     │   nginx :80 → Next.js :3000   │
                                     │   ↓                           │
                                     │   fnb-controller.db (SQLite)  │
                                     └──────────────┬────────────────┘
                                                    │ daily 02:30 UTC
                                                    ▼
                                            gs://<project>-backups/daily/
                                            (60-day retention)
```

## Step-by-step

### 1. Install gcloud CLI on your Mac

```bash
brew install --cask google-cloud-sdk
gcloud init                       # walks you through auth + project selection
gcloud auth application-default login
```

### 2. Create or pick a project

If you don't have one:
```bash
gcloud projects create fnb-controller-test --name="F&B Controller (Test)"
```

Then **link a billing account** (required even on free tier — your ₹15k credit applies once linked):
- https://console.cloud.google.com/billing/linkedaccount?project=fnb-controller-test
- Pick "F&B Controller (Test)" → connect your billing account → done.

### 3. Run the bootstrap

```bash
cd ~/Desktop/Claude/fnb-controller
PROJECT_ID=fnb-controller-test bash deploy/gcp-bootstrap.sh
```

This creates:
- VM `fnb-controller` (e2-small, 2 vCPU / 2 GB RAM)
- Static IP (so the URL stays the same on reboot)
- Firewall ports 22 (SSH) + 80 (HTTP)
- Storage bucket for nightly backups (60-day retention)

It prints the public IP at the end — write it down.

### 4. Push your code + DB to the VM

```bash
bash deploy/push-code.sh
```

This rsyncs your repo (excluding `node_modules`, `.next`, `.git`) plus the live `fnb-controller.db` to `~/fnb-controller/` on the VM.

### 5. SSH in and run the setup

```bash
gcloud compute ssh fnb-controller --zone=asia-south1-a
# (now on the VM)
cd ~/fnb-controller
bash deploy/vm-setup.sh
```

This:
- Installs Node 22, build tools, nginx
- `npm install` + `npm run build`
- Drops the systemd unit so the app auto-starts on reboot
- Configures nginx (port 80 → Next.js port 3000)
- Smoke tests with `curl`

When it's done, open `http://<your-static-ip>` in any browser → you should see the login page.

### 6. (Optional) Enable nightly backups

Still SSH'd into the VM:
```bash
bash deploy/configure-backups.sh
```

Backups run at 02:30 UTC (08:00 IST), 60-day retention via Cloud Storage lifecycle rule.

### 7. Set a budget alert (one-time, in the GCP Console)

- https://console.cloud.google.com/billing/budgets
- "Create Budget" → Project: `fnb-controller-test` → Amount: **₹10,000/month**
- Alerts at 50%, 90%, 100% → notify your email
- This gives you ₹5,000 buffer below your ₹15k cap.

---

## Day-to-day operations

### Check service status
```bash
gcloud compute ssh fnb-controller --zone=asia-south1-a -- sudo systemctl status fnb-controller
```

### Tail logs
```bash
gcloud compute ssh fnb-controller --zone=asia-south1-a -- sudo journalctl -u fnb-controller -f
```

### Restart the app
```bash
gcloud compute ssh fnb-controller --zone=asia-south1-a -- sudo systemctl restart fnb-controller
```

### Push a code update
On your Mac:
```bash
bash deploy/push-code.sh
gcloud compute ssh fnb-controller --zone=asia-south1-a -- "cd ~/fnb-controller && npm install && npm run build && sudo systemctl restart fnb-controller"
```

### Pull the live DB to your Mac for inspection
```bash
gcloud compute scp fnb-controller:~/fnb-controller/fnb-controller.db ./testing-snapshot.db --zone=asia-south1-a
sqlite3 testing-snapshot.db "SELECT COUNT(*) FROM sales;"
```

### Restore a backup
```bash
# On the VM
gcloud storage cp gs://fnb-controller-test-backups/daily/backup-2026-05-13T02-30-00Z.sql.gz - | \
  gunzip | sudo systemctl stop fnb-controller && sqlite3 ~/fnb-controller/fnb-controller.db && \
  sudo systemctl start fnb-controller
```

### Stop the VM (billing stops, IP stays)
```bash
gcloud compute instances stop fnb-controller --zone=asia-south1-a
```

### Start it back up
```bash
gcloud compute instances start fnb-controller --zone=asia-south1-a
```

---

## Cost breakdown (monthly, asia-south1)

| Item | Spec | Approx ₹/month |
|---|---|---|
| Compute VM | e2-small (2 vCPU · 2 GB RAM, 24×7) | ₹1,200 |
| Disk | 20 GB pd-balanced | ₹140 |
| Static IP | While VM is running | Free |
| Static IP | While VM is stopped | ₹250 |
| Storage backups | ~30 daily × 5 MB compressed = 150 MB | ₹2 |
| Egress | Light test traffic | ₹50 |
| **Total** | | **~₹1,640/month** |

With ₹15k credits → ~9 months of testing without paying out of pocket.

To cut cost when not actively testing: `gcloud compute instances stop fnb-controller --zone=asia-south1-a` saves ~75% (you only pay for disk + reserved IP).

---

## Troubleshooting

### "Service is up but not responding on port 3000"
```bash
sudo journalctl -u fnb-controller --since '5 minutes ago'
```
Look for `EADDRINUSE` (port conflict) or `Cannot find module` (missing dep). Fix:
```bash
cd ~/fnb-controller && npm install && sudo systemctl restart fnb-controller
```

### "better-sqlite3 binary not found"
```bash
cd ~/fnb-controller && npm rebuild better-sqlite3 && sudo systemctl restart fnb-controller
```

### Out of memory
The 2 GB e2-small can struggle during `npm run build`. Workarounds:
- Run build on your Mac, scp the `.next/` folder
- OR upgrade to e2-medium (4 GB, ~₹2,400/mo)

### Can't reach the URL
- Firewall: `gcloud compute firewall-rules list` → confirm `fnb-controller-allow-http` exists.
- Check the IP: `gcloud compute addresses describe fnb-controller-ip --region=asia-south1`
- Test from a different network (your office wifi might be blocking outbound 80).
