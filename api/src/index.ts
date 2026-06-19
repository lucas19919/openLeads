import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import {
  db,
  STAGES,
  PRIORITIES,
  DOC_KINDS,
  DOC_STATUSES,
  normalizeDomain,
  type LeadRow,
  type UserRow,
  type DocumentRow,
} from './db'
import {
  verifyPassword,
  createSession,
  readSession,
  SESSION_TTL_S,
} from './auth'
import { parseWorkbookBuffer } from './import'
import {
  getSettings,
  getDocument,
  replaceItems,
  assignNumber,
  type DocItemInput,
} from './documents'
import { renderDocumentPdf, pdfFilename } from './pdf'
import { renderMahnungPdf, mahnungPdfFilename } from './mahnungPdf'
import { validateInvoice } from './validate'
import { listOverdue, computeDunning, levelLabel } from './dunning'
import { snapshot, snapshotFilename } from './backup'
import { finalisedInvoices, invoicesCsv, datevCsv, exportFilename } from './export'
import { audit } from './audit'
import { registerAiRoutes } from './ai/router'
import { registerDsgvoRoutes } from './dsgvo'

type Vars = { user: Pick<UserRow, 'id' | 'username' | 'role'> }
const app = new Hono<{ Variables: Vars }>()

const isProd = process.env.NODE_ENV === 'production'
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173'
const SERVICE_TOKEN = process.env.SERVICE_TOKEN ?? ''
const COOKIE = 'sid'

app.use('/api/*', cors({ origin: WEB_ORIGIN, credentials: true }))

// --- middleware -----------------------------------------------------------

async function requireAuth(c: Context<{ Variables: Vars }>, next: Next) {
  const sess = readSession(getCookie(c, COOKIE))
  if (!sess) return c.json({ error: 'unauthorized' }, 401)
  const user = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(sess.uid) as unknown as Vars['user'] | undefined
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  c.set('user', user)
  await next()
}

// POST /api/leads accepts either a logged-in session OR the scraper's bearer token.
async function requireServiceOrAuth(c: Context<{ Variables: Vars }>, next: Next) {
  const auth = c.req.header('authorization')
  if (SERVICE_TOKEN && auth === `Bearer ${SERVICE_TOKEN}`) {
    c.set('user', { id: 0, username: 'scraper', role: 'service' })
    return next()
  }
  return requireAuth(c, next)
}

// --- auth routes ----------------------------------------------------------

app.post('/api/login', async (c) => {
  const { username, password } = await c.req.json().catch(() => ({}))
  if (!username || !password) return c.json({ error: 'missing credentials' }, 400)
  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as unknown as UserRow | undefined
  if (!user || !verifyPassword(password, user.password_hash)) {
    return c.json({ error: 'invalid credentials' }, 401)
  }
  setCookie(c, COOKIE, createSession(user.id), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isProd,
    path: '/',
    maxAge: SESSION_TTL_S,
  })
  return c.json({ user: { id: user.id, username: user.username, role: user.role } })
})

app.post('/api/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
})

app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }))

app.get('/api/config', (c) =>
  c.json({
    stages: STAGES,
    priorities: PRIORITIES,
    docKinds: DOC_KINDS,
    docStatuses: DOC_STATUSES,
  }),
)

// --- leads ----------------------------------------------------------------

app.get('/api/leads', requireAuth, (c) => {
  const stage = c.req.query('stage')
  const q = c.req.query('q')?.trim()
  const clauses: string[] = []
  const params: string[] = []
  if (stage && STAGES.includes(stage as never)) {
    clauses.push('stage = ?')
    params.push(stage)
  }
  if (q) {
    clauses.push('(company LIKE ? OR city LIKE ? OR trade LIKE ? OR website LIKE ?)')
    const like = `%${q}%`
    params.push(like, like, like, like)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT * FROM leads ${where} ORDER BY score DESC, created_at DESC`,
    )
    .all(...params) as unknown as LeadRow[]
  return c.json({ leads: rows })
})

app.get('/api/leads/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as
    | LeadRow
    | undefined
  if (!lead) return c.json({ error: 'not found' }, 404)
  const events = db
    .prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC')
    .all(id)
  return c.json({ lead, events })
})

// Insert one lead. Dedupes by registrable domain so already-known businesses
// are never re-added. Shared by the create endpoint and the xlsx import.
function insertLead(b: Record<string, unknown>, actor: string): { id: number; deduped?: boolean } {
  const domain = normalizeDomain((b.domain as string) ?? (b.website as string))
  if (domain) {
    const existing = db.prepare('SELECT id FROM leads WHERE domain = ?').get(domain) as unknown as
      | { id: number }
      | undefined
    if (existing) return { id: existing.id, deduped: true }
  }
  const info = db
    .prepare(
      `INSERT INTO leads
        (domain, company, trade, city, website, phone, email, mobile_friendly,
         tech, staleness_signal, score, priority, why_lead, stage, source)
       VALUES
        (@domain, @company, @trade, @city, @website, @phone, @email, @mobile_friendly,
         @tech, @staleness_signal, @score, @priority, @why_lead, @stage, @source)`,
    )
    .run({
      domain,
      company: (b.company as string) ?? null,
      trade: (b.trade as string) ?? null,
      city: (b.city as string) ?? null,
      website: (b.website as string) ?? null,
      phone: (b.phone as string) ?? null,
      email: (b.email as string) ?? null,
      mobile_friendly:
        b.mobile_friendly === undefined || b.mobile_friendly === null
          ? null
          : b.mobile_friendly
            ? 1
            : 0,
      tech: (b.tech as string) ?? null,
      staleness_signal: (b.staleness_signal as string) ?? null,
      score: Number(b.score ?? 0),
      priority: PRIORITIES.includes(b.priority as never) ? (b.priority as string) : 'mittel',
      why_lead: (b.why_lead as string) ?? null,
      stage: 'neu',
      source: (b.source as string) ?? 'manual',
    })
  const id = Number(info.lastInsertRowid)
  db.prepare(
    `INSERT INTO lead_events (lead_id, actor, type, to_stage, body)
     VALUES (?, ?, 'created', 'neu', ?)`,
  ).run(id, actor, `Quelle: ${(b.source as string) ?? 'manual'}`)
  return { id }
}

// Create a lead. Used by the scraper (service token) and manual adds.
app.post('/api/leads', requireServiceOrAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = insertLead(b, c.get('user').username)
  return r.deduped ? c.json({ deduped: true, id: r.id }) : c.json({ id: r.id }, 201)
})

// Import an .xlsx upload. Auto-detects the header row and maps columns, then
// inserts each row (dedupe applies). multipart/form-data field name: "file".
app.post('/api/leads/import', requireAuth, async (c) => {
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
  let parsed
  try {
    parsed = await parseWorkbookBuffer(Buffer.from(await file.arrayBuffer()))
  } catch {
    return c.json({ error: 'Datei konnte nicht gelesen werden (.xlsx erwartet).' }, 400)
  }
  if (parsed.leads.length === 0) {
    return c.json(
      { error: 'Keine Lead-Zeilen erkannt — Spalten wie Firma/Website/Telefon nötig.' },
      422,
    )
  }
  const actor = c.get('user').username
  let imported = 0
  let deduped = 0
  for (const lead of parsed.leads) {
    if (insertLead(lead, actor).deduped) deduped++
    else imported++
  }
  return c.json({ imported, deduped, total: parsed.leads.length, fields: parsed.mapped })
})

const EDITABLE = new Set([
  'company', 'trade', 'city', 'website', 'phone', 'email',
  'mobile_friendly', 'tech', 'staleness_signal', 'score', 'priority',
  'why_lead', 'notes', 'assigned_to', 'recontact_at',
])

app.patch('/api/leads/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as
    | LeadRow
    | undefined
  if (!lead) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const actor = c.get('user').username

  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }

  // Stage moves are tracked as their own event for the pipeline history.
  if (typeof b.stage === 'string' && b.stage !== lead.stage) {
    if (!STAGES.includes(b.stage as never)) return c.json({ error: 'invalid stage' }, 400)
    sets.push('stage = @stage')
    params.stage = b.stage
    db.prepare(
      `INSERT INTO lead_events (lead_id, actor, type, from_stage, to_stage)
       VALUES (?, ?, 'stage_change', ?, ?)`,
    ).run(id, actor, lead.stage, b.stage)
  }

  for (const key of Object.keys(b)) {
    if (!EDITABLE.has(key)) continue
    const v = b[key]
    sets.push(`${key} = @${key}`)
    // node:sqlite only binds string | number | null — coerce booleans/undefined.
    params[key] =
      v === undefined || v === null
        ? null
        : typeof v === 'boolean'
          ? v
            ? 1
            : 0
          : (v as string | number)
  }

  if (sets.length === 0) return c.json({ lead })

  sets.push("updated_at = datetime('now')")
  db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = @id`).run(params)

  if (typeof b.notes === 'string' && b.notes !== (lead.notes ?? '')) {
    db.prepare(
      `INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'note', ?)`,
    ).run(id, actor, b.notes)
  }

  if ('recontact_at' in b && (b.recontact_at ?? null) !== (lead.recontact_at ?? null)) {
    db.prepare(
      `INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'recontact', ?)`,
    ).run(id, actor, b.recontact_at ? `Wiedervorlage: ${b.recontact_at}` : 'Wiedervorlage entfernt')
  }

  const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow
  return c.json({ lead: updated })
})

// --- settings (business profile for documents) ----------------------------

const SETTINGS_FIELDS = new Set([
  'business_name', 'owner', 'address', 'zip', 'city', 'email', 'phone',
  'website', 'tax_id', 'iban', 'bic', 'bank', 'small_business', 'vat_rate',
  'payment_terms', 'rechnung_prefix', 'rechnung_next', 'angebot_prefix',
  'angebot_next', 'scraper_trades', 'scraper_towns', 'scraper_min_score',
  'scraper_max_pairs', 'scraper_per_pair', 'verzug_base_rate',
  'datev_revenue_account', 'datev_debitor_account',
])

app.get('/api/settings', requireAuth, (c) => c.json({ settings: getSettings() }))

app.put('/api/settings', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const sets: string[] = []
  const params: Record<string, string | number | null> = {}
  for (const key of Object.keys(b)) {
    if (!SETTINGS_FIELDS.has(key)) continue
    const v = b[key]
    sets.push(`${key} = @${key}`)
    params[key] =
      typeof v === 'boolean' ? (v ? 1 : 0) : ((v as string | number | null) ?? null)
  }
  if (sets.length) {
    db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(params)
  }
  return c.json({ settings: getSettings() })
})

// --- documents (Angebote + Rechnungen) ------------------------------------

// List documents (optionally filtered by kind), newest first, with totals.
app.get('/api/documents', requireAuth, (c) => {
  const kind = c.req.query('kind')
  const filtered = kind && DOC_KINDS.includes(kind as never)
  const where = filtered ? 'WHERE kind = ?' : ''
  const params: string[] = filtered ? [kind as string] : []
  const rows = db
    .prepare(`SELECT id FROM documents ${where} ORDER BY created_at DESC, id DESC`)
    .all(...params) as unknown as { id: number }[]
  const documents = rows.map((r) => getDocument(r.id))
  return c.json({ documents })
})

app.get('/api/documents/:id', requireAuth, (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  return c.json({ document: doc })
})

// Download a document as a PDF.
app.get('/api/documents/:id/pdf', requireAuth, async (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  const buf = await renderDocumentPdf(doc, getSettings())
  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `inline; filename="${pdfFilename(doc)}"`)
  return c.body(buf as unknown as ArrayBuffer)
})

// Create a draft document. Optionally prefill from a lead.
app.post('/api/documents', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const kind = String(b.kind ?? '')
  if (!DOC_KINDS.includes(kind as never)) return c.json({ error: 'invalid kind' }, 400)
  const s = getSettings()

  let prefillName: string | null = (b.client_name as string) ?? null
  let prefillCity: string | null = (b.client_city as string) ?? null
  let prefillEmail: string | null = (b.client_email as string) ?? null
  const leadId = b.lead_id != null ? Number(b.lead_id) : null
  if (leadId) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) as unknown as
      | LeadRow
      | undefined
    if (lead) {
      prefillName = prefillName ?? lead.company
      prefillCity = prefillCity ?? lead.city
      prefillEmail = prefillEmail ?? lead.email
    }
  }

  const info = db
    .prepare(
      `INSERT INTO documents
        (kind, lead_id, client_name, client_address, client_zip, client_city,
         client_email, title, intro, notes, small_business, vat_rate)
       VALUES
        (@kind, @lead_id, @client_name, @client_address, @client_zip, @client_city,
         @client_email, @title, @intro, @notes, @small_business, @vat_rate)`,
    )
    .run({
      kind,
      lead_id: leadId,
      client_name: prefillName,
      client_address: (b.client_address as string) ?? null,
      client_zip: (b.client_zip as string) ?? null,
      client_city: prefillCity,
      client_email: prefillEmail,
      title: (b.title as string) ?? (kind === 'rechnung' ? 'Rechnung' : 'Angebot'),
      intro: (b.intro as string) ?? null,
      notes: (b.notes as string) ?? null,
      small_business: s.small_business,
      vat_rate: s.vat_rate,
    })
  const id = Number(info.lastInsertRowid)
  if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
  return c.json({ document: getDocument(id) }, 201)
})

const DOC_EDITABLE = new Set([
  'client_name', 'client_address', 'client_zip', 'client_city', 'client_email',
  'title', 'intro', 'notes', 'due_date', 'small_business', 'vat_rate', 'buyer_reference',
])

app.patch('/api/documents/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
    | DocumentRow
    | undefined
  if (!doc) return c.json({ error: 'not found' }, 404)
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>

  // Status change, validated against the kind's allowed statuses.
  if (typeof b.status === 'string' && b.status !== doc.status) {
    const allowed = DOC_STATUSES[doc.kind as keyof typeof DOC_STATUSES] ?? []
    if (!allowed.includes(b.status)) return c.json({ error: 'invalid status' }, 400)
  }

  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const key of [...DOC_EDITABLE, 'status']) {
    if (!(key in b)) continue
    const v = b[key]
    sets.push(`${key} = @${key}`)
    params[key] = typeof v === 'boolean' ? (v ? 1 : 0) : ((v as string | number | null) ?? null)
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
  return c.json({ document: getDocument(id) })
})

// Finalise a draft: assign a gapless number + issue/due dates, mark "versendet".
app.post('/api/documents/:id/finalize', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
    | DocumentRow
    | undefined
  if (!doc) return c.json({ error: 'not found' }, 404)
  if (doc.number) return c.json({ document: getDocument(id) }) // already finalised
  const number = assignNumber(doc.kind as never)
  const s = getSettings()
  const today = new Date().toISOString().slice(0, 10)
  const due = new Date(Date.now() + s.payment_terms * 86400000).toISOString().slice(0, 10)
  db.prepare(
    `UPDATE documents
       SET number = ?, issue_date = ?, due_date = COALESCE(due_date, ?),
           status = 'versendet', updated_at = datetime('now')
     WHERE id = ?`,
  ).run(number, today, doc.kind === 'rechnung' ? due : null, id)
  return c.json({ document: getDocument(id) })
})

// Validate a document against EN 16931 (Factur-X/ZUGFeRD) business rules.
app.get('/api/documents/:id/validate', requireAuth, (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  return c.json({ validation: validateInvoice(doc, getSettings()) })
})

// --- Mahnwesen (dunning) ---------------------------------------------------

// All sent, unpaid, past-due invoices with computed Verzugszinsen + Mahnstufe.
app.get('/api/invoices/overdue', requireAuth, (c) => {
  return c.json({ overdue: listOverdue() })
})

// Preview/raise a Mahnung for an invoice. POST persists a record; GET previews.
app.get('/api/documents/:id/dunning', requireAuth, (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  const level = c.req.query('level') != null ? Number(c.req.query('level')) : undefined
  const history = db
    .prepare('SELECT * FROM mahnungen WHERE document_id = ? ORDER BY created_at DESC')
    .all(doc.id)
  return c.json({ preview: computeDunning(doc, getSettings(), level), history })
})

app.post('/api/documents/:id/dunning', requireAuth, async (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  if (doc.kind !== 'rechnung' || !doc.number) {
    return c.json({ error: 'Nur für ausgestellte Rechnungen.' }, 400)
  }
  const b = (await c.req.json().catch(() => ({}))) as { level?: number; note?: string }
  const d = computeDunning(doc, getSettings(), b.level)
  const info = db.prepare(
    `INSERT INTO mahnungen (document_id, level, days_overdue, interest_cents, pauschale_cents, total_claim_cents, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(doc.id, d.suggested_level, d.days_overdue, d.interest_cents, d.pauschale_cents, d.total_claim_cents, b.note ?? levelLabel(d.suggested_level))
  audit({ actor: c.get('user').username, action: 'invoice.dunning', entity: 'document', entityId: doc.id, detail: { level: d.suggested_level, total_claim_cents: d.total_claim_cents } })
  const row = db.prepare('SELECT * FROM mahnungen WHERE id = ?').get(Number(info.lastInsertRowid))
  return c.json({ mahnung: row, computation: d, label: levelLabel(d.suggested_level) }, 201)
})

// Download a Mahnung (dunning notice) for an invoice as a PDF.
app.get('/api/documents/:id/dunning/pdf', requireAuth, async (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc || doc.kind !== 'rechnung' || !doc.number) return c.json({ error: 'not found' }, 404)
  const level = c.req.query('level') != null ? Number(c.req.query('level')) : undefined
  const s = getSettings()
  const comp = computeDunning(doc, s, level)
  const lvl = level ?? comp.suggested_level
  const buf = await renderMahnungPdf(doc, s, comp, lvl)
  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `inline; filename="${mahnungPdfFilename(doc, lvl)}"`)
  return c.body(buf as unknown as ArrayBuffer)
})

// Convert an Angebot into a draft Rechnung (copies client + items).
app.post('/api/documents/:id/convert', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const src = getDocument(id)
  if (!src) return c.json({ error: 'not found' }, 404)
  if (src.kind !== 'angebot') return c.json({ error: 'nur Angebote konvertierbar' }, 400)
  const info = db
    .prepare(
      `INSERT INTO documents
        (kind, lead_id, client_name, client_address, client_zip, client_city,
         client_email, title, intro, notes, small_business, vat_rate)
       VALUES
        ('rechnung', @lead_id, @client_name, @client_address, @client_zip, @client_city,
         @client_email, 'Rechnung', @intro, @notes, @small_business, @vat_rate)`,
    )
    .run({
      lead_id: src.lead_id,
      client_name: src.client_name,
      client_address: src.client_address,
      client_zip: src.client_zip,
      client_city: src.client_city,
      client_email: src.client_email,
      intro: src.intro,
      notes: src.notes,
      small_business: src.small_business,
      vat_rate: src.vat_rate,
    })
  const newId = Number(info.lastInsertRowid)
  replaceItems(
    newId,
    src.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      unit_price_cents: it.unit_price_cents,
    })),
  )
  return c.json({ document: getDocument(newId) }, 201)
})

app.delete('/api/documents/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
    | DocumentRow
    | undefined
  if (!doc) return c.json({ error: 'not found' }, 404)
  // Keep the audit trail intact: finalised (numbered) documents must not vanish.
  if (doc.number) {
    return c.json({ error: 'Ausgestellte Dokumente können nicht gelöscht werden.' }, 400)
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  return c.json({ ok: true })
})

// --- scraper (config + status) --------------------------------------------

// Fallback defaults if the operator hasn't customised the lists yet. Mirror the
// scraper's built-in defaults so the panel and the scraper agree.
const DEFAULT_SCRAPER = {
  trades: [
    'Schreiner', 'Maler', 'Dachdecker', 'Elektro', 'Sanitär Heizung',
    'Metallbau', 'Glaser', 'Bodenleger', 'Raumausstatter', 'GaLaBau',
  ],
  towns: [
    'Dachau', 'Erding', 'Freising', 'Fürstenfeldbruck', 'Starnberg',
    'Ebersberg', 'Olching', 'Germering', 'Ottobrunn', 'Unterschleißheim',
  ],
  min_score: 40,
  max_pairs: 3,
  per_pair: 8,
}

function parseList(v: string | null): string[] {
  return (v ?? '')
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

// Effective scraper config. Reachable with the service token so the scraper can
// pull it at startup, or with a session for the settings UI.
app.get('/api/scraper/config', requireServiceOrAuth, (c) => {
  const s = getSettings()
  const trades = parseList(s.scraper_trades)
  const towns = parseList(s.scraper_towns)
  return c.json({
    trades: trades.length ? trades : DEFAULT_SCRAPER.trades,
    towns: towns.length ? towns : DEFAULT_SCRAPER.towns,
    min_score: s.scraper_min_score ?? DEFAULT_SCRAPER.min_score,
    max_pairs: s.scraper_max_pairs ?? DEFAULT_SCRAPER.max_pairs,
    per_pair: s.scraper_per_pair ?? DEFAULT_SCRAPER.per_pair,
    using_defaults: { trades: trades.length === 0, towns: towns.length === 0 },
  })
})

// Status dashboard data for the scraper panel.
app.get('/api/scraper/status', requireAuth, (c) => {
  const one = (sql: string) => db.prepare(sql).get() as unknown as Record<string, number | string | null>
  const total = Number(one('SELECT COUNT(*) AS n FROM leads').n)
  const scraped = Number(one("SELECT COUNT(*) AS n FROM leads WHERE source = 'scraper'").n)
  const last = one("SELECT MAX(created_at) AS m FROM leads WHERE source = 'scraper'").m as string | null
  const today = Number(
    one("SELECT COUNT(*) AS n FROM leads WHERE source = 'scraper' AND date(created_at) = date('now')").n,
  )
  const byStage = db
    .prepare("SELECT stage, COUNT(*) AS n FROM leads WHERE source = 'scraper' GROUP BY stage")
    .all() as unknown as { stage: string; n: number }[]
  const recent = db
    .prepare(
      `SELECT id, company, trade, city, score, priority, created_at
       FROM leads WHERE source = 'scraper' ORDER BY created_at DESC, id DESC LIMIT 8`,
    )
    .all() as unknown as Record<string, unknown>[]
  return c.json({ total, scraped, last, today, byStage, recent })
})

// --- exports for the Steuerberater (GoBD invoice journal + DATEV bookings) --

function csvResponse(c: Context<{ Variables: Vars }>, body: string, filename: string) {
  c.header('Content-Type', 'text/csv; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="${filename}"`)
  // BOM so Excel opens UTF-8 (umlauts) correctly.
  return c.body('﻿' + body)
}

app.get('/api/export/invoices.csv', requireAuth, (c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  const invoices = finalisedInvoices(from, to)
  audit({ actor: c.get('user').username, action: 'export.invoices', detail: { from, to, count: invoices.length } })
  return csvResponse(c, invoicesCsv(invoices), exportFilename('rechnungen', from, to))
})

app.get('/api/export/datev.csv', requireAuth, (c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  const invoices = finalisedInvoices(from, to)
  audit({ actor: c.get('user').username, action: 'export.datev', detail: { from, to, count: invoices.length } })
  return csvResponse(c, datevCsv(invoices, getSettings()), exportFilename('datev', from, to))
})

// --- admin: database backup (operator owns their data) ---------------------

app.get('/api/admin/backup', requireAuth, (c) => {
  const buf = snapshot()
  audit({ actor: c.get('user').username, action: 'admin.backup', detail: { bytes: buf.length } })
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Disposition', `attachment; filename="${snapshotFilename()}"`)
  return c.body(buf as unknown as ArrayBuffer)
})

// --- AI core + DSGVO (registered with the app's auth middleware) -----------

registerAiRoutes(app, requireAuth)
registerDsgvoRoutes(app, requireAuth)

// --- health ---------------------------------------------------------------

app.get('/api/health', (c) => c.json({ ok: true }))

// --- serve the built web app (production only) ----------------------------
// In dev the web app runs on Vite and proxies /api here, so this is skipped.
if (isProd) {
  // @hono/node-server serveStatic resolves `root` relative to the cwd.
  const webDist = process.env.WEB_DIST ?? '../web/dist'
  app.use('/*', serveStatic({ root: webDist }))
  // SPA fallback: any non-API, non-asset route returns index.html.
  let indexHtml = ''
  try {
    indexHtml = readFileSync(resolve(process.cwd(), webDist, 'index.html'), 'utf8')
  } catch {
    console.warn(`web build not found at ${webDist} — run "npm run build" in crm/web`)
  }
  app.get('*', (c) => (indexHtml ? c.html(indexHtml) : c.text('web app not built', 503)))
}

// --- boot -----------------------------------------------------------------

const port = Number(process.env.PORT ?? 8787)
// In Docker, bind 0.0.0.0 (HOST=0.0.0.0) so the published port + the `api`
// service name are reachable. The host only exposes it on 127.0.0.1 via the
// compose `ports` mapping, so it stays private either way.
const host = process.env.HOST ?? '127.0.0.1'
serve({ fetch: app.fetch, port, hostname: host }, ({ port }) => {
  console.log(`crm-api listening on http://${host}:${port}`)
})
