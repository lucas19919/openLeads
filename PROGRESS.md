# Changelog / progress notes

A running log of what's landed, so picking the work back up is easy. Newest first.

## Latest

- Mobile: the whole web app is now phone-friendly (verified at 320–375px, no
  horizontal overflow on any view). Data tables (Leads, Rechnungen, Mahnungen,
  Serien, Team) and the invoice line-item/payments editors collapse from
  horizontal-scroll into labelled stacked cards under 720px via per-`<td>`
  `data-label` + a CSS card transform; the 7 nav tabs wrap (all visible) instead
  of clipping; tap targets are ≥44px and form controls 16px (no iOS zoom); the
  lead drawer is a full-screen sheet; safe-area insets (notch) and a scrollable
  modal/dashboard 2-up. All mobile rules are in `@media (max-width:720px)` and
  ordered after their base rules. Audited + adversarially reviewed via subagents.
- Generalisation + new modules (make OpenLeads useful beyond a single Munich
  operator):
  - **Payments**: `payments` table; per-invoice recording with partial payments,
    auto-flips status to `bezahlt` when settled (reopens on reversal). Dunning now
    accrues interest on the *outstanding* amount, and the €40 §288(5) Pauschale is
    B2B-only via a new `client_type` (Geschäft/Privat) flag on documents.
  - **Serienrechnungen** (recurring invoices): template + cadence (monatlich /
    quartalsweise / jährlich) emits a draft Rechnung each period via an in-process
    scheduler (6h) or on demand; never auto-finalised or sent.
  - **Dashboard** ("Übersicht", default tab): open/overdue/paid totals, 12-month
    revenue bars, pipeline-by-stage, conversion.
  - **Multi-user**: `admin`/`member` roles, user management UI (admin-only),
    lead assignment dropdown. `requireAdmin` guard on user routes.
  - **Hardcoding cleanup**: scraper model is `SCRAPER_MODEL`-overridable; region is
    a setting (no baked "Großraum München"); town/region defaults neutralised; the
    scraper raster is editable under Settings → Lead-Scraper.
  - New unit tests: `payments.test.ts`, `recurring.test.ts`, plus dunning coverage
    for partial-payment interest and the B2C no-Pauschale rule. 47 API tests green.
- Leads: replaced the old Wiedervorlage (follow-up date) with a `Rückruf`
  pipeline stage, and added free-form tags on leads (chips on cards + the table,
  editable in the drawer, searchable).
- Workflows: rebuilt the static three-card screen into a routine builder. You
  pick a target (stage / qualification / tags / score / "not yet evaluated" etc.)
  and chain steps from a palette — scrape, qualify, draft outreach, move stage,
  set priority, tag, note. Routines run on demand or on a schedule (hourly /
  daily / weekly) via an in-process scheduler. Scrape runs first in a routine so
  fresh leads flow into the following steps. Outreach steps still only produce
  drafts.

## v1

The first complete, hardened version. 33 API unit tests green, full HTTP smoke
test green, all packages typecheck, web builds.

What's in it:

- **AI core** (`api/src/ai/*`): OpenAI-compatible provider (open/local first),
  copilot agent loop, domain tools, lead intelligence (analyze / outreach),
  NL→invoice. Agent loop tested against a mock model.
- **Lead pipeline**: scraper (Claude web search) + staleness scoring, CRM kanban
  and table, stages, notes, `.xlsx` import, dedupe by domain. Per-lead AI
  qualification and outreach drafting.
- **Semantic lead search** (`/api/ai/leads/search`): local embeddings + cosine,
  with a SQL fallback when the model is offline.
- **Invoicing**: Angebote / Rechnungen, gapless numbering, ZUGFeRD / Factur-X
  PDF/A-3 (§19 UStG aware), built-in EN 16931 validator, Käuferreferenz /
  Leitweg-ID (BT-10) for B2G.
- **Mahnwesen** ("Offene Posten"): overdue detection, Mahnstufen, §288 BGB
  Verzugszinsen + €40 Pauschale, printable Mahnung PDF.
- **GoBD / DATEV export**: invoice journal + booking CSV, date-ranged, with
  configurable SKR03 accounts.
- **Gated SMTP send**: only fires for status `freigegeben`, appends Impressum +
  opt-out, audited.
- **AI daily digest** (`/api/ai/digest`) surfaced in the copilot as a
  Tages-Briefing.
- **DSGVO toolkit** (`dsgvo.ts`, `audit.ts`): audit log, export, erasure (with
  §147 AO retention), consent ledger, Art. 30 record.
- **Backups** (`backup.ts`, `scripts/backup.ts`, `npm run backup`).
- **Security pass**: CSV formula-injection neutralised; the API fails closed if
  `SESSION_SECRET` is unset in production (verified by a boot refusal); in-memory
  rate limit on `/api/ai/*` (30/min/user) and 8k input caps. Container
  HEALTHCHECK on `/api/health`.

## Checking it builds

- API: `cd api && npx tsc --noEmit && npm test`
- Web: `cd web && npx tsc --noEmit && npm run build`

## Conventions

Dependency-light (Node built-ins + `fetch`). German UI. Strict TypeScript. Money
in cents. The AI never auto-sends. Every personal-data write and every AI action
goes through `audit()`.
