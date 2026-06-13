# Two-Environment Workflow — Testing (GCP) → Production (AWS)

| Environment | Where | URL | Google auth |
|---|---|---|---|
| **Testing** | GCP VM `34.14.181.77` | http://34.14.181.77 | Metadata server (auto) |
| **Production** | AWS EC2 | https://fnb.akanhyd.com | Service-account JSON key |

GitHub is the source of truth. You make changes, **test on GCP first**, then
ship the *same* code to AWS production.

---

## The promote flow (every change)

```
1. Make code changes (locally)
2. bash deploy/ship.sh testing        # → GCP, verify on 34.14.181.77
3. … click through the changed pages on http://34.14.181.77 …
4. git add -A && git commit -m "..."   # version-control once happy
5. bash deploy/ship.sh production      # → AWS, verify on fnb.akanhyd.com
```

**Golden rule:** never `ship.sh production` without first verifying on testing.
The wrapper even asks "did you verify on testing?" before pushing to prod.

### One command per environment

```bash
bash deploy/ship.sh testing      # GCP  (IAP tunnel, no key needed)
bash deploy/ship.sh production   # AWS  (SSH, needs your .pem)
```

For production, set your AWS access once (so you don't retype it):

```bash
# In ~/.zshrc (kept on your Mac, never shared):
export EC2_HOST="ubuntu@<your-elastic-ip>"
export EC2_KEY="$HOME/keys/akan.pem"
```

Then `bash deploy/ship.sh production` just works.

---

## Database — testing and production are SEPARATE

Each box has its own SQLite file. They do **not** sync.

- **Testing (GCP)** keeps its own data — safe to experiment, seed, break.
- **Production (AWS)** holds the real live data.

Code promotes test→prod; **data does not**. If you need a fresh copy of
production data on testing (to debug with real data), pull prod down:

```bash
# Snapshot AWS prod DB → use on GCP testing (read-only debugging):
scp -i ~/keys/akan.pem ubuntu@<aws-ip>:/opt/fnb-controller/fnb-controller.db ./prod-snapshot.db
# (then upload to the GCP box if you want to debug against it)
```

Never copy testing data INTO production — you'd overwrite real records.

---

## Fixing Google Sheets auth on PRODUCTION (AWS)

AWS has no GCP metadata server, so the app needs a **service-account JSON key**.
Do this once on the AWS box.

### Step 1 — Create the JSON key (Google Cloud Console)
1. **APIs & Services → Library →** enable **Google Sheets API**
2. **IAM & Admin → Service Accounts →** pick (or create) a service account
3. **Keys → Add key → Create new key → JSON →** downloads `xxxx.json`
4. Open the JSON, note the `"client_email"` — e.g.
   `akan-sheets@your-project.iam.gserviceaccount.com`

### Step 2 — Share the sheet with that email
- Open the **AKAN Party Manager** Google Sheet → **Share**
- Add the `client_email` from step 1 → **Viewer** → Send

### Step 3 — Put the key on the AWS box
```bash
scp -i ~/keys/akan.pem ~/Downloads/xxxx.json ubuntu@<aws-ip>:/tmp/google-sa.json
ssh -i ~/keys/akan.pem ubuntu@<aws-ip> \
  "sudo mkdir -p /etc/fnb-controller && sudo mv /tmp/google-sa.json /etc/fnb-controller/google-sa.json && sudo chmod 600 /etc/fnb-controller/google-sa.json"
```

### Step 4 — Point the env file at it
```bash
ssh -i ~/keys/akan.pem ubuntu@<aws-ip> "sudo nano /etc/fnb-controller.env"
# ensure this line exists:
#   GOOGLE_APPLICATION_CREDENTIALS=/etc/fnb-controller/google-sa.json
ssh -i ~/keys/akan.pem ubuntu@<aws-ip> "sudo systemctl restart fnb-controller"
```

### Step 5 — Verify
Open https://fnb.akanhyd.com/party-events → click Refresh.
If it still fails, the error now shows the **exact** service-account email the
server is using — share the sheet with *that* email (catches typos / wrong SA).

---

## Quick reference

| Task | Command |
|---|---|
| Deploy to testing | `bash deploy/ship.sh testing` |
| Deploy to production | `bash deploy/ship.sh production` |
| Tail prod logs | `ssh -i ~/keys/akan.pem ubuntu@<ip> "sudo journalctl -u fnb-controller -n 50 -f"` |
| Tail testing logs | `gcloud compute ssh fnb-controller --zone=asia-south1-a --tunnel-through-iap --command="sudo journalctl -u fnb-controller -n 50 -f"` |
| Prod DB backup | `ssh -i ~/keys/akan.pem ubuntu@<ip> "BUCKET=s3://akan-fnb-backups /opt/fnb-controller/deploy/aws/backup-db.sh"` |
| Restart prod | `ssh -i ~/keys/akan.pem ubuntu@<ip> "sudo systemctl restart fnb-controller"` |
