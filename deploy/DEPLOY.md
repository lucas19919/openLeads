# Deploying OpenLeads (Docker Compose + nginx)

OpenLeads ships as **one Docker image** that holds the built web app and the API
that serves it. The simplest production setup is Docker Compose on a small VPS
behind nginx (TLS). The SQLite DB lives in a named volume so it survives image
rebuilds.

```
 host nginx (TLS) ── crm.example.com ──▶ 127.0.0.1:8787  api container
```

## 1. Get the code + build the image

```bash
git clone https://github.com/<you>/openleads.git /opt/openleads
cd /opt/openleads
docker compose build         # builds the bundled Dockerfile → openleads:latest
```

(Or push the image to a registry and set `OPENLEADS_IMAGE=...` instead of building.)

## 2. Secrets

Create `api.env` next to `docker-compose.yml`:

```bash
# api.env
SETTINGS_KEY=$(openssl rand -hex 32)
WEB_ORIGIN=https://crm.example.com
```

`SETTINGS_KEY` encrypts the credentials you save in the Settings UI (AI API key,
SMTP password) — generate it once and never rotate it casually, or those stored
secrets become unreadable. Sessions live server-side in the DB, so no session
secret is needed.

## 3. Start it

```bash
docker compose up -d api
```

The API is published on `127.0.0.1:8787` only — host nginx terminates TLS for
the public subdomain. The compose file sets `TRUST_PROXY=1` so the API takes the
client IP from `X-Forwarded-For` (which nginx sets) for rate limiting and the
audit trail.

## 4. nginx vhost + TLS

```bash
sudo tee /etc/nginx/sites-available/crm.example.com >/dev/null <<'EOF'
server {
    listen 80;
    server_name crm.example.com;
    add_header X-Robots-Tag "noindex, nofollow" always;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/crm.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d crm.example.com
```

A ready-made vhost is in [`nginx-crm.conf`](nginx-crm.conf).

## 5. Create your login

```bash
docker compose run --rm api npm run seed -- <your-username> '<your-password>'
```

Open `https://crm.example.com` and log in. A fresh database starts with a
starter Leistungskatalog (website packages, hosting/Pflege, SEO) prefilled
— edit prices and items under **Einstellungen**.

## Day-to-day

- **Update:** `git pull && docker compose build && docker compose up -d api`
- **Logs:** `docker compose logs -f api`
- **Import an xlsx** (writes straight into the DB volume):
  ```bash
  docker compose run --rm -v /path/leads.xlsx:/tmp/leads.xlsx \
    api npm run import -- /tmp/leads.xlsx
  ```
- **Backup the DB** — a consistent, WAL-safe snapshot (`VACUUM INTO`), written to
  `./backups/` on the host. A bare `cp` of `leads.db` can miss un-checkpointed
  WAL, so prefer this (or the **Settings → "Backup herunterladen (.db)"** button,
  which downloads the same snapshot):
  ```bash
  docker compose run --rm -e BACKUP_DIR=/out -v "$PWD/backups":/out api npm run backup
  ```

- **Restore a backup** — replace the live DB with a snapshot. Stop the API first
  so nothing has the file open mid-swap; the current DB is snapshotted to
  `pre-restore-<ts>.db` in the volume before the swap, so this is reversible:
  ```bash
  docker compose stop api
  docker compose run --rm -v "$PWD/openleads-backup-XXXX.db":/in/backup.db \
    api npm run restore -- /in/backup.db
  docker compose up -d api
  ```
  `npm run restore` validates the file (integrity check + expected tables) and
  drops the stale `-wal`/`-shm` before starting, refusing to run if a write is
  in flight. There is no in-app DB upload by design: swapping the whole database
  is an operator/volume action, not a web request.

## CI/CD (optional)

[`bootstrap.sh`](bootstrap.sh) is an example provisioning script (install Docker,
write env, `compose up`) you can drive from a GitHub Action over SSH if you want
push-to-deploy. It's not required for the manual flow above.
