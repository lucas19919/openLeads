# syntax=docker/dockerfile:1
# One image holds the built internal web app and the API that serves it.

# ---- Stage 1: build the internal web app (Vite) ----
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- Stage 2: runtime ----
# Node 24 so the built-in node:sqlite needs no flag. tsx runs the TS directly.
FROM node:24-alpine AS runtime
WORKDIR /app

# Install deps (cached unless the lockfile changes).
COPY api/package.json api/package-lock.json ./api/
RUN cd api && npm ci

# App source.
COPY api/ ./api/

# Built web app, served by the API in production.
COPY --from=web /web/dist ./web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/leads.db \
    WEB_DIST=/app/web/dist

WORKDIR /app/api
EXPOSE 8787
# Liveness: the API exposes an unauthenticated /api/health.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
