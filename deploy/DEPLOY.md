# Deploying OpenLeads (Docker Compose + nginx)

OpenLeads ships as **one Docker image** that holds the built web app, the API
that serves it, and the scraper. The simplest production setup is Docker Compose
on a small VPS behind nginx (TLS). The SQLite DB lives in a named volume so it
survives image rebuilds.

```
 host nginx (TLS) ── crm.example.com ──▶ 127.0.0.1:8787  api container
                                              │ docker network
 host cron ─▶ docker compose --profile tools run --rm scraper ─▶ http://api:8787
```

## 1. Get the code + build the image

```bash
git clone https://github.com/<you>/openleads.git /opt/openleads
cd /opt/openleads
docker compose build         # builds the bundled Dockerfile → openleads:latest
```

(Or push the image to a registry and set `OPENLEADS_IMAGE=...` instead of building.)

## 2. Secrets

Create `api.env` and `scraper.env` next to `docker-compose.yml`:

```bash
# api.env
SESSION_SECRET=$(openssl rand -hex 32)
SERVICE_TOKEN=$(openssl rand -hex 24)
WEB_ORIGIN=https://crm.example.com
```

```bash
# scraper.env
ANTHROPIC_API_KEY=sk-ant-...
CRM_SERVICE_TOKEN=<same value as SERVICE_TOKEN above>
# MIN_SCORE=40   # optional; the Scraper tab can override this
```

## 3. Start it

```bash
docker compose up -d api
```

The API is published on `127.0.0.1:8787` only — host nginx terminates TLS for
the public subdomain.

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

Open `https://crm.example.com` and log in.

## 6. Schedule the scraper (daily)

Add a host cron entry:

```cron
# /etc/cron.d/openleads-scraper  — every day at 06:30
30 6 * * * root cd /opt/openleads && docker compose --profile tools run --rm scraper >> /var/log/openleads-scraper.log 2>&1
```

The scraper reads its search raster / limits from the **Scraper** tab in the app
(falling back to built-in defaults).

## Day-to-day

- **Update:** `git pull && docker compose build && docker compose up -d api`
- **Logs:** `docker compose logs -f api`
- **Import an xlsx:**
  ```bash
  docker compose run --rm -v /path/leads.xlsx:/tmp/leads.xlsx \
    -e CRM_API_URL=http://api:8787 api npm run import -- /tmp/leads.xlsx
  ```
- **Backup the DB** (one file in the named volume):
  ```bash
  docker run --rm -v openleads_crm-data:/data -v "$PWD":/out alpine \
    sh -c 'cp /data/leads.db /out/leads-$(date +%F).db'
  ```

## CI/CD (optional)

[`bootstrap.sh`](bootstrap.sh) is an example provisioning script (install Docker,
write env, `compose up`) you can drive from a GitHub Action over SSH if you want
push-to-deploy. It's not required for the manual flow above.
