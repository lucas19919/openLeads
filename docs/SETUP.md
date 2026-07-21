# Setup

Get a local OpenLeads instance running on your machine.

---

## Prerequisites

- **Node 22.5+** (built-in `node:sqlite`). Node 24 is a good default.
- `npm` (ships with Node)
- Optional: [Ollama](https://ollama.com) if you want the Chat copilot with a local model

Check:

```bash
node --version
```

---

## 1. API

```bash
cd api
npm install
cp .env.example .env
```

Edit `api/.env` and set a real **`SETTINGS_KEY`**:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

In development the app *can* boot without it (with a warning). In production it fails closed — you cannot save AI/SMTP credentials without a key. Generate it now and keep the same `.env` when you deploy later.

Create your login (there is no public signup):

```bash
npm run seed -- admin "your-strong-password"
```

Re-running with the same username updates the password.

Start:

```bash
npm run dev
# → http://127.0.0.1:8787
```

You will see an `ExperimentalWarning` about SQLite. That is normal.

---

## 2. Web

```bash
cd ../web
npm install
npm run dev
# → http://localhost:5173
```

Vite proxies `/api` to the API so cookies stay same-origin. No web `.env` is required in development.

Open the app and sign in with the user you seeded.

![](images/login.png)

---

## 3. Local AI (optional)

Chat needs an OpenAI-compatible endpoint. Defaults target **local Ollama**:

| Variable | Default |
|----------|---------|
| `AI_BASE_URL` | `http://localhost:11434/v1` |
| `AI_MODEL` | `llama3.1:8b` |

```bash
ollama pull llama3.1:8b
```

Leave the defaults alone if Ollama is on the same machine. Prefer a hosted endpoint? Set `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY` in `.env`, or configure them under **Einstellungen** (secrets are encrypted with `SETTINGS_KEY`).

Without AI, the rest of the suite still works — only Chat stays quiet.

---

## Environment reference

| Variable | Purpose |
|----------|---------|
| `SETTINGS_KEY` | AES-256-GCM key for Settings-stored credentials |
| `DB_PATH` | SQLite file (default `./data/leads.db`) |
| `WEB_ORIGIN` | Allowed origin for CORS + CSRF (`http://localhost:5173` in dev) |
| `TRUST_PROXY` | `1` only behind *your* reverse proxy |
| `NODE_ENV` | `development` or `production` |
| `AI_*` | Model endpoint (overridable in UI) |
| `SMTP_*` | Mail (overridable in UI; optional) |

Full comments live in `api/.env.example`.

---

## Common pitfalls

- **Node too old** → `node:sqlite` fails to load. Upgrade past 22.5.
- **Edited `.env.example` instead of `.env`** → the app only reads `.env`.
- **Treating the SQLite warning as a crash** → it isn’t.
- **Chat does nothing** → no model endpoint reachable; everything else is fine.
- **Can’t save AI/SMTP in production** → missing `SETTINGS_KEY`.

---

## Production

Don’t improvise a custom stack on day one. OpenLeads ships one Docker image and a compose file:

→ **[../deploy/DEPLOY.md](../deploy/DEPLOY.md)**

That walkthrough covers secrets, nginx + TLS, seeding the login in-container, backups, and restore.
