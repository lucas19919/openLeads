# OpenLeads · isarwebsites

The internal sales and billing suite of **isarwebsites** — a web agency selling
websites, hosting/Pflege and local online marketing to small businesses. It is
self-hosted, covers the whole path from a prospect with an outdated website to a
proper German invoice, and the AI can actually drive it — read and update the
pipeline, draft outreach, turn a sentence into an invoice — rather than sitting
in a chat box off to the side.

It runs on open models you host yourself (a local Ollama by default), so
customer data doesn't leave your machine.

The modules, behind one login:

- **Übersicht** — a dashboard of live KPIs: open and overdue amounts, paid
  totals, a 12-month revenue chart, the pipeline by stage and lead conversion,
  active contracts and their value, and a reminder list of contracts whose term
  ends within 60 days.
- **Chat (KI)** — a copilot that operates the rest of the suite through the same
  audited tools the UI uses: qualify leads, move pipeline stages, draft
  outreach, build invoices, manage the service catalog and customer registry,
  and draft/finalise contracts — all in German, tuned to the isarwebsites
  offering (Website-Pakete, Relaunch, Hosting & Pflege, SEO). Point it at a URL
  and it reads the site and creates a qualified lead.
- **Leads** — the CRM pipeline (kanban + table, stages, tags, notes), built for
  website prospects: each lead carries the state of their current site
  (mobile-friendly?, tech, staleness signal, score). Leads come in by `.xlsx`
  import, manual entry, or the Chat; dedupe is by domain.
- **Rechnungen** — Angebote and Rechnungen with line items and a print-ready
  PDF. A finalised invoice is a ZUGFeRD / Factur-X e-invoice (PDF/A-3 with
  embedded EN 16931 XML), Kleinunternehmer (§19 UStG) aware, with gapless
  numbering and a built-in EN 16931 validator. Record payments (partial
  supported); upload the signed/final copy to keep it with the record.
- **Abo-Rechnungen** — recurring invoices for Hosting- und Wartungsverträge: a
  template + cadence (monthly / quarterly / yearly) produces a draft Rechnung
  each period for you to review and finalise. Nothing is auto-sent.
- **Verträge** — contracts (Dienst-, Werk-, Wartungsvertrag,
  Auftragsbestätigung, Rahmenvertrag, AVV …) with parties, scope, remuneration,
  term and notice. Your AGB are *frozen onto* a contract when it's finalised.
  Gapless numbering, a print-ready multi-page PDF with signature block, e-mail
  to the client for signature, and an acceptance record. The countersigned copy
  can be uploaded and stored with the contract.
- **Ausgaben** — the cost side: record a receipt (Beleg) with vendor, category,
  date and gross amount; net + Vorsteuer are split out for you. Receipt scans
  are stored with the booking, German expense categories carry SKR03 accounts,
  and there's a journal + DATEV expense export for the Steuerberater. Plus
  laufende Abos (your own SaaS/hosting costs) with renewal reminders.
- **Einstellungen** (admin) — business profile, numbering, AGB, the
  **Leistungskatalog** (a fresh install is prefilled with the isarwebsites
  packages: Website Starter/Business/Premium, Relaunch, Hosting & Pflege, SEO,
  Google Business Profil, …), customer registry, users, AI + SMTP connections,
  Steuerberater exports, backup/restore and the DSGVO toolkit.

The UI is German and the invoicing follows German tax rules (§19 UStG,
ZUGFeRD). On the compliance side: it's self-hosted, AI inference can stay
local, there's an append-only audit log, one-click data export (Art. 15/20) and
erasure (Art. 17), a consent ledger, and an Art. 30 processing record. The AI
never sends anything on its own — a human approves every outgoing message.
More detail in [`docs/AI.md`](docs/AI.md) and
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md).

## Stack

Deliberately dependency-light: Node's built-in SQLite (no native build step), a
small Hono API, a Vite/React app, and pure-JS PDF generation.

| Part    | Tech                                                              |
|---------|-------------------------------------------------------------------|
| `api/`  | [Hono](https://hono.dev) + Node built-in SQLite (`node:sqlite`)   |
| `web/`  | React 19 + Vite (vanilla CSS)                                     |
| AI core | OpenAI-compatible (`fetch`) → Ollama / vLLM, open models, on-prem |
| PDF     | `pdfkit` → PDF/A-3 + Factur-X (no native deps)                    |
| Auth    | scrypt password hash + server-side DB sessions (no deps)          |

### API layout

```
api/src/
  index.ts        # composition root: middleware, routes, static, scheduler
  routes/         # one HTTP module per domain (leads, documents, contracts, …)
  ai/             # provider, agent loop, tools, prompts (isarwebsites voice)
  <domain>.ts     # domain logic + SQL, one module per table-ish concern
  <domain>.test.ts
```

Security posture: server-side sessions (revocable — logout and password resets
kill sessions immediately; only token hashes are stored), CSRF origin checks on
every mutating request, hardening headers + CSP, request-size limits,
login/AI rate limiting, secrets encrypted at rest (AES-256-GCM under
`SETTINGS_KEY`), settings/user/backup admin-gated, and an append-only audit
trail with source IPs on logins.

## Quick start (development)

Needs Node 22.5+ (for `node:sqlite`); Node 24 recommended.

If you use Claude Code, there's a bundled setup skill — open the project and ask
it to *"set up OpenLeads"* (or invoke `setup-openleads`). The steps below are
the same thing by hand.

```bash
# 1) API  (http://127.0.0.1:8787)
cd api
npm install
cp .env.example .env          # set SETTINGS_KEY
npm run seed -- <user> <pw>   # create the login
npm run dev

# 2) Web  (http://localhost:5173, proxies /api to the API)
cd ../web
npm install
npm run dev
```

`node:sqlite` prints an `ExperimentalWarning` on boot. That's expected; ignore
it. A fresh database starts with the isarwebsites Leistungskatalog prefilled —
edit it under Einstellungen.

## Configuration

| Variable       | Where | Purpose                                                  |
|----------------|-------|-----------------------------------------------------------|
| `SETTINGS_KEY` | api   | encrypts credentials saved via the Settings UI (required in production) |
| `DB_PATH`      | api   | SQLite file location (default `./data/leads.db`)          |
| `WEB_ORIGIN`   | api   | allowed browser origin (CORS + CSRF check)                |
| `TRUST_PROXY`  | api   | set `1` behind your own reverse proxy (nginx) only        |
| `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` | api | AI endpoint (default: local Ollama); also settable in the UI |
| `SMTP_*`       | api   | outgoing mail (optional); also settable in the UI         |

There is no session secret: sessions live server-side in the database, so
logout and password resets revoke them for real.

## Deployment

One Docker image holds the built web app and the API that serves it.
[deploy/DEPLOY.md](deploy/DEPLOY.md) walks through an nginx + Docker Compose
setup. The SQLite DB lives in a named volume so it survives image updates.

## e-Invoices (ZUGFeRD / Factur-X)

A finalised Rechnung embeds the structured EN 16931 Cross Industry Invoice XML
(`factur-x.xml`) into a PDF/A-3, so tools like lexoffice / sevDesk / DATEV pick
up the line items and totals on their own. Kleinunternehmer invoices use tax
category `E` (§19); everything else is category `S` at the configured rate.

One caveat worth taking seriously: validate the output with the official
ZUGFeRD validator / Mustang / veraPDF before you rely on it for tax purposes.
The target profile is EN 16931.

## License

[MIT](LICENSE) — © 2026 Lucas Reimers.

## Disclaimer

OpenLeads is provided as-is. It is not tax or legal advice — check invoice
output and your bookkeeping obligations with your Steuerberater.
