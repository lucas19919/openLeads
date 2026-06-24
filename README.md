# [OpenLeads](openleads.xyz)

A self-hosted sales tool for small web agencies and freelancers in Germany. It
covers the whole path from finding a prospect to sending a proper invoice, and
the AI can actually drive it — read and update the pipeline, draft outreach, turn
a sentence into an invoice — rather than sitting in a chat box off to the side.

It runs on open models you host yourself (a local Ollama by default), so customer
data doesn't leave your machine.

The modules, behind one login:

- **KI** — a copilot that operates the rest of the suite through the same audited
  tools the UI uses: find and qualify leads, move pipeline stages, draft
  outreach, build invoices, manage the service catalog and customer registry, log
  time and turn it into a draft invoice, and draft/finalise contracts — all in German.
- **Leads** — a scraper finds local businesses with dated websites and scores how
  dated they are, then drops them into a CRM pipeline (kanban + table, stages,
  tags, notes, `.xlsx` import, dedupe by domain). Each lead can be qualified and
  have outreach drafted by the AI.
- **Kunden** — a central customer registry. Maintain a client once (address, USt-IdNr.,
  type, default payment term) and create a prefilled Angebot, Rechnung or Vertrag for
  them in one click. Documents keep their own copy, so editing a customer never
  rewrites issued papers.
- **Übersicht** — a dashboard of live KPIs: open and overdue amounts, paid totals,
  a 12-month revenue chart, the pipeline by stage and lead conversion, unbilled
  billable time, active contracts and their value, and a reminder list of contracts
  whose term ends within 60 days.
- **Rechnungen** — Angebote and Rechnungen with line items and a print-ready PDF.
  A finalised invoice is a ZUGFeRD / Factur-X e-invoice (PDF/A-3 with embedded
  EN 16931 XML), Kleinunternehmer (§19 UStG) aware, with gapless numbering and a
  built-in EN 16931 validator. Record payments against an invoice (partial
  payments supported; it marks itself paid when settled). You can also describe a
  job in plain text and get a draft.
- **Serienrechnungen** — recurring invoices: a template + cadence (monthly /
  quarterly / yearly) produces a draft Rechnung each period for you to review and
  finalise. Nothing is auto-sent.
- **Leistungskatalog** — a catalog of reusable services/products with net price,
  unit and USt. Pick a line from it ("+ Aus Katalog") in the Angebot, Rechnung and
  Serien editors instead of retyping; managed under Settings. Lines are copied in,
  so revising the catalog never rewrites an issued invoice.
- **Zeiterfassung** — track billable (or non-billable) time against a lead, by the
  hour at a net rate (default rate + catalog rates prefilled). Select unbilled
  entries and turn them into a draft Rechnung in one click — each entry becomes a
  line (hours × rate) and is marked invoiced so it can't be billed twice.
- **Verträge** — contracts (Dienst-, Werk-, Wartungsvertrag, Auftragsbestätigung,
  Rahmenvertrag, AVV …) with parties, scope, remuneration, term and notice. Your
  AGB live under Settings and are *frozen onto* a contract when it's finalised
  (the terms in force at signature govern), so editing them later never changes an
  issued contract. Gapless numbering, a print-ready multi-page PDF with signature
  block, e-mail to the client for signature, and an acceptance record (aktiv once
  countersigned). The signed copy the client returns can be uploaded and is stored
  with the contract (in the backup). Nothing is auto-sent.
- **Bank** — import a CAMT.053 bank statement and the incoming payments are matched
  to your open invoices automatically (by the invoice number in the Verwendungszweck,
  or a unique amount); you confirm each match and the payments are booked. Re-importing
  a statement is safe — each transaction is recorded once.
- **Offene Posten** — overdue invoices with one-click Mahnungen, §288 BGB
  Verzugszinsen and the €40 Pauschale (B2B only; private-customer invoices are
  handled correctly). Interest accrues on the still-open amount.
- **Ausgaben** — the cost side: record a receipt (Beleg) with vendor, category,
  date and gross amount, and the net + Vorsteuer are split out for you. The scan
  (PDF/photo) is stored with the booking, German expense categories carry SKR03
  accounts, and there's a journal + DATEV expense export for the Steuerberater.
  The dashboard nets it against revenue for a quick Ergebnis.
- **Scraper** — a panel to tune the search raster (trades × towns), the staleness
  threshold and the run limits, with a status readout. It identifies itself with
  an honest bot User-Agent, respects `robots.txt`, throttles its requests, and
  checks the CRM is reachable before spending on AI discovery.

The UI is German and the invoicing follows German tax rules (§19 UStG, ZUGFeRD).
It's built for the DACH market.

On the compliance side: it's self-hosted, AI inference can stay local, there's an
append-only audit log, one-click data export (Art. 15/20) and erasure (Art. 17),
a consent ledger, and an Art. 30 processing record. The AI never sends anything
on its own — a human approves every outgoing message. More detail in
[`docs/AI.md`](docs/AI.md), [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) and
[`ROADMAP.md`](ROADMAP.md).

## Why it exists

Most small agencies pay for a CRM *and* an invoicing SaaS and bridge the two by
copy-paste. OpenLeads is one tool you host yourself, with the lead → invoice flow
joined up. It's deliberately dependency-light: Node's built-in SQLite (no native
build step), a small Hono API, a Vite/React app, and pure-JS PDF generation.

## Stack

| Part        | Tech                                                              |
|-------------|------------------------------------------------------------------|
| `api/`      | [Hono](https://hono.dev) + Node built-in SQLite (`node:sqlite`)  |
| `web/`      | React 19 + Vite (vanilla CSS)                                     |
| `scraper/`  | Node + `@anthropic-ai/sdk` (Claude web search)                   |
| AI core     | OpenAI-compatible (`fetch`) → Ollama / vLLM, open models, on-prem |
| PDF         | `pdfkit` → PDF/A-3 + Factur-X (no native deps)                    |
| Auth        | scrypt password hash + HMAC signed-cookie sessions (no deps)     |

## Quick start (development)

Needs Node 22.5+ (for `node:sqlite`); Node 24 is what I run.

If you use Claude Code, there's a bundled setup skill — open the project and ask
it to *"set up OpenLeads"* (or invoke `setup-openleads`). It checks your Node
version, generates the secrets, writes the `.env` files, seeds a login, optionally
wires up the scraper and a local Ollama, then starts and checks the dev servers.
The steps below are the same thing by hand. See
[`.claude/skills/setup-openleads/SKILL.md`](.claude/skills/setup-openleads/SKILL.md).

```bash
# 1) API  (http://127.0.0.1:8787)
cd api
npm install
cp .env.example .env          # set SESSION_SECRET + SERVICE_TOKEN
npm run seed -- <user> <pw>   # create the login
npm run dev

# 2) Web  (http://127.0.0.1:5173, proxies /api to the API)
cd ../web
npm install
npm run dev

# 3) Scraper (optional, needs ANTHROPIC_API_KEY)
cd ../scraper
npm install
cp .env.example .env          # set CRM_API_URL, CRM_SERVICE_TOKEN, ANTHROPIC_API_KEY
npm run dry-run               # offline fixtures (no Claude / network)
npm start                     # live run
```

`node:sqlite` prints an `ExperimentalWarning` on boot. That's expected; ignore it.

## Configuration

| Variable            | Where       | Purpose                                          |
|---------------------|-------------|--------------------------------------------------|
| `SESSION_SECRET`    | api         | signs session cookies (long random string)       |
| `SERVICE_TOKEN`     | api+scraper | bearer token the scraper uses to post leads      |
| `ANTHROPIC_API_KEY` | scraper     | Claude API key for discovery / scoring           |
| `SCRAPER_MODEL`     | scraper     | discovery model (default `claude-sonnet-4-6`)     |
| `SCRAPER_REGION`    | scraper     | region phrase in the discovery prompt — match your towns (empty by default; prefer setting it under Settings → Lead-Scraper) |
| `DB_PATH`           | api         | SQLite file location (default `./data/leads.db`)  |
| `WEB_ORIGIN`        | api         | CORS origin in dev                               |

The scraper's search raster (trades, towns, region), staleness threshold and run
limits are edited under **Settings → Lead-Scraper** and stored in the DB; the
scraper reads them at the start of each live run (CLI flags > saved config >
built-in defaults). Towns and region ship empty — set them for your area (nothing
is Munich-locked); the run aborts cleanly if no towns are configured. More
politeness/cost knobs are in [`scraper/.env.example`](scraper/.env.example).

## Deployment

One Docker image holds the built web app, the API that serves it, and the
scraper. [deploy/DEPLOY.md](deploy/DEPLOY.md) walks through an nginx + Docker
Compose setup. The SQLite DB lives in a named volume so it survives image updates.

## e-Invoices (ZUGFeRD / Factur-X)

A finalised Rechnung embeds the structured EN 16931 Cross Industry Invoice XML
(`factur-x.xml`) into a PDF/A-3, so tools like lexoffice / sevDesk / DATEV pick up
the line items and totals on their own. Kleinunternehmer invoices use tax category
`E` (§19); everything else is category `S` at the configured rate.

One caveat worth taking seriously: validate the output with the official ZUGFeRD
validator / Mustang / veraPDF before you rely on it for tax purposes. The target
profile is EN 16931.

## License

[MIT](LICENSE) — © 2026 Lucas Reimers.

## Disclaimer

OpenLeads is provided as-is. It is not tax or legal advice — check invoice output
and your bookkeeping obligations with your Steuerberater. When scraping, respect
the law and the target sites' terms.
