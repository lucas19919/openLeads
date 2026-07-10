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

// --- Verträge (contracts / AGB) ---
// A contract (Vertrag) is a standalone agreement with a client: parties, scope,
// remuneration, term, and the operator's AGB incorporated by reference. The AGB
// text is *snapshotted* onto the contract when it is finalised, because the terms
// in force at signature are the ones that govern — editing the standard AGB later
// must not retroactively change an issued contract. `id` is the stable key sent to
// the client and stored on rows; relabel freely, keep ids stable.
export const CONTRACT_TYPES = [
  { id: 'dienstvertrag', label: 'Dienstleistungsvertrag' },
  { id: 'werkvertrag', label: 'Werkvertrag' },
  { id: 'wartungsvertrag', label: 'Wartungs-/Servicevertrag' },
  { id: 'auftragsbestaetigung', label: 'Auftragsbestätigung' },
  { id: 'rahmenvertrag', label: 'Rahmenvertrag' },
  { id: 'avv', label: 'Auftragsverarbeitung (Art. 28 DSGVO)' },
  { id: 'sonstiges', label: 'Sonstiger Vertrag' },
] as const
export type ContractType = (typeof CONTRACT_TYPES)[number]['id']

// Lifecycle: entwurf → versendet (number assigned, AGB frozen) → aktiv (gegen-
// gezeichnet) → beendet (gekündigt/abgelaufen); abgelehnt is the dead end.
export const CONTRACT_STATUSES = ['entwurf', 'versendet', 'aktiv', 'beendet', 'abgelehnt'] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Server-side sessions. Only a SHA-256 hash of the bearer token is stored, so a
-- leaked DB/backup cannot be replayed as a login. Rows are the source of truth:
-- deleting one revokes the session immediately (logout, password reset, user
-- deletion via the CASCADE).
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                -- ISO-8601 UTC
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

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
  source           TEXT DEFAULT 'manual',  -- manual / import / empfehlung / ...
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);

CREATE TABLE IF NOT EXISTS lead_events (
  id         INTEGER PRIMARY KEY,
  lead_id    INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  at         TEXT NOT NULL DEFAULT (datetime('now')),
  actor      TEXT,                          -- username or 'ai'
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
  angebot_next    INTEGER NOT NULL DEFAULT 1
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
  actor      TEXT,                    -- username or 'ai'
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

// --- Abonnements (recurring outgoing subscriptions the business PAYS) --------
// The cost-side counterpart to recurring_invoices: things you pay on a cadence
// (SaaS, hosting, insurance, memberships). Unlike expenses these are forward-
// looking — `next_renewal` is the upcoming charge, and `amount_cents` is the
// gross per period. They are NOT bookkeeping records; when one actually charges
// you book the real Beleg under Ausgaben. The category reuses EXPENSE_CATEGORIES
// ids so the cost lands in the same SKR03 bucket once booked.
db.exec(`
CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY,
  vendor         TEXT NOT NULL,              -- Anbieter, z. B. "Anthropic (Claude)"
  description    TEXT,                       -- Tarif / Verwendungszweck
  category       TEXT NOT NULL DEFAULT 'software', -- EXPENSE_CATEGORIES id
  amount_cents   INTEGER NOT NULL DEFAULT 0, -- Bruttobetrag je Turnus
  vat_rate       INTEGER NOT NULL DEFAULT 19,
  cadence        TEXT NOT NULL DEFAULT 'monatlich', -- monatlich | quartalsweise | jährlich
  next_renewal   TEXT,                       -- YYYY-MM-DD nächste Abbuchung / Verlängerung
  payment_method TEXT,                       -- Karte / Lastschrift / PayPal / ...
  active         INTEGER NOT NULL DEFAULT 1, -- 0 = gekündigt / pausiert
  note           TEXT,
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_active ON subscriptions(active, next_renewal);
`)

// --- Verträge (contracts) ---------------------------------------------------
// Number is NULL while a draft; assigned gaplessly from the settings counter on
// finalise (same posture as documents). agb_text is the AGB snapshot frozen at
// finalise. value_cents is the headline contract value (net); small_business /
// vat_rate snapshot the tax posture for displaying the gross figure on the PDF.
db.exec(`
CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY,
  number         TEXT UNIQUE,             -- e.g. V-2026-0007 (NULL until finalised)
  type           TEXT NOT NULL DEFAULT 'dienstvertrag',
  lead_id        INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  document_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL, -- originating Angebot/Rechnung
  client_name    TEXT,
  client_address TEXT,
  client_zip     TEXT,
  client_city    TEXT,
  client_email   TEXT,
  client_type    TEXT NOT NULL DEFAULT 'geschaeft',
  title          TEXT,
  intro          TEXT,                    -- Präambel
  body           TEXT,                    -- Vertragsgegenstand / Leistungsbeschreibung
  agb_text       TEXT,                    -- AGB snapshot, frozen on finalise (NULL while draft)
  value_cents    INTEGER NOT NULL DEFAULT 0, -- Auftragswert (netto)
  small_business INTEGER NOT NULL DEFAULT 1,
  vat_rate       INTEGER NOT NULL DEFAULT 19,
  payment_terms  TEXT,                    -- Vergütung / Zahlungsmodalitäten (Freitext)
  start_date     TEXT,                    -- Laufzeitbeginn YYYY-MM-DD
  end_date       TEXT,                    -- Laufzeitende YYYY-MM-DD (NULL = unbefristet)
  notice_period  TEXT,                    -- Kündigungsfrist (Freitext)
  status         TEXT NOT NULL DEFAULT 'entwurf',
  issue_date     TEXT,                    -- set on finalise
  signed_at      TEXT,                    -- date the contract was countersigned/accepted
  signed_by      TEXT,                    -- name of the client's signatory
  signed_note    TEXT,                    -- how it was accepted (in person, e-mail, …)
  notes          TEXT,                    -- internal, never on the PDF
  created_by     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_lead ON contracts(lead_id);
`)

// Signed-document store: the countersigned contract the client returns, kept inline
// as a BLOB (like expense receipts) so the single-file VACUUM INTO backup carries it
// — no separate file store to lose or get out of sync (GoBD wants the signed paper
// retained with the record). Added by a late migration; idempotent.
for (const col of [
  'signed_doc_data BLOB',
  'signed_doc_name TEXT',
  'signed_doc_mime TEXT',
  'signed_doc_size INTEGER',
]) {
  try {
    db.exec(`ALTER TABLE contracts ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

// Same signed/returned-copy store on documents (Angebot/Rechnung) — so every paper
// the operator issues can keep its signed or final scan with the record.
for (const col of [
  'signed_doc_data BLOB',
  'signed_doc_name TEXT',
  'signed_doc_mime TEXT',
  'signed_doc_size INTEGER',
]) {
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

// AGB text + contract numbering live on the single-row settings table (added by a
// late migration so existing databases pick them up). Constant defaults keep the
// ADD COLUMN NOT NULL valid on SQLite.
for (const col of [
  'agb_text TEXT',
  "contract_prefix TEXT NOT NULL DEFAULT 'V-'",
  'contract_next INTEGER NOT NULL DEFAULT 1',
  // Append the AGB as a final page to Angebot/Rechnung PDFs (0 = off).
  'agb_attach_documents INTEGER NOT NULL DEFAULT 0',
]) {
  try {
    db.exec(`ALTER TABLE settings ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

// --- Leistungskatalog (services/products catalog) ---------------------------
// Reusable line items so an Angebot / Rechnung / Serie / Vertrag position can be
// picked instead of retyped. Items are copied BY VALUE into documents (no FK), so
// editing or deleting a catalog item never mutates an already-written invoice.
// Money in integer cents, like everywhere else.
db.exec(`
CREATE TABLE IF NOT EXISTS catalog_items (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,            -- short label shown in the picker
  description      TEXT,                     -- the line text put on the document (defaults to name)
  unit             TEXT,                     -- Std / Stk / Pauschal / Monat …
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  vat_rate         INTEGER NOT NULL DEFAULT 19,
  sku              TEXT,                     -- Artikelnummer (optional)
  category         TEXT,                     -- optional grouping
  active           INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog_items(active, sort, name);
`)

// --- Kunden (customer registry) ---------------------------------------------
// A central customer list so a client is maintained once and prefilled into
// invoices, quotes, contracts and recurring templates — instead of retyping. This
// is additive (a new table + nullable customer_id links); the flat lead row is
// untouched. Documents copy the client fields BY VALUE at create time, so editing
// a customer later never rewrites an issued document.
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,            -- Firma oder Name
  contact_name  TEXT,                     -- Ansprechpartner
  address       TEXT,
  zip           TEXT,
  city          TEXT,
  email         TEXT,
  phone         TEXT,
  vat_id        TEXT,                      -- USt-IdNr.
  client_type   TEXT NOT NULL DEFAULT 'geschaeft',
  payment_terms INTEGER,                   -- Zahlungsziel override (NULL = settings default)
  lead_id       INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  notes         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(active, name);
`)

// Link the billing entities back to a customer (nullable, additive). Set when a
// document/contract/template is created from a customer; the client_* snapshot
// still carries the address so the link is convenience, not a dependency.
for (const stmt of [
  'ALTER TABLE documents ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL',
  'ALTER TABLE contracts ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL',
  'ALTER TABLE recurring_invoices ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL',
]) {
  try {
    db.exec(stmt)
  } catch {
    // column already exists
  }
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

// Record of an accounting-system push (lexoffice/sevDesk). Once external_id is
// set, a re-push is refused so the same invoice is never double-booked. Combined
// with the adapter's idempotency key (lexoffice), this also covers the
// timeout-but-actually-succeeded case.
for (const col of [
  'accounting_provider TEXT',
  'accounting_external_id TEXT',
  'accounting_pushed_at TEXT',
]) {
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN ${col}`)
  } catch {
    // column already exists
  }
}

// Debtor type (Geschäft/Privat). Snapshotted on the invoice so the B2B/B2C tax
// posture is fixed. Defaults to 'geschaeft' so existing invoices keep today's behaviour.
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

// One-time seeding marker (see seed.ts): whether the isarwebsites defaults
// (Leistungskatalog etc.) were already offered to this database.
try {
  db.exec('ALTER TABLE settings ADD COLUMN defaults_seeded INTEGER NOT NULL DEFAULT 0')
} catch {
  // column already exists
}

// The lead scraper was removed — drop its config columns from databases that
// still carry them. Fails harmlessly on fresh databases.
for (const col of [
  'scraper_trades',
  'scraper_towns',
  'scraper_region',
  'scraper_min_score',
  'scraper_max_pairs',
  'scraper_per_pair',
  'scraper_ai_api_key_enc',
]) {
  try {
    db.exec(`ALTER TABLE settings DROP COLUMN ${col}`)
  } catch {
    // column already gone
  }
}

// Operator-editable AI provider + SMTP connection, settable from the Settings UI
// instead of .env. Plain config is stored as-is; the two secrets (AI key, SMTP
// password) are stored ENCRYPTED — see secrets.ts. Any value here overrides the
// matching .env var; .env stays the fallback. The encryption key (SETTINGS_KEY)
// is NOT here on purpose: it must never live next to the ciphertext.
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
  // AGB text + contract numbering (added by a late migration).
  agb_text?: string | null
  contract_prefix?: string
  contract_next?: number
  agb_attach_documents?: number
}

export interface DocumentRow {
  id: number
  kind: string
  number: string | null
  lead_id: number | null
  customer_id: number | null
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
  accounting_provider: string | null
  accounting_external_id: string | null
  accounting_pushed_at: string | null
  created_at: string
  updated_at: string
  // Signed/returned-copy store. The BLOB never leaves the server raw — getDocument
  // strips it and exposes has_signed_doc instead.
  signed_doc_data?: Uint8Array | null
  signed_doc_name?: string | null
  signed_doc_mime?: string | null
  signed_doc_size?: number | null
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

export interface ContractRow {
  id: number
  number: string | null
  type: string
  lead_id: number | null
  customer_id: number | null
  document_id: number | null
  client_name: string | null
  client_address: string | null
  client_zip: string | null
  client_city: string | null
  client_email: string | null
  client_type: string
  title: string | null
  intro: string | null
  body: string | null
  agb_text: string | null
  value_cents: number
  small_business: number
  vat_rate: number
  payment_terms: string | null
  start_date: string | null
  end_date: string | null
  notice_period: string | null
  status: string
  issue_date: string | null
  signed_at: string | null
  signed_by: string | null
  signed_note: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  // Signed-document store (added by a late migration). The BLOB never leaves the
  // server raw — getContract strips it and exposes has_signed_doc instead.
  signed_doc_data?: Uint8Array | null
  signed_doc_name?: string | null
  signed_doc_mime?: string | null
  signed_doc_size?: number | null
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

export interface SubscriptionRow {
  id: number
  vendor: string
  description: string | null
  category: string
  amount_cents: number
  vat_rate: number
  cadence: string
  next_renewal: string | null
  payment_method: string | null
  active: number
  note: string | null
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
  customer_id: number | null
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

export interface CustomerRow {
  id: number
  name: string
  contact_name: string | null
  address: string | null
  zip: string | null
  city: string | null
  email: string | null
  phone: string | null
  vat_id: string | null
  client_type: string
  payment_terms: number | null
  lead_id: number | null
  notes: string | null
  active: number
  created_at: string
  updated_at: string
}

export interface CatalogItemRow {
  id: number
  name: string
  description: string | null
  unit: string | null
  unit_price_cents: number
  vat_rate: number
  sku: string | null
  category: string | null
  active: number
  sort: number
  notes: string | null
  created_at: string
  updated_at: string
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
