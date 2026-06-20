# Roadmap

The aim is a self-hostable tool for the whole Leads → Ansprache → Angebot →
Rechnung flow in the DACH market, where the AI runs on open weights you host
yourself and DSGVO/UWG is handled in the product rather than left to the operator.

For context on where this fits: the big CRMs (Pipedrive, HubSpot) aren't
self-hostable, your data leaves the EU, and AI is an upsell — and none of them do
German invoicing. The invoicing SaaS (sevDesk, lexoffice) doesn't do lead gen or
CRM. The US lead-gen tools (Apollo, Cognism) are expensive, DSGVO-grey and don't
touch invoicing. OpenLeads is the one box that does the whole flow on-prem.

## Done

- Lead scraper (Claude web search), staleness scoring, CRM pipeline (kanban +
  table, stages, tags), `.xlsx` import, dedupe by domain.
- Angebote / Rechnungen, gapless numbering, ZUGFeRD / Factur-X PDF/A-3, §19 UStG,
  built-in EN 16931 validator, Käuferreferenz / Leitweg-ID (BT-10).
- Model-agnostic AI provider (OpenAI-compatible, open/local first); copilot agent
  that operates the CRM and invoicing through audited tools.
- Lead intelligence (qualification, fit scoring, next action), outreach drafting
  (human-approved, never auto-sent), natural-language invoicing.
- Semantic lead search (local embeddings, SQL fallback offline).
- Gated SMTP send (only after approval; Impressum + opt-out appended).
- Mahnwesen: overdue detection, Mahnstufen, §288 BGB Verzugszinsen + €40
  Pauschale, printable Mahnung PDF.
- GoBD / DATEV export (invoice journal + booking CSV) for the Steuerberater.
- DSGVO toolkit: audit log, data export, erasure (with §147 AO retention),
  consent ledger, Art. 30 processing record. Opt-out blocks e-mail at send time.
- Payments ledger: per-invoice payments (partial supported), auto-marks `bezahlt`
  when settled, reopens on reversal; dunning interest accrues on the *outstanding*
  amount, and the €40 Pauschale is correctly B2B-only (a `client_type` flag).
- Serienrechnungen (recurring invoices): a template + cadence emits a *draft*
  Rechnung each period (human still finalises); in-process scheduler + manual run.
- Dashboard (Übersicht): live KPIs — open/overdue/paid, 12-month revenue, pipeline
  by stage, conversion.
- Multi-user: `admin` / `member` roles, in-app user management, lead assignment.
- Generalisation: scraper model and region are configurable (no hardcoded Munich);
  the scraper raster (trades/towns/region) is editable in Settings.

## Open

- Finer-grained permissions (today `member` can do everything except user/—
  settings administration); per-user data scoping if teams need it.
- Bank-statement reconciliation (CAMT.053 / MT940 import) to auto-match payments,
  instead of recording them by hand.
- A contacts/companies split — a lead is still one flat row (one contact each).
- Move the scraper scoring weights + priority cut-offs into Settings (still code
  constants today).
- Full XRechnung Schematron (BR-DE-*) enforcement, and an XRechnung-only
  (non-PDF) output variant. Today BR-DE checks are warnings, not hard failures.
- A reliable way to trigger the scrape step in a split-container deploy — right
  now the step spawns the scraper as a child process, which only works where the
  API can see the scraper. An internal trigger endpoint would fix that.
- E2E tests (Playwright). The unit + HTTP-smoke coverage is decent; the UI isn't
  covered.
- Structured logging / metrics.
- i18n beyond German, if there's ever demand for it. (The tax/legal core is DACH
  by design; this would be a country-pack layer, not a string swap.)

## Principles

1. The AI operates the product; it isn't a plugin.
2. Open weights, self-hostable, on-prem first.
3. A human is in the loop for anything that leaves the building.
4. Compliance is part of the build, not a checklist for the operator.
5. Stay dependency-light (Node built-ins + `fetch`).
