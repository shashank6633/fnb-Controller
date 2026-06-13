# CI/CD Pipeline — GitHub Actions

Automated build + deploy for the two-environment setup.

| Workflow | Trigger | Target | Gate |
|---|---|---|---|
| **CI** (`ci.yml`) | every push + PR | — (build + typecheck only) | none |
| **Deploy → Testing** (`deploy-testing.yml`) | push to `main` | GCP `34.14.181.77` | none (auto) |
| **Deploy → Production** (`deploy-production.yml`) | manual button / `v*` tag | AWS `fnb.akanhyd.com` | **required reviewer** |

## The flow

```
push to main
   │
   ├─► CI runs (typecheck + build)            ← blocks merge if it fails
   │
   └─► Deploy→Testing runs automatically       ← GCP updated, verify on 34.14.181.77
                                                  │
   you verify on testing, then ……………………………………┘
   │
   └─► Actions tab → "Deploy → Production" → Run workflow → type "deploy"
          │
          └─► waits for APPROVAL (required reviewer clicks Approve)
                 │
                 └─► backs up prod DB → builds → ships to AWS → health-check
```

Production NEVER deploys without (a) you triggering it and (b) a reviewer approving.

---

## One-time setup

### 1. Push the repo to GitHub (if not already)
```bash
gh repo create fnb-controller --private --source=. --remote=origin --push
# or: git push -u origin main
```

### 2. Add GitHub Secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**.
(You enter the values — they're encrypted, never visible to anyone including me.)

| Secret | Value |
|---|---|
| `PROD_SSH_HOST` | AWS Elastic IP (e.g. `13.234.x.x`) |
| `PROD_SSH_USER` | `ubuntu` |
| `PROD_SSH_KEY` | **full contents** of your `akan.pem` (paste the whole `-----BEGIN…END-----`) |
| `PROD_APP_DIR` | `/opt/fnb-controller` |
| `PROD_BACKUP_BUCKET` | `s3://akan-fnb-backups` (or leave blank to skip S3 backup) |
| `TESTING_SSH_HOST` | `34.14.181.77` |
| `TESTING_SSH_USER` | your GCP SSH username |
| `TESTING_SSH_KEY` | private key authorized on the GCP VM |
| `TESTING_APP_DIR` | the app path on GCP (e.g. `/home/<user>/fnb-controller`) |

### 3. Create the GitHub Environments (this is the approval gate)
Repo → **Settings → Environments**:

- **`testing`** — create it, no protection rules (auto-deploys).
- **`production`** — create it, then under **Deployment protection rules**:
  - ✅ **Required reviewers** → add yourself (and anyone else who can approve)
  - (optional) **Wait timer** → e.g. 0–5 min
  - (optional) **Deployment branches** → restrict to `main` + tags

Now any production deploy pauses for an Approve click in the Actions UI.

### 4. SSH access for the runners

GitHub-hosted runners have **dynamic IPs**, so the VMs must accept SSH from anywhere on port 22 (key-only — never password). Two notes:

- **AWS**: Security Group → allow TCP 22 from `0.0.0.0/0` (key auth only). The
  `PROD_SSH_KEY` is your existing `.pem`. Done.
- **GCP testing**: the box currently uses IAP-tunnel SSH. For CI direct-SSH:
  - Easiest: add the `TESTING_SSH_KEY` public half to the VM's
    `~/.ssh/authorized_keys`, and open firewall port 22. If the VM has
    **OS Login** enabled, either disable it on this VM or register the key via
    `gcloud compute os-login ssh-keys add`.
  - Alternative: keep testing deploys MANUAL (`bash deploy/ship.sh testing`
    from your Mac) and only automate production. Perfectly valid — testing in
    CI is optional; the production gate is the part that matters.

---

## Daily use

| Want to… | Do this |
|---|---|
| Ship a change to testing | `git push` to `main` → auto-deploys to GCP |
| Verify | open http://34.14.181.77 |
| Release to production | Actions tab → **Deploy → Production** → Run workflow → type `deploy` → **Approve** |
| Release via tag | `git tag v1.5.0 && git push --tags` → still needs the approval click |
| Roll back | re-run an older successful production deploy from the Actions history, or `git revert` + redeploy |

---

## Safety properties

- **DB is never touched** — `fnb-controller.db*` excluded from every rsync.
  Each environment keeps its own data.
- **Secrets stay out of CI artifacts** — Google SA JSON + `/etc/fnb-controller.env`
  live only on the VMs; CI only holds SSH keys (encrypted GitHub Secrets).
- **Production needs human approval** — the `production` Environment's required
  reviewer gate blocks unattended releases.
- **Pre-deploy backup** — production deploy snapshots the SQLite DB (and pushes
  to S3 if `PROD_BACKUP_BUCKET` is set) before swapping code.
- **Native module rebuild** — `npm rebuild better-sqlite3` runs on each VM so
  the SQLite binary matches the VM arch.
- **Health probe** — each deploy curls `/api/build-info` and fails the job if
  the service didn't come back up.

---

## Why build on the runner (not the VM)?

The GCP testing box is a 2 GB e2-small that OOMs running `next build`. The
GitHub runner has 7 GB + 2 vCPU, builds in ~30 s, then ships the prebuilt
`.next`. Same model as the manual `deploy/ship.sh` scripts — just automated.
