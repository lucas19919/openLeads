import './env'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DB_PATH = process.env.DB_PATH
  ? resolve(process.cwd(), process.env.DB_PATH)
  : resolve(process.cwd(), 'data', 'leads.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

// Node's built-in SQLite (Node 22.5+). No native build step, ships with Node.
export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL;')
db.exec('PRAGMA foreign_keys = ON;')

// The sales pipeline. Order matters — it's the column order in the kanban.
// `gewonnen` and `verloren` are terminal. Edit here to change the pipeline.
export const STAGES = [
  'neu',
  'qualifiziert',
  'kontaktiert',
  'rückruf',
  'interessiert',
  'angebot',
  'gewonnen',
  'verloren',
] as const
export type Stage = (typeof STAGES)[number]

export const PRIORITIES = ['hoch', 'mittel', 'niedrig'] as const
export type Priority = (typeof PRIORITIES)[number]

// Login roles. `admin` may manage users + settings; `member` works the pipeline
// and invoicing but cannot administer the instance. Single-operator installs are
// all `admin`, which stays the default so nothing changes for them.
export const ROLES = ['admin', 'member'] as const
export type Role = (typeof ROLES)[number]

// Whom an invoice is billed to. The €40 Verzugspauschale (§288(5) BGB) and B2B
// default interest only apply to a business debtor, so dunning needs to know.
export const CLIENT_TYPES = ['geschaeft', 'privat'] as const
export type ClientType = (typeof CLIENT_TYPES)[number]

// Cadence for a Serienrechnung (recurring invoice).
export const RECURRING_CADENCES = ['monatlich', 'quartalsweise', 'jährlich'] as const
export type RecurringCadence = (typeof RECURRING_CADENCES)[number]

// --- Ausgaben (expenses / Belege) ---
// Operating expenses with the receipt scan attached. Each category carries a
// default SKR03 expense account (Aufwandskonto) used as the booking `Konto` in
// the DATEV export — pragmatic defaults, not tax advice (the Steuerberater
// verifies the mapping, same posture as the invoice export). `id` is the stable
// key sent to the client and stored on bookings; reorder/relabel freely, but keep
// ids stable so existing rows keep their category.
export const EXPENSE_CATEGORIES = [
  { id: 'wareneinkauf', label: 'Wareneinkauf', skr03: '3400' },
  { id: 'fremdleistungen', label: 'Fremdleistungen', skr03: '3100' },
  { id: 'bueromaterial', label: 'Bürobedarf', skr03: '4930' },
  { id: 'telefon_internet', label: 'Telefon / Internet', skr03: '4920' },
  { id: 'porto', label: 'Porto', skr03: '4910' },
  { id: 'software', label: 'Software / Lizenzen', skr03: '4965' },
  { id: 'miete', label: 'Miete / Raumkosten', skr03: '4210' },
  { id: 'reisekosten', label: 'Reisekosten', skr03: '4670' },
  { id: 'kfz', label: 'Kfz-Kosten', skr03: '4530' },
  { id: 'marketing', label: 'Werbung / Marketing', skr03: '4600' },
  { id: 'bewirtung', label: 'Bewirtung', skr03: '4650' },
  { id: 'fortbildung', label: 'Fortbildung', skr03: '4945' },
  { id: 'versicherungen', label: 'Versicherungen / Beiträge', skr03: '4360' },
  { id: 'gebuehren', label: 'Bank- / Nebenkosten Geldverkehr', skr03: '4970' },
  { id: 'sonstiges', label: 'Sonstige Kosten', skr03: '4980' },
] as const
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]['id']

// Wie eine Ausgabe bezahlt wurde (UI-Auswahl; frei lassbar).
export const PAYMENT_METHODS = ['Überweisung', 'Lastschrift', 'Karte', 'Bar', 'PayPal', 'Sonstiges'] as const

// --- Rechnungen / Angebote (invoicing module) ---
// Two document kinds share one table: a quote (Angebot) and an invoice (Rechnung).
export const DOC_KINDS = ['angebot', 'rechnung'] as const
export type DocKind = (typeof DOC_KINDS)[number]

// Statuses are per-kind. `entwurf` documents have no number yet (assigned on finalise).
export const DOC_STATUSES: Record<DocKind, readonly string[]> = {
  angebot: ['entwurf', 'versendet', 'angenommen', 'abgelehnt'],
  rechnung: ['entwurf', 'versendet', 'bezahlt', 'storniert'],
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leads (
  id               INTEGER PRIMARY KEY,
  domain           TEXT UNIQUE,            -- registrable domain, used for dedupe
  company          TEXT,                   -- Firma
  trade            TEXT,                   -- Gewerk
  city             TEXT,                   -- Ort
  website          TEXT,
  phone            TEXT,
  email            TEXT,
  mobile_friendly  INTEGER,                -- 1 / 0 / NULL (Mobilfähig)
  tech             TEXT,                   -- Technik (e.g. "Jimdo", "WordPress 4.x")
  staleness_signal TEXT,                   -- Veraltungs-Signal
  score            INTEGER DEFAULT 0,
  priority         TEXT DEFAULT 'mittel',  -- hoch / mittel / niedrig
  why_lead         TEXT,                   -- Warum-Lead
  stage            TEXT NOT NULL DEFAULT 'neu',
  notes            TEXT,                   -- free-text sales notes
  assigned_to      TEXT,                   -- username, for future multi-user
  source           TEXT DEFAULT 'manual',  -- scraper / manual / import
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);

CREATE TABLE IF NOT EXISTS lead_events (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT,                          -- username or 'scraper'
  type       TEXT NOT NULL,                 -- created / stage_change / note / edit
  from_stage TEXT,
  to_stage   TEXT,
  body       TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_lead ON lead_events(lead_id);

-- Single-row business profile used in document headers + footers.
CREATE TABLE IF NOT EXISTS settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  business_name   TEXT,
  owner           TEXT,                   -- Inhaber/in
  address         TEXT,
  zip             TEXT,
  city            TEXT,
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  tax_id          TEXT,                   -- Steuernummer / USt-IdNr.
  iban            TEXT,
  bic             TEXT,
  bank            TEXT,
  small_business  INTEGER NOT NULL DEFAULT 1, -- Kleinunternehmer §19 UStG (1 = kein USt-Ausweis)
  vat_rate        INTEGER NOT NULL DEFAULT 19,
  payment_terms   INTEGER NOT NULL DEFAULT 14, -- Zahlungsziel in Tagen
  rechnung_prefix TEXT NOT NULL DEFAULT 'RE-',
  rechnung_next   INTEGER NOT NULL DEFAULT 1,
  angebot_prefix  TEXT NOT NULL DEFAULT 'AN-',
  angebot_next    INTEGER NOT NULL DEFAULT 1,
  -- Scraper config (newline/comma-separated lists; NULL = use defaults).
  scraper_trades    TEXT,
  scraper_towns     TEXT,
  scraper_min_score INTEGER,
  scraper_max_pairs INTEGER,
  scraper_per_pair  INTEGER
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

-- Quotes (Angebot) and invoices (Rechnung). Number is NULL while a draft;
-- assigned gaplessly from the settings counter when the document is finalised.
CREATE TABLE IF NOT EXISTS documents (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,           -- angebot / rechnung
  number         TEXT UNIQUE,             -- e.g. RE-2026-0007 (NULL until finalised)
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  client_name    TEXT,
  client_address TEXT,
  client_zip     TEXT,
  client_city    TEXT,
  client_email   TEXT,
  title          TEXT,
  intro          TEXT,                    -- Anschreiben über der Tabelle
  notes          TEXT,                    -- Fußnote (z.B. Lieferzeit, Gewährleistung)
  status         TEXT NOT NULL DEFAULT 'entwurf',
  issue_date     TEXT,                    -- YYYY-MM-DD, set on finalise
  due_date       TEXT,                    -- YYYY-MM-DD
  small_business INTEGER NOT NULL DEFAULT 1, -- snapshot of §19 at issue time
  vat_rate       INTEGER NOT NULL DEFAULT 19,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_kind ON documents(kind, status);
CREATE INDEX IF NOT EXISTS idx_documents_lead ON documents(lead_id);

-- Line items. Money is stored as integer cents to avoid float drift.
CREATE TABLE IF NOT EXISTS document_items (
  id              INTEGER PRIMARY KEY,
  document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  description     TEXT,
  quantity        REAL NOT NULL DEFAULT 1,
  unit            TEXT,                   -- Stk / Std / Pauschal
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  sort            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_doc ON document_items(document_id);
`)

// --- AI + compliance tables (added in the AI-core release) -----------------
// Kept in their own exec block so the schema stays readable. All idempotent.
db.exec(`
-- Append-only accountability trail (DSGVO Art. 5(2) / Art. 30). Every write that
-- touches personal data — and every AI action — leaves a row here.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT,                    -- username, 'scraper', or 'ai'
  action     TEXT NOT NULL,           -- e.g. lead.update, ai.outreach, dsgvo.erase
  entity     TEXT,                    -- 'lead' | 'document' | 'settings' | ...
  entity_id  INTEGER,
  detail     TEXT,                    -- JSON: what changed / which model / why
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

-- Cached AI assessment of a lead (one current row per lead; re-analysis replaces).
CREATE TABLE IF NOT EXISTS lead_ai (
  lead_id        INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  summary        TEXT,                -- one-paragraph read on the prospect
  qualification  TEXT,               -- 'hot' | 'warm' | 'cold' | 'disqualified'
  fit_score      INTEGER,            -- 0..100, model's own confidence in the fit
  next_action    TEXT,               -- the single recommended next step
  talking_points TEXT,               -- JSON string[] for the call/mail
  risk_flags     TEXT,               -- JSON string[]: compliance / quality caveats
  model          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI-drafted outreach. Never auto-sent: a human approves first (UWG §7 + trust).
CREATE TABLE IF NOT EXISTS outreach (
  id          INTEGER PRIMARY KEY,
  lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL DEFAULT 'email',  -- email | letter | call_script
  subject     TEXT,
  body        TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT 'de',
  legal_basis TEXT,                  -- noted lawful basis / UWG rationale
  status      TEXT NOT NULL DEFAULT 'entwurf', -- entwurf | freigegeben | gesendet | verworfen
  model       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outreach_lead ON outreach(lead_id);

-- Lawful-basis / consent ledger per lead (DSGVO Art. 6, Art. 7, Art. 21).
CREATE TABLE IF NOT EXISTS consent (
  id       INTEGER PRIMARY KEY,
  lead_id  INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,            -- e.g. email_marketing, phone_b2b, data_processing
  basis    TEXT NOT NULL,            -- legitimate_interest | consent | contract
  status   TEXT NOT NULL DEFAULT 'active', -- active | withdrawn
  source   TEXT,                     -- how it was obtained (form, call, import)
  note     TEXT,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consent_lead ON consent(lead_id);

-- Copilot conversation threads + messages (the Chat's memory).
CREATE TABLE IF NOT EXISTS ai_threads (
  id         INTEGER PRIMARY KEY,
  title      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id         INTEGER PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,          -- user | assistant | tool
  content    TEXT,
  tool_calls TEXT,                   -- JSON of any tool calls/results, for replay
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_thread ON ai_messages(thread_id);

-- Mahnungen (dunning notices) raised against an overdue invoice.
CREATE TABLE IF NOT EXISTS mahnungen (
  id               INTEGER PRIMARY KEY,
  document_id      INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  level            INTEGER NOT NULL,        -- 0 = Zahlungserinnerung, 1..n = Mahnstufe
  days_overdue     INTEGER NOT NULL,
  interest_cents   INTEGER NOT NULL DEFAULT 0,
  pauschale_cents  INTEGER NOT NULL DEFAULT 0, -- §288(5) BGB B2B-Pauschale
  total_claim_cents INTEGER NOT NULL DEFAULT 0, -- gross + interest + pauschale
  note             TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mahnungen_doc ON mahnungen(document_id);

-- Payments recorded against an invoice. An invoice can be settled in parts, so
-- "paid" is the sum of these rows, not a single flag. Money in integer cents.
CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  paid_on      TEXT NOT NULL,           -- YYYY-MM-DD value date
  method       TEXT,                    -- Überweisung / Bar / PayPal / Lastschrift / ...
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_doc ON payments(document_id);

-- Serienrechnungen: a template + schedule that emits a *draft* invoice each
-- period (a human still finalises it — the in-loop principle holds). Items are
-- stored as JSON; on each run they are copied into a real documents row.
CREATE TABLE IF NOT EXISTS recurring_invoices (
  id             INTEGER PRIMARY KEY,
  client_name    TEXT,
  client_address TEXT,
  client_zip     TEXT,
  client_city    TEXT,
  client_email   TEXT,
  client_type    TEXT NOT NULL DEFAULT 'geschaeft',
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  title          TEXT,
  intro          TEXT,
  notes          TEXT,
  items          TEXT NOT NULL DEFAULT '[]', -- JSON: {description,quantity,unit,unit_price_cents}[]
  small_business INTEGER NOT NULL DEFAULT 1,
  vat_rate       INTEGER NOT NULL DEFAULT 19,
  cadence        TEXT NOT NULL DEFAULT 'monatlich', -- monatlich | quartalsweise | jährlich
  next_run       TEXT NOT NULL,           -- YYYY-MM-DD: next issue date
  active         INTEGER NOT NULL DEFAULT 1,
  last_run       TEXT,                    -- YYYY-MM-DD of the last generated draft
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_active ON recurring_invoices(active, next_run);

-- Lead embeddings for semantic search (vector stored as JSON; small datasets,
-- so a linear cosine scan in JS is plenty — no vector-DB dependency).
CREATE TABLE IF NOT EXISTS lead_embeddings (
  lead_id    INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  vector     TEXT NOT NULL,           -- JSON number[]
  dim        INTEGER NOT NULL,
  model      TEXT,
  source     TEXT,                    -- the text that was embedded (for re-use)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

`)

// --- Integrations + public API + outbound webhooks --------------------------
// The foundation the integration roadmap rides on. All additive (no ALTERs on
// existing tables). Two secret postures, matching the rest of the codebase:
//   • third-party credentials + webhook signing secrets are AES-256-GCM
//     ciphertext (secrets.ts) — reversible because we need them to call out;
//   • public API keys are one-way SHA-256 digests (publicapi/keys.ts) — the
//     token is 192-bit random, so a slow KDF buys nothing and would only DoS
//     the per-request verify. A leaked .db therefore yields neither usable keys
//     nor usable credentials without the env-only SETTINGS_KEY.
db.exec(`
-- One row per configured provider. (category, active) resolves the live adapter
-- per category; only one row per category is active at a time (enforced in code
-- on activate). config is plaintext non-secret JSON; credentials_enc is the
-- AES-256-GCM ciphertext of a JSON blob of the secret fields (or NULL).
CREATE TABLE IF NOT EXISTS integration_connections (
  id              INTEGER PRIMARY KEY,
  category        TEXT NOT NULL,            -- payment | accounting | mail | enrichment | calendar | telephony
  provider        TEXT NOT NULL,           -- registry id, e.g. 'stripe' | 'vies' | 'smtp'
  label           TEXT,                    -- operator-facing name
  config          TEXT NOT NULL DEFAULT '{}', -- plaintext JSON: non-secret config
  credentials_enc TEXT,                    -- AES-256-GCM ciphertext of a JSON secret blob, NULL = none
  active          INTEGER NOT NULL DEFAULT 0, -- 1 = the live adapter for its category
  status          TEXT NOT NULL DEFAULT 'unconfigured', -- unconfigured | ok | error
  status_detail   TEXT,                    -- last probe/connect error (German), NULL when ok
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(category, provider)
);
CREATE INDEX IF NOT EXISTS idx_intconn_active ON integration_connections(category, active);

-- Inbound provider-webhook receipts (Stripe events, etc.), append-only for
-- idempotency + audit. external_id is the provider's own event id so a
-- redelivered webhook is applied once (UNIQUE). signature_ok records whether the
-- HMAC check passed BEFORE any side effect ran.
CREATE TABLE IF NOT EXISTS integration_events (
  id           INTEGER PRIMARY KEY,
  category     TEXT NOT NULL,
  provider     TEXT NOT NULL,
  external_id  TEXT,                       -- provider's event id (idempotency); NULL if none
  type         TEXT,                       -- provider event type, e.g. 'checkout.session.completed'
  payload      TEXT NOT NULL,              -- raw JSON body as received
  signature_ok INTEGER NOT NULL DEFAULT 0,
  processed    INTEGER NOT NULL DEFAULT 0,
  result       TEXT,                       -- JSON: what the receiver did (e.g. {payment_id})
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, external_id)
);
CREATE INDEX IF NOT EXISTS idx_intevt_provider ON integration_events(provider, received_at DESC);

-- Scoped public API keys. The full key 'ol_<prefix>_<secret>' is shown ONCE on
-- create and never stored; key_hash is the SHA-256 hex digest of the full token,
-- prefix is the public lookup segment (indexed). Revoke = set revoked_at.
CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY,
  name         TEXT,                       -- operator label, e.g. 'Zapier'
  prefix       TEXT NOT NULL UNIQUE,       -- public lookup segment (8 hex chars)
  key_hash     TEXT NOT NULL,              -- SHA-256 hex of the full token
  scopes       TEXT NOT NULL DEFAULT '',   -- CSV: leads:read,leads:write,documents:read,documents:write
  created_by   TEXT,                       -- username who minted it
  last_used_at TEXT,                       -- updated on use (throttled in code)
  revoked_at   TEXT,                       -- non-NULL = revoked, fail closed
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apikeys_prefix ON api_keys(prefix);

-- Outbound webhook subscriptions. secret_enc is the per-endpoint signing secret
-- encrypted at rest; the plaintext is shown once on create and used to HMAC-sign
-- deliveries. events is a CSV of subscribed event names (or '*' for all).
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          INTEGER PRIMARY KEY,
  url         TEXT NOT NULL,               -- target https URL (SSRF-guarded at dispatch)
  secret_enc  TEXT NOT NULL,               -- AES-256-GCM ciphertext of the signing secret
  events      TEXT NOT NULL DEFAULT '*',   -- CSV of event names, or '*'
  active      INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (endpoint, event) attempt-stream. The dispatcher worker claims
-- rows where status='pending' AND next_attempt_at<=now, SSRF-guards + HMAC-signs
-- + POSTs with a timeout, and on failure schedules exponential backoff via
-- next_attempt_at, capping attempts then status='failed' (dead-letter). payload
-- is the exact signed body so redelivery re-sends byte-identical content.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY,
  endpoint_id     INTEGER NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         TEXT NOT NULL,           -- exact JSON body that is/was signed
  attempts        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  response_code   INTEGER,                 -- last HTTP status (NULL = network error/timeout)
  last_error      TEXT,                    -- last failure detail (truncated, no secrets)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_whdeliv_due ON webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_whdeliv_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

-- OAuth2 token store for connections that authenticate via OAuth (Google,
-- Microsoft). Access + refresh tokens are AES-256-GCM ciphertext (secrets.ts) —
-- never plaintext. One row per connection.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                INTEGER PRIMARY KEY,
  connection_id     INTEGER NOT NULL UNIQUE REFERENCES integration_connections(id) ON DELETE CASCADE,
  account_email     TEXT,                  -- the connected account (for the UI)
  access_token_enc  TEXT,                  -- AES-256-GCM ciphertext
  refresh_token_enc TEXT,                  -- AES-256-GCM ciphertext
  expires_at        INTEGER,               -- epoch seconds when the access token expires
  scope             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-use CSRF state for the OAuth authorize→callback round-trip. The
-- redirect_uri is stored so the token exchange binds it byte-for-byte. Rows are
-- deleted on callback and pruned after a short TTL.
CREATE TABLE IF NOT EXISTS oauth_pending (
  state         TEXT PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  redirect_uri  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// --- Ausgaben (expenses / Belege) -------------------------------------------
// The cost side of the books, the counterpart to the documents (revenue) table.
// gross_cents is what was actually paid (Bruttobetrag, as printed on the
// receipt); net_cents + vat_cents (Vorsteuer) are derived from gross + vat_rate
// on write so SUM() reporting stays trivial. The receipt scan is stored INLINE
// as a BLOB so the single-file `VACUUM INTO` backup carries it too — no separate
// file store to back up, lose, or get out of sync (GoBD wants the Beleg retained
// alongside the booking). Receipts are small (a PDF/photo), so this is fine.
db.exec(`
CREATE TABLE IF NOT EXISTS expenses (
  id             INTEGER PRIMARY KEY,
  vendor         TEXT,                       -- Lieferant / Zahlungsempfänger
  category       TEXT NOT NULL DEFAULT 'sonstiges',
  description    TEXT,                       -- Verwendungszweck / Beschreibung
  expense_date   TEXT NOT NULL,              -- Belegdatum YYYY-MM-DD
  paid_on        TEXT,                       -- Bezahlt am YYYY-MM-DD (NULL = offen)
  gross_cents    INTEGER NOT NULL DEFAULT 0, -- Bruttobetrag (gezahlt)
  vat_rate       INTEGER NOT NULL DEFAULT 19,-- USt-Satz % (0 / 7 / 19)
  net_cents      INTEGER NOT NULL DEFAULT 0, -- abgeleitet aus gross + vat_rate
  vat_cents      INTEGER NOT NULL DEFAULT 0, -- Vorsteuer, abgeleitet
  payment_method TEXT,                       -- Überweisung / Karte / Bar / ...
  note           TEXT,
  -- Beleg (receipt scan), stored inline. NULL = kein Beleg hinterlegt.
  receipt_data   BLOB,
  receipt_name   TEXT,
  receipt_mime   TEXT,
  receipt_size   INTEGER,
  created_by     TEXT,                       -- username who recorded it
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
`)

// Basiszinssatz (%) used for §288 BGB Verzugszinsen (configurable; changes
// each Jan/Jul). B2B default rate = base + 9 pp. Added after the AI release.
try {
  db.exec('ALTER TABLE settings ADD COLUMN verzug_base_rate REAL NOT NULL DEFAULT 1.27')
} catch {
  // column already exists
}

// DATEV/GoBD export account numbers (Steuerberater handoff). SKR03 defaults.
// datev_bank_account is the Gegenkonto for expense bookings (Aufwand an Bank);
// the Konto comes from the expense category's SKR03 account. Default 1200 (Bank).
for (const col of [
  'datev_revenue_account TEXT',
  'datev_debitor_account TEXT',
  'datev_bank_account TEXT',
]) {
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

// Käuferreferenz / Leitweg-ID (EN 16931 BT-10) — required for B2G / XRechnung.
try {
  db.exec('ALTER TABLE documents ADD COLUMN buyer_reference TEXT')
} catch {
  // column already exists
}

// Debtor type (Geschäft/Privat). Drives the §288 BGB B2B-only Pauschale in
// dunning. Defaults to 'geschaeft' so existing invoices keep today's behaviour.
try {
  db.exec("ALTER TABLE documents ADD COLUMN client_type TEXT NOT NULL DEFAULT 'geschaeft'")
} catch {
  // column already exists
}

// Client USt-IdNr. (EU VAT id) — validated via the active accounting adapter (VIES).
try {
  db.exec('ALTER TABLE documents ADD COLUMN client_vat_id TEXT')
} catch {
  // column already exists
}

// Opt-in for attaching a hosted payment link (Stripe/GoCardless) when the
// invoice is e-mailed. Lives on both the document (per-invoice override) and the
// recurring template (carried onto each generated draft). Default 1 = offer the
// link, matching the prior behaviour where every invoice e-mail carried one when
// a payment provider was active.
for (const stmt of [
  'ALTER TABLE documents ADD COLUMN include_payment_link INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE recurring_invoices ADD COLUMN include_payment_link INTEGER NOT NULL DEFAULT 1',
]) {
  try {
    db.exec(stmt)
  } catch {
    // column already exists
  }
}

// --- migrations for existing databases (idempotent) ---
// tags: free-form, comma-separated labels per lead (e.g. "vip,umbau").
try {
  db.exec('ALTER TABLE leads ADD COLUMN tags TEXT')
} catch {
  // column already exists
}

// Drop the retired follow-up date column (replaced by the "rückruf" pipeline
// stage). Fails harmlessly on fresh databases that never had the column.
try {
  db.exec('ALTER TABLE leads DROP COLUMN recontact_at')
} catch {
  // column already gone
}

// Scraper config columns on the settings table (added after the first release).
for (const col of [
  'scraper_trades TEXT',
  'scraper_towns TEXT',
  'scraper_region TEXT', // region phrase for the discovery prompt (was hardcoded)
  'scraper_min_score INTEGER',
  'scraper_max_pairs INTEGER',
  'scraper_per_pair INTEGER',
]) {
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

// Operator-editable AI provider + SMTP connection, settable from the Settings UI
// instead of .env. Plain config is stored as-is; the two secrets (AI key, SMTP
// password) are stored ENCRYPTED — see secrets.ts. Any value here overrides the
// matching .env var; .env stays the fallback. Bootstrap secrets (SESSION_SECRET,
// SERVICE_TOKEN) are NOT here on purpose: the app needs them before it can read
// this table.
for (const col of [
  'ai_base_url TEXT',
  'ai_model TEXT',
  'ai_label TEXT',
  'ai_api_key_enc TEXT', // AES-256-GCM ciphertext, never plaintext
  'smtp_host TEXT',
  'smtp_port INTEGER',
  'smtp_user TEXT',
  'smtp_pass_enc TEXT', // AES-256-GCM ciphertext, never plaintext
  'smtp_secure INTEGER',
  'smtp_from TEXT',
  // Lead-discovery model + API key (the scraper inherits these when run from the
  // UI). Model is plain; the key is encrypted like the other secrets.
  'scraper_model TEXT',
  'scraper_ai_api_key_enc TEXT', // AES-256-GCM ciphertext, never plaintext
]) {
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

export interface UserRow {
  id: number
  username: string
  password_hash: string
  role: string
  created_at: string
}

export interface LeadRow {
  id: number
  domain: string | null
  company: string | null
  trade: string | null
  city: string | null
  website: string | null
  phone: string | null
  email: string | null
  mobile_friendly: number | null
  tech: string | null
  staleness_signal: string | null
  score: number
  priority: string
  why_lead: string | null
  stage: string
  notes: string | null
  assigned_to: string | null
  tags: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface LeadEventRow {
  id: number
  lead_id: number
  at: string
  actor: string | null
  type: string
  from_stage: string | null
  to_stage: string | null
  body: string | null
}

export interface SettingsRow {
  id: number
  business_name: string | null
  owner: string | null
  address: string | null
  zip: string | null
  city: string | null
  email: string | null
  phone: string | null
  website: string | null
  tax_id: string | null
  iban: string | null
  bic: string | null
  bank: string | null
  small_business: number
  vat_rate: number
  payment_terms: number
  rechnung_prefix: string
  rechnung_next: number
  angebot_prefix: string
  angebot_next: number
  scraper_trades: string | null
  scraper_towns: string | null
  scraper_region: string | null
  scraper_min_score: number | null
  scraper_max_pairs: number | null
  scraper_per_pair: number | null
  verzug_base_rate: number
  datev_revenue_account: string | null
  datev_debitor_account: string | null
  datev_bank_account: string | null
  // Operator-editable connection config (Settings UI). Optional: added by a late
  // migration, and the *_enc columns hold ciphertext (see secrets.ts), so they
  // are never sent to the client raw — the API redacts them.
  ai_base_url?: string | null
  ai_model?: string | null
  ai_label?: string | null
  ai_api_key_enc?: string | null
  smtp_host?: string | null
  smtp_port?: number | null
  smtp_user?: string | null
  smtp_pass_enc?: string | null
  smtp_secure?: number | null
  smtp_from?: string | null
  scraper_model?: string | null
  scraper_ai_api_key_enc?: string | null
}

export interface MahnungRow {
  id: number
  document_id: number
  level: number
  days_overdue: number
  interest_cents: number
  pauschale_cents: number
  total_claim_cents: number
  note: string | null
  created_at: string
}

export interface DocumentRow {
  id: number
  kind: string
  number: string | null
  lead_id: number | null
  client_name: string | null
  client_address: string | null
  client_zip: string | null
  client_city: string | null
  client_email: string | null
  title: string | null
  intro: string | null
  notes: string | null
  status: string
  issue_date: string | null
  due_date: string | null
  small_business: number
  vat_rate: number
  buyer_reference: string | null
  client_type: string
  client_vat_id: string | null
  include_payment_link: number
  created_at: string
  updated_at: string
}

export interface PaymentRow {
  id: number
  document_id: number
  amount_cents: number
  paid_on: string
  method: string | null
  note: string | null
  created_at: string
}

export interface ExpenseRow {
  id: number
  vendor: string | null
  category: string
  description: string | null
  expense_date: string
  paid_on: string | null
  gross_cents: number
  vat_rate: number
  net_cents: number
  vat_cents: number
  payment_method: string | null
  note: string | null
  receipt_data: Uint8Array | null
  receipt_name: string | null
  receipt_mime: string | null
  receipt_size: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface RecurringInvoiceRow {
  id: number
  client_name: string | null
  client_address: string | null
  client_zip: string | null
  client_city: string | null
  client_email: string | null
  client_type: string
  lead_id: number | null
  title: string | null
  intro: string | null
  notes: string | null
  items: string // JSON
  small_business: number
  vat_rate: number
  cadence: string
  next_run: string
  active: number
  include_payment_link: number
  last_run: string | null
  created_at: string
  updated_at: string
}

export interface DocumentItemRow {
  id: number
  document_id: number
  description: string | null
  quantity: number
  unit: string | null
  unit_price_cents: number
  sort: number
}

export interface AuditRow {
  id: number
  at: string
  actor: string | null
  action: string
  entity: string | null
  entity_id: number | null
  detail: string | null
  ip: string | null
}

export interface LeadAiRow {
  lead_id: number
  summary: string | null
  qualification: string | null
  fit_score: number | null
  next_action: string | null
  talking_points: string | null
  risk_flags: string | null
  model: string | null
  created_at: string
}

export interface OutreachRow {
  id: number
  lead_id: number
  channel: string
  subject: string | null
  body: string
  language: string
  legal_basis: string | null
  status: string
  model: string | null
  created_at: string
  updated_at: string
}

export interface ConsentRow {
  id: number
  lead_id: number
  type: string
  basis: string
  status: string
  source: string | null
  note: string | null
  at: string
}

export interface AiThreadRow {
  id: number
  title: string | null
  created_at: string
  updated_at: string
}

export interface AiMessageRow {
  id: number
  thread_id: number
  role: string
  content: string | null
  tool_calls: string | null
  created_at: string
}

export interface IntegrationConnectionRow {
  id: number
  category: string
  provider: string
  label: string | null
  config: string
  credentials_enc: string | null
  active: number
  status: string
  status_detail: string | null
  created_at: string
  updated_at: string
}

export interface IntegrationEventRow {
  id: number
  category: string
  provider: string
  external_id: string | null
  type: string | null
  payload: string
  signature_ok: number
  processed: number
  result: string | null
  received_at: string
}

export interface ApiKeyRow {
  id: number
  name: string | null
  prefix: string
  key_hash: string
  scopes: string
  created_by: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface WebhookEndpointRow {
  id: number
  url: string
  secret_enc: string
  events: string
  active: number
  description: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface WebhookDeliveryRow {
  id: number
  endpoint_id: number
  event: string
  payload: string
  attempts: number
  status: string
  next_attempt_at: string
  response_code: number | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface OAuthTokenRow {
  id: number
  connection_id: number
  account_email: string | null
  access_token_enc: string | null
  refresh_token_enc: string | null
  expires_at: number | null
  scope: string | null
  created_at: string
  updated_at: string
}

export interface OAuthPendingRow {
  state: string
  connection_id: number
  redirect_uri: string
  created_at: string
}

/** Normalise a URL or hostname to a bare registrable-ish domain for dedupe. */
export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null
  let s = String(input).trim().toLowerCase()
  if (!s) return null
  if (!/^https?:\/\//.test(s)) s = 'http://' + s
  try {
    const host = new URL(s).hostname.replace(/^www\./, '')
    return host || null
  } catch {
    return null
  }
}
