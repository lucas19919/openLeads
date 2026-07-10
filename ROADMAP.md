# Roadmap

The aim is the one self-hosted tool for the whole isarwebsites flow — Leads →
Ansprache → Angebot → Rechnung/Vertrag — in the DACH market, where the AI runs
on open weights you host yourself and DSGVO/UWG is handled in the product
rather than left to the operator.

For context on where this fits: the big CRMs (Pipedrive, HubSpot) aren't
self-hostable, your data leaves the EU, and AI is an upsell — and none of them do
German invoicing. The invoicing SaaS (sevDesk, lexoffice) doesn't do CRM. This
is the one box that does the whole flow on-prem, tailored to selling websites.

## Done

- CRM pipeline for website prospects (kanban + table, stages, tags), `.xlsx`
  import, dedupe by domain, website-state fields (mobile-friendly, tech,
  staleness signal, score).
- Angebote / Rechnungen, gapless numbering, ZUGFeRD / Factur-X PDF/A-3, §19 UStG,
  built-in EN 16931 validator, Käuferreferenz / Leitweg-ID (BT-10).
- Model-agnostic AI provider (OpenAI-compatible, open/local first); copilot agent
  that operates the CRM and invoicing through audited tools, tuned to the
  isarwebsites offering.
- Lead intelligence (qualification, fit scoring, next action), outreach drafting
  (human-approved, never auto-sent), natural-language invoicing, lead-from-URL
  (fetch a website, extract the facts, create a qualified lead).
- Gated SMTP send (only after approval; Impressum + opt-out appended).
- GoBD / DATEV export (invoice journal + booking CSV) for the Steuerberater,
  plus an in-app EÜR period report.
- Ausgaben (expenses): receipts with vendor/category/date, gross-entry with the
  net + Vorsteuer split out, receipt scan stored with the booking, SKR03 expense
  categories, journal + DATEV expense export; laufende Abos with renewal
  reminders.
- DSGVO toolkit: audit log, data export, erasure (with §147 AO retention),
  consent ledger, Art. 30 processing record. Opt-out blocks e-mail at send time.
- Payments ledger: per-invoice payments (partial supported), auto-marks
  `bezahlt` when settled, reopens on reversal.
- Serienrechnungen (recurring invoices) for Hosting-/Wartungsverträge: a
  template + cadence emits a *draft* Rechnung each period (human still
  finalises); in-process scheduler + manual run.
- Verträge + AGB: Dienst-/Werk-/Wartungsvertrag, Auftragsbestätigung,
  Rahmenvertrag, AVV; gapless numbering; AGB snapshot frozen at finalise;
  print-ready multi-page PDF with signature block; e-mail for signature;
  acceptance record; signed copy stored with the contract.
- Leistungskatalog: reusable line items (price/unit/USt/SKU), copied by value
  into documents; "+ Aus Katalog" picker; a fresh install is prefilled with the
  isarwebsites packages (Website Starter/Business/Premium, Relaunch, Hosting &
  Pflege, SEO, Google Business Profil, …).
- Kunden (customer registry): central client list; documents/contracts/recurring
  created from a customer are prefilled, value-snapshotted and linked.
- Dashboard (Übersicht): live KPIs — open/overdue/paid, 12-month revenue,
  pipeline by stage, conversion, active contracts + 60-day Fristende reminders.
- Multi-user: `admin` / `member` roles, in-app user management, lead assignment.
- Rewrite 2026-07: API reorganised into `routes/` modules; server-side revocable
  sessions (no session secret, only token hashes stored); CSRF origin checks,
  hardening headers + CSP, request-size limits; settings admin-gated; document
  list N+1 removed and BLOBs kept out of list queries; the lead scraper, the
  stale MCP workspace and the removed-integrations docs were dropped; defaults
  and AI prompts tailored to isarwebsites.

## Open

- Website-project tracking: a light "Projekt" state per won lead (Kickoff →
  Design → Umsetzung → Livegang → Übergabe) so the delivery side is visible next
  to the sales side.
- Finer-grained permissions (today `member` can do everything except user/
  settings administration); per-user data scoping if teams need it.
- A full contacts/companies split (multiple contacts per company) if ever needed.
- Full XRechnung Schematron (BR-DE-*) enforcement, and an XRechnung-only
  (non-PDF) output variant. Today BR-DE checks are warnings, not hard failures.
- E2E tests (Playwright). The unit + HTTP-smoke coverage is decent; the UI isn't
  covered.
- Structured logging / metrics.

## Principles

1. The AI operates the product; it isn't a plugin.
2. Open weights, self-hostable, on-prem first.
3. A human is in the loop for anything that leaves the building.
4. Compliance is part of the build, not a checklist for the operator.
5. Stay dependency-light (Node built-ins + `fetch`).
