#!/usr/bin/env bash
# Provision the server and (re)start OpenLeads. Run by the deploy workflow over
# SSH, with these env vars set by the workflow:
#   IMAGE              e.g. ghcr.io/OWNER/openleads
#   GHCR_USER          the GitHub actor (for `docker login`)
#   GHCR_TOKEN         the workflow's GITHUB_TOKEN (ephemeral, masked in logs)
set -euo pipefail

cd /opt/openleads

# 1. Install Docker (+ compose plugin) if it isn't already present.
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi

# 2. Secrets. api.env is generated once and then left alone, so SETTINGS_KEY
#    stays stable across deploys (encrypted settings stay readable).
if [ ! -f api.env ]; then
  printf 'SETTINGS_KEY=%s\nWEB_ORIGIN=https://crm.example.com\n' \
    "$(openssl rand -hex 32)" > api.env
  chmod 600 api.env
  echo "==> Generated api.env"
fi

# 3. Pull the freshly-built image (auth with the ephemeral workflow token) and start.
echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
export OPENLEADS_IMAGE="${IMAGE}:latest"
docker compose pull api
docker compose up -d api
docker logout ghcr.io >/dev/null 2>&1 || true
docker image prune -f >/dev/null 2>&1 || true

echo "==> OpenLeads api is up on 127.0.0.1:8787"
