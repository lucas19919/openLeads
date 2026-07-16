---
name: setup-openleads
description: >-
  Sets up a working OpenLeads instance from a fresh clone — installs the api/
  and web/ workspaces, creates api/.env with a freshly generated SETTINGS_KEY,
  seeds a login, optionally wires up local Ollama AI, then starts and verifies
  the dev servers. Use this whenever someone wants to set up, install,
  bootstrap, configure, get started with, onboard onto, or "run OpenLeads for
  the first time" — including vague asks like "how do I run this?", "get this
  working", "set it up", or "I just cloned this, now what?" while in the
  OpenLeads repo. Also the entry point for production deployment, which it
  routes to deploy/DEPLOY.md.
---

# Set up OpenLeads

Drive a first-time OpenLeads setup end to end: dependencies → secrets → login →
running, verified servers. OpenLeads is a two-workspace monorepo — `api/`
(Hono + `node:sqlite`) and `web/` (React + Vite) — so "setup" means getting the
pieces installed, configured, and talking to each other, not just one
`npm install`.

The canonical instructions live in the repo and may drift ahead of this skill.
**Read these first and treat them as the source of truth** if they disagree with
anything below:

- `README.md` → "Quick start (development)" and "Configuration"
- `api/.env.example` → the authoritative env var list
- `deploy/DEPLOY.md` → production (Docker Compose + nginx)

## Step 0 — Decide scope and gather inputs

Ask the user only what you can't infer, then proceed. Don't over-interview.

1. **Dev or production?** Default to **local development** (the flow below). If
   they want a real server / public URL / Docker, skip to
   [Production](#production) — that path is documented, not re-implemented here.
2. **Login credentials** — you need a username and password to seed the first
   user. If they don't offer one, suggest `admin` and generate a strong password
   (and show it to them so they can save it).
3. **Local AI (chat copilot)?** Optional. The Chat module needs an
   OpenAI-compatible endpoint; the default targets a **local Ollama**. Skip if
   they don't want it — the rest of the app still runs, only Chat is inert.

Detect the OS yourself (you're running in their shell) and use the matching
commands — PowerShell on Windows, bash/zsh on macOS/Linux. Don't assume.

## Step 1 — Check prerequisites

OpenLeads uses Node's built-in SQLite, which needs a recent Node:

- **Node 22.5+ is required** (`node:sqlite`); Node 24 is recommended. Run
  `node --version` and stop here with a clear message if it's older — nothing
  downstream will work.
- `npm` ships with Node.
- Ollama is only needed if they chose local AI (Step 4).

## Step 2 — API (`api/`)

This is the core: it owns the database, auth, and serves the app in production.

```
cd api
npm install
```

Then create `api/.env`. **Do not clobber an existing `.env`** — if one is
already there, read it and only fill missing secrets; otherwise start from the
example:

1. Read `api/.env.example` to get the current, authoritative set of variables.
2. Generate one secret (see [Generating secrets](#generating-secrets)):
   - `SETTINGS_KEY` — AES-256-GCM key for credentials saved via the Settings UI
3. Write `api/.env` from the example with that placeholder replaced. Leave
   `NODE_ENV=development`, `DB_PATH`, ports, and the AI/SMTP block at their
   example defaults unless the user asked otherwise.

> **Why generate it even in dev?** In development the app falls back to an
> insecure built-in default (with a warning), so it *would* boot without it. But
> it **fails closed in production** — `api/src/secrets.ts` refuses to encrypt
> credentials without a real `SETTINGS_KEY`. Generating it now means the same
> `.env` works when they later flip to production. (Sessions are stored
> server-side in the DB — there is no session secret anymore.)

**Seed the login** (creates the first user; the app has no signup):

```
npm run seed -- <username> "<password>"
```

Quote the password so shell metacharacters don't break it. Re-running with an
existing username just updates that password.

## Step 3 — Web (`web/`)

```
cd ../web
npm install
```

No env file needed in dev — Vite serves on **http://localhost:5173** and proxies
`/api` to the API on `127.0.0.1:8787`, so cookies stay same-origin (see
`web/vite.config.ts`). (If `README.md` quotes a different port, trust the actual
`vite.config.ts`.)

## Step 4 — Local AI / Ollama (optional)

Only if the user wants the Chat copilot. The API defaults
(`AI_BASE_URL=http://localhost:11434/v1`, `AI_MODEL=llama3.1:8b`) target a local
Ollama, so no `api/.env` change is needed — just make the models available:

1. Install Ollama (https://ollama.com) if `ollama --version` fails.
2. Pull the chat model named in `api/.env.example`:
   ```
   ollama pull llama3.1:8b
   ```

If they'd rather use a hosted OpenAI-compatible endpoint, set `AI_BASE_URL`,
`AI_MODEL`, and `AI_API_KEY` in `api/.env` instead (or configure it later in the
Settings page, which encrypts the key at rest with `SETTINGS_KEY`).

## Step 5 — Start and verify

Start both dev servers (run them in the background / separate processes so they
keep running):

```
# from api/
npm run dev      # → http://127.0.0.1:8787
# from web/
npm run dev      # → http://localhost:5173
```

Then **verify rather than assuming** — don't just report "done":

- Confirm the API process is up and listening on 8787 (and didn't crash on
  boot). On startup you'll see a `node:sqlite` `ExperimentalWarning` — that is
  **expected and harmless**, not an error.
- Confirm Vite is serving on 5173.
- Tell the user to open **http://localhost:5173** and log in with the credentials
  from Step 2. The UI is in German (it targets the DACH market) — mention that so
  they're not surprised. A fresh database starts with a starter
  Leistungskatalog (website packages, hosting/Pflege, SEO) prefilled.

Report exactly what came up and what's still optional/disabled (e.g. "Chat is
inactive until you finish Step 4").

## Production

Don't hand-roll this — OpenLeads ships one Docker image (web + API) and
`deploy/DEPLOY.md` is the maintained walkthrough (Docker Compose, nginx + TLS,
secrets via `api.env`, seeding the login in-container, backups). Read it and
follow it, adapting the domain and secrets to the user's host. The same secret
rules apply, plus `WEB_ORIGIN` must be the public origin and
`NODE_ENV=production` (which makes the secret checks fail-closed — so
`SETTINGS_KEY` is then mandatory, not optional).

## Generating secrets

A secret is a long random string. Cross-platform:

**Node (works everywhere Node is installed — the safe default here):**
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**macOS / Linux:** `openssl rand -hex 32`

Never reuse the example's `change-me-...` placeholder.

## Common pitfalls

- **Node too old** → `node:sqlite` import fails. Needs 22.5+.
- **Editing `.env.example` instead of `.env`** → app reads `.env`; the example is
  only a template. Never commit `.env`.
- **Treating the `ExperimentalWarning` as a failure** → it's normal.
- **Expecting Chat to work without an AI endpoint** → it's inert until Ollama (or
  a hosted endpoint) is reachable; the rest of the app is unaffected.
- **Saving AI/SMTP credentials fails in production** → that's the fail-closed
  check; set a real `SETTINGS_KEY`, don't downgrade `NODE_ENV`.
