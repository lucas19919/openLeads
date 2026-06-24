# Changelog / progress notes

A running log of what's landed, so picking the work back up is easy. Newest first.

## Latest

- **Signed-document upload on contracts.** Answers "where do I put the contract the
  client signed and sent back?" — previously only the *fact* of signing was recorded
  (signed_by/at via "Unterzeichnet"); the returned PDF/scan had no home. Now a
  contract stores the countersigned file inline as a BLOB (mirrors the expense-receipt
  store, so the single-file backup carries it; GoBD keeps the signed paper with the
  record). Routes `POST/GET/DELETE /api/contracts/:id/signed-document` (PDF/image,
  10 MB cap, same allow-list as receipts); the bytes never leave the server raw —
  `getContract`/`listContracts` expose `has_signed_doc` + name/mime/size only.
  Contract editor gains an **"Unterschriebenes Dokument"** section (upload / view /
  remove). **2 tests** (store→flag-without-leak→fetch→delete; null on missing) →
  **174 API tests green**; api + web typecheck clean; web builds; upload→reject→
  download→delete smoke-tested live (37-byte PDF round-trips, .exe → 415).

- **EÜR / period financial report.** An in-app income-surplus overview for a date
  range, derived from existing data (no new state): revenue (finalised, non-storniert
  invoices by issue date) − expenses (by SKR03 category, by Belegdatum) = result,
  plus the **VAT position** (USt eingenommen − Vorsteuer = Zahllast, the UStVA figure).
  `buildEuer()` in `api/src/report.ts`; route `GET /api/report/euer?from&to`. Shown in
  **Einstellungen → Steuerberater-Export** ("EÜR-Übersicht anzeigen" reuses the
  from/to pickers) as KPI cards + an expenses-by-category table. Complements the
  DATEV/CSV exports with a human-readable view; not tax advice. **3 tests**
  (sum + VAT position, date-range filtering, §19 → no VAT) → **172 API tests green**;
  api + web typecheck clean; web builds; endpoint smoke-tested live.

- **MT940 bank import.** Completes bank reconciliation: alongside CAMT.053, the
  importer now also parses **MT940** (SWIFT fixed-format) — `parseMt940` reads the
  `:61:`/`:86:` blocks (value date, credit/debit mark, amount, ?NN-subfield
  Verwendungszweck + payer), conservative on the mark so reversals never auto-book.
  A new `parseStatement()` auto-detects CAMT vs MT940, so the whole existing
  matcher/apply/dedupe/UI pipeline works unchanged; the upload route + BankView accept
  `.sta`/`.txt` too. **3 new tests** (MT940 parse, format auto-detect, MT940
  credit→match→book) → **169 API tests green**; api + web typecheck clean; web builds;
  a real `.sta` upload smoke-tested live (matched by number, invoice → bezahlt).

- **Customer 360 (per-client cockpit).** Turns the customer links from the Kunden
  release into a real overview: `customerOverview()` (`api/src/customers.ts`)
  aggregates everything tied to a `customer_id` — documents (with gross/paid/open),
  contracts, recurring templates — plus revenue totals (invoiced/paid/open, quote
  count, active-contract count). Route `GET /api/customers/:id/overview`. The Kunden
  editor now shows the overview below the form: three KPI cards + linked-belege
  tables with jump-through to Rechnungen/Verträge/Serien. **2 new tests** (aggregation
  totals incl. part-payment + quote/contract counting; null on missing) →
  **166 API tests green**; api + web typecheck clean; web builds; overview
  smoke-tested live (invoiced 119 €, 50 € paid, 69 € open, 1 active contract).

- **Angebot → Vertrag conversion.** Turn an accepted offer into a contract draft,
  mirroring the existing Angebot→Rechnung convert and wiring the offer pipeline into
  contracts. `contractFromDocument()` (`api/src/contracts.ts`) carries the client
  block, customer/lead links and the net value over, and builds a
  Leistungsbeschreibung from the offer's line items; the contract links back via
  `document_id`. Route `POST /api/documents/:id/to-contract`, an **"In Vertrag
  umwandeln"** button on Angebote in the editor, and an AI tool
  `contract_from_document` for the copilot. **3 new tests** (helper builds the draft
  + null on missing doc; agent-tool round-trip) → **164 API tests green**; api + web
  typecheck clean; web builds; conversion smoke-tested live (offer → werkvertrag
  draft, €300 net, linked).

- **AGB on Angebot/Rechnung PDFs (optional).** Deepens the contracts/AGB
  integration: a settings toggle (`agb_attach_documents`) appends the operator's AGB
  as a final page to every quote/invoice PDF, so the terms travel with the document
  — not just with contracts. Uses the embedded DejaVu fonts so it stays valid under
  PDF/A-3, is appended after the footer/body (invoice page untouched), and leaves the
  embedded ZUGFeRD/Factur-X XML attachment unaffected. Toggle lives in **Einstellungen
  → Verträge & AGB**. **3 PDF tests** (always-valid PDF, appendix only when enabled +
  grows the file, no-op without AGB text) added to `npm test`. **161 API tests
  green**; api + web typecheck clean; web builds; toggle-persists-and-enlarges-PDF
  smoke-tested live (29 KB → 32 KB).

- **AI copilot drives the customer registry too.** Kept the "AI operates the
  product" principle intact for the newest module: added `list_customers` /
  `create_customer` agent tools, and `create_document` / `create_contract` now accept
  a `customer_id` that prefills the recipient (name/address/USt-IdNr./type) from the
  Kundenstamm. Copilot prompt nudges it to look up a known customer first and pass
  the id rather than retyping. **5 new agent-tool tests** (customer round-trip,
  prefill via both create tools, name-required, unknown-id error) — **158 API tests
  green**; typecheck clean. Backend-only.

- **Kunden (customer registry).** A central client list so a customer is maintained
  once and reused — the pragmatic, additive answer to the roadmap's contacts split
  (the flat lead row is untouched; no risky migration).
  - **`customers` table + `api/src/customers.ts`**: CRUD (name/contact/address/USt-
    IdNr./client type/payment-term override/notes/active). Nullable `customer_id`
    links added to `documents`, `contracts`, `recurring_invoices`. The document/
    contract/recurring **create paths now accept `customer_id`** and prefill the
    `client_*` fields from it (precedence: explicit field > customer > lead), storing
    the link — but the client block stays a **value snapshot**, so renaming a
    customer never rewrites an issued document (verified by a test + live smoke).
    Routes under `/api/customers`.
  - **Web**: a new **Kunden** tab (`web/src/components/customers/CustomersView.tsx`) —
    CRUD plus per-customer quick-create buttons (Rechnung / Angebot / Vertrag) that
    spin up a prefilled draft and jump to the right module.
  - **5 customer tests** (validation, active filter, prefill + snapshot immutability,
    explicit-override, recurring prefill) wired into `npm test`; three existing doc
    fixtures updated for the new `customer_id` field. **153 API tests green**; api +
    web typecheck clean; web builds; create→prefill→rename-immutability smoke-tested
    live.

- **Bankabgleich (CAMT.053 reconciliation).** Closes the roadmap's "record payments
  by hand" gap — import a bank statement, auto-match incoming credits to open
  invoices, record the payments.
  - **`bank_transactions` table + `api/src/bank.ts`**: a dependency-light CAMT.053
    (ISO 20022) parser (hand-rolled, namespace-tolerant — the project ships no XML
    lib, like `facturx.ts` building CII by hand), skipping non-booked entries.
    `suggestMatch` ties a credit to an open invoice by the **invoice number in the
    Verwendungszweck**, falling back to a unique exact amount. `applyMatches` records
    a payment per confirmed credit (reusing `addPayment`, which reconciles the
    invoice to `bezahlt`) and files the bank row; **idempotent via `ext_ref`**
    (AcctSvcrRef/NtryRef or a content hash) so re-importing a statement never
    double-books. Routes: `POST /api/bank/preview` (multipart file or `{xml}`,
    writes nothing), `POST /api/bank/apply`, `GET /api/bank/transactions`.
  - **Web**: a new **Bank** tab (`web/src/components/bank/BankView.tsx`) — upload a
    `.xml`, review each entry with its suggested invoice (or override / ignore via a
    dropdown), then "Zuordnungen übernehmen". Already-imported entries are shown
    greyed.
  - **6 bank tests** (parse, booked-only filter, number/amount matching, debit→no
    match, apply records + reconciles + dedups) wired into `npm test`. **148 API
    tests green**; api + web typecheck clean; web builds; the full
    import→match→apply→re-import-dedupe flow smoke-tested against a live server.

- **Dashboard (Übersicht) now covers the whole business.** The new modules were
  invisible on the cockpit. Extended `buildDashboard` (`api/src/dashboard.ts`,
  read-only, derived live) with: **unbilled billable time** (count, hours, € — money
  earned but not yet invoiced), **active contracts** (count + summed net value +
  open drafts), and a **Fristende-list** of active/sent contracts ending within 60
  days (renewal/notice nudge, soonest first). Two new KPI cards ("Nicht abgerechnet"
  → Zeiten, "Aktive Verträge" → Verträge) plus an expiring-contracts reminder table
  on the Übersicht. **4 dashboard tests** (unbilled-time math, active count/value,
  60-day expiry window incl. end-date/status exclusions) wired into `npm test`.
  **142 API tests green**; api + web typecheck clean; web builds; the new dashboard
  fields smoke-tested against a live server.

- **AI copilot now drives the new modules.** The three modules added this loop
  (catalog, time, contracts) were UI-only; the copilot couldn't touch them — which
  broke the product's first principle ("the AI operates the product"). Added 9
  audited agent tools in `api/src/ai/tools.ts`: `list_catalog` / `create_catalog_item`,
  `list_time` / `log_time` / `invoice_time` (log hours or minutes, then turn
  billable entries into a draft Rechnung), and `list_contracts` / `create_contract`
  / `finalize_contract` (draft from a description, then assign number + freeze AGB).
  `get_settings` now also reports the default hourly rate + whether AGB are set. The
  copilot system prompt advertises the new capabilities. **5 new agent-tool tests**
  (round-trips via `runTool`, hours→minutes, double-bill prevention, AGB freeze)
  wired into `npm test`. **138 API tests green**; typecheck clean. Backend-only —
  the Chat UI renders any tool's steps generically.

- **Zeiterfassung (time tracking).** Log billable time and turn it into invoices —
  closes the agency/freelancer "hours → Rechnung" loop.
  - **`time_entries` table + `api/src/timetracking.ts`**: entries (date, lead,
    description, minutes, net hourly rate, billable) with the amount derived as
    minutes/60 × rate. `invoiceTimeEntries(ids)` pulls billable, not-yet-invoiced
    entries into a single **draft** Rechnung (one line each, hours × rate, German
    date in the line text), then stamps each with `document_id` + `invoiced_at` so
    it can never be billed twice — all-or-nothing in one transaction. Invoiced
    entries are locked against edit/delete. Routes under `/api/time`
    (list+summary with from/to/lead/billable/invoiced filters, create/patch/delete,
    and `/time/invoice`). New setting `default_hourly_rate_cents`.
  - **Web**: a new **Zeiten** tab (`web/src/components/time/TimeView.tsx`) — a quick
    log form (decimal-hours input, default + catalog rate prefill via the
    `CatalogPicker`), a filterable list with live totals, and checkbox-select →
    "Rechnung aus Auswahl erstellen". Default-rate field added to Settings.
  - **6 time tests** wired into `npm test`. **133 API tests green**; api + web
    typecheck clean; web builds; the full log→invoice→double-bill-refused flow
    smoke-tested against a live server.

- **Leistungskatalog (services/products catalog).** Reusable line items so a
  position is picked, not retyped, across the invoicing surfaces.
  - **`catalog_items` table + `api/src/catalog.ts`**: CRUD with name/unit/net price/
    USt/SKU/category/active/sort. Items are copied **by value** into documents (no
    FK), so editing or deleting a catalog entry never mutates an already-written
    invoice — a deliberate, tested property. Routes under `/api/catalog`
    (list with `?active=1`, create/patch/delete), audited.
  - **Web**: a `CatalogPicker` ("+ Aus Katalog" dropdown, hidden when empty) wired
    into the **Angebot/Rechnung editor** and the **Serienrechnung editor**; picking
    an item appends a prefilled line (and replaces a lone empty starter row). Full
    management UI (add / inline-edit price-unit-USt / toggle active / delete) lives
    in **Einstellungen → Leistungskatalog**, editable by members too.
  - **6 catalog tests** wired into `npm test`. **127 API tests green**; api + web
    typecheck clean; web builds; catalog CRUD + active-filter smoke-tested against a
    live server (no contract-module regression).

- **Verträge (contracts) + AGB.** A new module to run the contract side of the
  business, built on the proven documents/recurring idioms (no new deps).
  - **AGB management** in Settings (`agb_text` + `contract_prefix`/`contract_next`).
    The AGB are *snapshotted onto the contract at finalise* (`contracts.agb_text`),
    so the terms in force at signature govern and editing the standard AGB later
    never mutates an issued contract — verified by a test.
  - **`contracts` table + `api/src/contracts.ts`**: CRUD, gapless numbering
    (`V-YYYY-0001`, same transactional counter pattern as invoicing), AGB freeze on
    `finalize`, a `sign` transition (records signatory + date → status `aktiv`), and
    free status transitions (`abgelehnt`/`beendet`). Types: Dienst-/Werk-/Wartungs-
    vertrag, Auftragsbestätigung, Rahmenvertrag, AVV (Art. 28 DSGVO), Sonstiges.
  - **Contract PDF** (`api/src/contractPdf.ts`): invoice-styled letterhead, parties
    block (Auftragnehmer/Auftraggeber), numbered §-sections (Präambel, Vertrags-
    gegenstand, Vergütung incl. §19/USt split, Laufzeit & Kündigung), the AGB in
    full, and a two-column signature block. Multi-page via `bufferPages` with a
    footer + "Seite X/Y" stamped on every page.
  - **Routes** under `/api/contracts` (list/get/create/patch/finalize/sign/pdf/
    send/delete) — finalised contracts can't be deleted, drafts can; `/send`
    e-mails the PDF via the existing gated `deliverMail`. New webhook events
    `contract.created` / `contract.finalized` / `contract.signed`, audited like the
    rest.
  - **Web**: a new **Verträge** tab (`web/src/components/contracts/ContractsView.tsx`)
    — list + a lock-aware editor (content freezes once finalised) with festschreiben/
    senden/unterzeichnen/PDF + a status select; AGB editor added to Settings.
  - **10 contract tests** (totals, gapless numbering, AGB-freeze immutability,
    sign/finalize idempotency, delete rules, multi-page PDF render) wired into
    `npm test`. **121 API tests green**; api + web typecheck clean; web builds; the
    full create→finalize→sign→PDF→send lifecycle smoke-tested against a live server.

- **Connections: the money loop + more adapters + OAuth + an MCP server.** Built on
  the integrations foundation; docs in `docs/INTEGRATIONS.md`.
  - **Money loop closed** (fully verifiable): per-invoice **Stripe/GoCardless
    payment link** (`POST /api/documents/:id/payment-link` + invoice button),
    **e-mail the invoice PDF** to the client with an optional pay link
    (`/send`), **VIES USt-IdNr. validation** (`/validate-vat` + a `client_vat_id`
    field with a "Prüfen" button), **push to accounting** (`/push-accounting`),
    and **webhook signing-secret rotation** (shown once; clean because the
    dispatcher signs at send time). Public-API variants added under `/api/v1`
    (payment-link, payments, `stats/pipeline`) with two new scopes
    (`payments:write`, `stats:read`); new event `invoice.sent`.
  - **New adapters** on the proven fetch-only, base-host-pinned pattern (pure
    parts unit-tested; live calls behind methods): **GoCardless** (SEPA, billing
    request flow + plain-HMAC webhook verify), **lexoffice** + **sevDesk**
    (`pushInvoice` mapping the flat `FullDocument`, §19 Kleinunternehmer handled),
    **sipgate** (click-to-call, E.164 normalisation).
  - **OAuth2 framework** (`integrations/oauth.ts`): encrypted token store
    (`oauth_tokens`/`oauth_pending`), single-use CSRF state, redirect-bound code
    exchange, auto-refresh — driving **Google** (Gmail send + Calendar) and
    **Microsoft Graph** (Outlook mail + Calendar) adapters. Each ships as two
    connections (mail + calendar) since the registry resolves one adapter per
    category. Operator registers an OAuth app and clicks "Verbinden" (live flow
    needs the app; pure builders are unit-tested).
  - **OpenLeads MCP server** (`mcp/`): a stdio MCP server wrapping `/api/v1`,
    authenticated with an `ol_` API key, exposing 9 tools (leads, documents,
    payments, pipeline stats) so the CRM is drivable from Claude Desktop. The
    `@modelcontextprotocol/sdk` is isolated to `mcp/` — the API stays SDK-free.
  - **11 providers** now register (payment ×2, accounting ×3, mail ×3, calendar
    ×2, telephony ×1). **87 tests** total green (77 api + 14 mcp − overlap), all
    typecheck clean, web builds, boot verified. Out of scope as drop-ins (need
    certified infra/contracts): live DATEVconnect, Peppol access point, real
    open-banking/FinTS.

- **Integrations foundation** — the substrate the integration roadmap rides on,
  three coupled subsystems, all dependency-light + idiom-matched (docs:
  `docs/INTEGRATIONS.md`):
  - **Integrations module** (`api/src/integrations/`): a per-category adapter
    interface (`PaymentProvider`, `AccountingProvider`, `MailProvider`,
    `EnrichmentProvider`, `CalendarProvider`, `TelephonyProvider`), an encrypted
    connection store (`integration_connections`, credentials AES-256-GCM via
    `secrets.ts`), a registry (`register`/`available`/`resolve`/`saveConnection`/
    `activate`), and **three real reference adapters**: Stripe (Checkout via
    `fetch`, no SDK; base URL pinned to `api.stripe.com`), VIES (free EU USt-IdNr.
    validation), and SMTP (wraps the existing mailer, keeping its UWG §7 / opt-out
    gates). Admin routes under `/api/integrations/*` + an **unauthenticated,
    signature-gated inbound webhook receiver** (`/api/integrations/webhooks/:provider`)
    that records a Stripe payment against the invoice in `metadata.document_id`,
    idempotent via `integration_events UNIQUE(provider, external_id)`.
  - **Public API** (`api/src/publicapi/`): scoped `ol_<prefix>_<secret>` keys,
    SHA-256-hashed at rest (the token is 192-bit random — no slow KDF, no
    per-request DoS), shown once, revocable. A versioned `/api/v1/*` Bearer surface
    (disjoint from the session cookie), scope-checked (`leads:read|write`,
    `documents:read|write`), rate-limited per key, cursor-paginated, over
    leads + documents. Admin key CRUD under `/api/admin/api-keys`.
  - **Outbound webhooks** (`api/src/webhooks/`): a non-throwing `emit(event)` bus
    that enqueues `webhook_deliveries`, hooked into lead create / stage change /
    document create + finalize / payment record + delete. An in-process dispatcher
    (same `setInterval(...).unref()` idiom as the recurring scheduler) signs each
    delivery Stripe-style (`Webhook-Signature: t=..,v1=..`, HMAC-SHA256 over
    `${t}.${body}`), POSTs with a timeout, retries with exponential backoff
    (30s→6h, 6 attempts) then dead-letters, and **SSRF-guards** every target on
    each attempt (HTTPS-only, private/loopback/link-local/metadata IPs rejected,
    redirects not followed). Admin endpoint CRUD + deliveries + redeliver.
  - `insertLead`/`applyLeadUpdate`/`normalizeTags` were extracted from `index.ts`
    into a shared `leads.ts` so the public API reuses one implementation (and
    webhook events fire from one place). Set `WEBHOOKS_DISABLE=1` to turn the
    dispatcher off, `WEBHOOKS_ALLOW_HTTP=1` for dev.
  - **Web UI** (`web/src/components/integrations/IntegrationsView.tsx`): a new
    admin-only **Integrationen** tab (hidden for members) with three sections —
    connect/activate/probe providers (forms rendered from each adapter's
    `configSchema`), mint/revoke API keys (token shown once), and subscribe/manage
    webhooks (signing secret shown once, deliveries + redeliver). Reuses the
    existing Settings idioms (write-only secrets, `items-table` mobile cards).
    Verified in-browser: key + webhook creation, the one-time reveals, and the
    SSRF guard rejecting a private target all work end-to-end.
  - New offline tests: `webhooks.test.ts`, `publicapi.test.ts`,
    `integrations.test.ts` (signature round-trip, SSRF range coverage, emit
    fan-out, backoff, key mint/verify/scope/revoke, Stripe webhook verify, VIES
    mapper). **61 API tests green**; typecheck clean; boot + e2e verified.
- Scraper page is back, now with a **GUI run button** (`api/src/scrape.ts` +
  `POST /api/scraper/run`, recovered after commit 760d379 had stripped it). It
  spawns the scraper as a one-shot child process, fire-and-poll: the panel watches
  `/api/scraper/status` (now carries `run` state + `reachable` + `service_token_configured`)
  for live progress and the final result. A **Testlauf** (`--dry-run`, offline
  fixtures) runs the whole pipeline with no Anthropic cost. Config (region/raster/
  limits) lives on the dedicated Scraper page. New tab in the suite nav.
  - The API now **auto-wires the CRM connection** into the spawned scraper —
    injects its own `SERVICE_TOKEN` as `CRM_SERVICE_TOKEN` (name mismatch was the
    "CRM_SERVICE_TOKEN fehlt" error) plus `CRM_API_URL`. No `scraper/.env` needed
    for the CRM side; the only bootstrap requirement is `SERVICE_TOKEN` in `api/.env`.
  - **Discovery model + API key are now GUI-settable** (`scraper_model` plain,
    `scraper_ai_api_key` encrypted like the other secrets) and injected into the
    run, so a live run needs no `scraper/.env` at all. The model is selectable
    (any Claude model — not pinned to Sonnet); the page text is model-neutral.
- Kanban: columns now flex to share the board width (`flex: 1 1 0; min-width:150px`)
  so all eight stages — including `verloren` — fit on screen by default instead of
  requiring a horizontal scroll.
- Dashboard: KPI cards use `auto-fit` (was `auto-fill`) so they stretch to fill the
  row on a wide monitor instead of leaving a ragged empty trailing column.
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
