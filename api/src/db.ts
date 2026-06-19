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
  'interessiert',
  'angebot',
  'gewonnen',
  'verloren',
] as const
export type Stage = (typeof STAGES)[number]

export const PRIORITIES = ['hoch', 'mittel', 'niedrig'] as const
export type Priority = (typeof PRIORITIES)[number]

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
  -- Sonnet scraper config (newline/comma-separated lists; NULL = use defaults).
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

-- Copilot conversation threads + messages (the AI cockpit's memory).
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

// Basiszinssatz (%) used for §288 BGB Verzugszinsen (configurable; changes
// each Jan/Jul). B2B default rate = base + 9 pp. Added after the AI release.
try {
  db.exec('ALTER TABLE settings ADD COLUMN verzug_base_rate REAL NOT NULL DEFAULT 1.27')
} catch {
  // column already exists
}

// DATEV/GoBD export account numbers (Steuerberater handoff). SKR03 defaults.
for (const col of ['datev_revenue_account TEXT', 'datev_debitor_account TEXT']) {
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

// --- migrations for existing databases (idempotent) ---
// recontact_at: optional follow-up / callback date (YYYY-MM-DD).
try {
  db.exec('ALTER TABLE leads ADD COLUMN recontact_at TEXT')
} catch {
  // column already exists
}

// Scraper config columns on the settings table (added after the first release).
for (const col of [
  'scraper_trades TEXT',
  'scraper_towns TEXT',
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
  recontact_at: string | null
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
  scraper_min_score: number | null
  scraper_max_pairs: number | null
  scraper_per_pair: number | null
  verzug_base_rate: number
  datev_revenue_account: string | null
  datev_debitor_account: string | null
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
