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
  CLIENT_TYPES,
  ROLES,
  RECURRING_CADENCES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  CONTRACT_TYPES,
  CONTRACT_STATUSES,
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
  finalizeDraft,
  setDocumentSignedDoc,
  getDocumentSignedDoc,
  deleteDocumentSignedDoc,
  type DocItemInput,
} from './documents'
import { renderDocumentPdf, pdfFilename } from './pdf'
import {
  listContracts,
  getContract,
  createContract,
  updateContract,
  setContractStatus,
  finalizeContract,
  signContract,
  deleteContract,
  contractFromDocument,
  setSignedDoc,
  getSignedDoc,
  deleteSignedDoc,
} from './contracts'
import { renderContractPdf, contractPdfFilename } from './contractPdf'
import {
  listCatalog,
  getCatalogItem,
  createCatalogItem,
  updateCatalogItem,
  deleteCatalogItem,
} from './catalog'
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from './customers'
import { validateInvoice } from './validate'
import { listPayments, addPayment, deletePayment, paidCents } from './payments'
import {
  listRecurring,
  getRecurring,
  createRecurring,
  updateRecurring,
  deleteRecurring,
  runRecurring,
  processDueRecurring,
} from './recurring'
import { buildDashboard } from './dashboard'
import {
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  setReceipt,
  deleteReceipt,
  getReceipt,
  expenseSummary,
} from './expenses'
import {
  listSubscriptions,
  getSubscription,
  createSubscription,
  updateSubscription,
  deleteSubscription,
  subscriptionSummary,
} from './subscriptions'
import { listUsers, createUser, updateUser, deleteUser } from './users'
import { startScrape, scrapeRunState, scraperReachable, serviceTokenConfigured } from './scrape'
import { snapshot, snapshotFilename, restoreFromBuffer } from './backup'
import {
  finalisedInvoices,
  invoicesCsv,
  datevCsv,
  expensesInRange,
  expensesCsv,
  expensesDatevCsv,
  leadsCsv,
  exportFilename,
} from './export'
import { buildEuer } from './report'
import { audit } from './audit'
import { rateLimit } from './ratelimit'
import { encryptSecret, settingsKeyConfigured } from './secrets'
import { registerAiRoutes } from './ai/router'
import { registerDsgvoRoutes } from './dsgvo'
import { emit } from './events'
import { insertLead, applyLeadUpdate } from './leads'
import { SMTP } from './mailer'
import { deliverMail } from './maildispatch'

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

// Gate admin-only routes (user management): a valid session whose role is admin.
async function requireAdmin(c: Context<{ Variables: Vars }>, next: Next) {
  const sess = readSession(getCookie(c, COOKIE))
  if (!sess) return c.json({ error: 'unauthorized' }, 401)
  const user = db
    .prepare('SELECT id, username, role FROM users WHERE id = ?')
    .get(sess.uid) as unknown as Vars['user'] | undefined
  if (!user) return c.json({ error: 'unauthorized' }, 401)
  if (user.role !== 'admin') return c.json({ error: 'Nur für Administratoren.' }, 403)
  c.set('user', user)
  await next()
}

// --- auth routes ----------------------------------------------------------

// Throttle password attempts per client IP to blunt credential stuffing /
// brute force. scrypt already makes each attempt costly; this caps the rate on
// top. Keyed by IP (X-Forwarded-For first hop behind the reverse proxy).
app.post('/api/login', rateLimit({ windowMs: 60_000, max: 10 }), async (c) => {
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
    clientTypes: CLIENT_TYPES,
    roles: ROLES,
    cadences: RECURRING_CADENCES,
    expenseCategories: EXPENSE_CATEGORIES,
    paymentMethods: PAYMENT_METHODS,
    contractTypes: CONTRACT_TYPES,
    contractStatuses: CONTRACT_STATUSES,
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

// Create a lead. Used by the scraper (service token) and manual adds.
// insertLead() lives in ./leads (shared with the public API; emits lead.created).
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

// Edit a lead. The field/stage/notes logic lives in applyLeadUpdate() (./leads),
// shared with the public API and the source of the lead.stage_changed webhook.
app.patch('/api/leads/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const lead = applyLeadUpdate(id, b, c.get('user').username)
    if (!lead) return c.json({ error: 'not found' }, 404)
    return c.json({ lead })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

// --- settings (business profile for documents) ----------------------------

const SETTINGS_FIELDS = new Set([
  'business_name', 'owner', 'address', 'zip', 'city', 'email', 'phone',
  'website', 'tax_id', 'iban', 'bic', 'bank', 'small_business', 'vat_rate',
  'payment_terms', 'rechnung_prefix', 'rechnung_next', 'angebot_prefix',
  'angebot_next', 'scraper_trades', 'scraper_towns', 'scraper_region',
  'scraper_min_score', 'scraper_max_pairs', 'scraper_per_pair',
  'datev_revenue_account', 'datev_debitor_account', 'datev_bank_account',
  // Operator-editable connection config (plain). Override the matching .env var.
  'ai_base_url', 'ai_model', 'ai_label',
  'smtp_host', 'smtp_port', 'smtp_user', 'smtp_secure', 'smtp_from',
  // Verträge / AGB
  'agb_text', 'contract_prefix', 'contract_next', 'agb_attach_documents',
])

// Write-only secrets: the client sends the plaintext under the key on the left,
// we encrypt it into the column on the right. The plaintext is never stored or
// returned — only "is a secret set?" booleans go back to the browser.
const SECRET_FIELDS: Record<string, string> = {
  ai_api_key: 'ai_api_key_enc',
  smtp_pass: 'smtp_pass_enc',
  scraper_ai_api_key: 'scraper_ai_api_key_enc',
}

// The settings object the client may see: the encrypted columns are stripped and
// replaced by booleans. Defence in depth — the values are ciphertext anyway, but
// they have no business leaving the server.
function publicSettings() {
  const s = getSettings() as unknown as Record<string, unknown>
  const ai_api_key_set = !!s.ai_api_key_enc
  const smtp_pass_set = !!s.smtp_pass_enc
  const scraper_ai_api_key_set = !!s.scraper_ai_api_key_enc
  delete s.ai_api_key_enc
  delete s.smtp_pass_enc
  delete s.scraper_ai_api_key_enc
  return {
    ...s,
    ai_api_key_set,
    smtp_pass_set,
    scraper_ai_api_key_set,
    settings_key_configured: settingsKeyConfigured(),
  }
}

app.get('/api/settings', requireAuth, (c) => c.json({ settings: publicSettings() }))

app.put('/api/settings', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const sets: string[] = []
  const params: Record<string, string | number | null> = {}
  const changed: string[] = []
  for (const key of Object.keys(b)) {
    if (SETTINGS_FIELDS.has(key)) {
      const v = b[key]
      sets.push(`${key} = @${key}`)
      params[key] =
        typeof v === 'boolean' ? (v ? 1 : 0) : ((v as string | number | null) ?? null)
      changed.push(key)
    } else if (key in SECRET_FIELDS) {
      // Empty/blank clears the stored secret; any value is encrypted at rest.
      const col = SECRET_FIELDS[key]
      const raw = b[key]
      let enc: string | null = null
      if (typeof raw === 'string' && raw.trim() !== '') {
        try {
          enc = encryptSecret(raw)
        } catch (e) {
          return c.json({ error: (e as Error).message }, 400)
        }
      }
      sets.push(`${col} = @${col}`)
      params[col] = enc
      changed.push(key) // log the field name, never the value
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE settings SET ${sets.join(', ')} WHERE id = 1`).run(params)
    audit({ actor: c.get('user').username, action: 'settings.update', entity: 'settings', entityId: 1, detail: { fields: changed } })
  }
  return c.json({ settings: publicSettings() })
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

  // Prefill precedence: explicit body field > linked customer > linked lead.
  const customerId = b.customer_id != null ? Number(b.customer_id) : null
  const customer = customerId ? getCustomer(customerId) : null
  let prefillName: string | null = (b.client_name as string) ?? customer?.name ?? null
  let prefillAddress: string | null = (b.client_address as string) ?? customer?.address ?? null
  let prefillZip: string | null = (b.client_zip as string) ?? customer?.zip ?? null
  let prefillCity: string | null = (b.client_city as string) ?? customer?.city ?? null
  let prefillEmail: string | null = (b.client_email as string) ?? customer?.email ?? null
  let prefillVat: string | null = (b.client_vat_id as string) ?? customer?.vat_id ?? null
  const clientType =
    (b.client_type as string) ?? customer?.client_type ?? 'geschaeft'
  const leadId = b.lead_id != null ? Number(b.lead_id) : customer?.lead_id ?? null
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
        (kind, lead_id, customer_id, client_name, client_address, client_zip, client_city,
         client_email, client_vat_id, client_type, title, intro, notes, small_business, vat_rate)
       VALUES
        (@kind, @lead_id, @customer_id, @client_name, @client_address, @client_zip, @client_city,
         @client_email, @client_vat_id, @client_type, @title, @intro, @notes, @small_business, @vat_rate)`,
    )
    .run({
      kind,
      lead_id: leadId,
      customer_id: customer?.id ?? null,
      client_name: prefillName,
      client_address: prefillAddress,
      client_zip: prefillZip,
      client_city: prefillCity,
      client_email: prefillEmail,
      client_vat_id: prefillVat,
      client_type: clientType === 'privat' ? 'privat' : 'geschaeft',
      title: (b.title as string) ?? (kind === 'rechnung' ? 'Rechnung' : 'Angebot'),
      intro: (b.intro as string) ?? null,
      notes: (b.notes as string) ?? null,
      small_business: s.small_business,
      vat_rate: s.vat_rate,
    })
  const id = Number(info.lastInsertRowid)
  if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
  emit('document.created', { id, kind })
  return c.json({ document: getDocument(id) }, 201)
})

const DOC_EDITABLE = new Set([
  'client_name', 'client_address', 'client_zip', 'client_city', 'client_email',
  'client_type', 'title', 'intro', 'notes', 'due_date', 'small_business', 'vat_rate',
  'buyer_reference', 'client_vat_id', 'include_payment_link',
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
    // node:sqlite binds only string|number|null — coerce booleans, skip non-scalar
    // (object/array) values rather than letting .run() throw a raw 500.
    let bound: string | number | null
    if (v === undefined || v === null) bound = null
    else if (typeof v === 'boolean') bound = v ? 1 : 0
    else if (typeof v === 'string' || typeof v === 'number') bound = v
    else continue
    sets.push(`${key} = @${key}`)
    params[key] = bound
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  if (Array.isArray(b.items)) replaceItems(id, b.items as DocItemInput[])
  return c.json({ document: getDocument(id) })
})

// Finalise a draft: assign a gapless number + issue/due dates, mark "versendet".
// Done atomically in finalizeDraft() so a number is never consumed without the
// matching invoice (gapless numbering, §14 UStG / GoBD).
app.post('/api/documents/:id/finalize', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const wasFinal = !!(db.prepare('SELECT number FROM documents WHERE id = ?').get(id) as { number?: string } | undefined)?.number
  const doc = finalizeDraft(id)
  if (!doc) return c.json({ error: 'not found' }, 404)
  // Audit the issuance (who finalised which number, when) — but not a re-finalise no-op.
  if (!wasFinal) {
    audit({ actor: c.get('user').username, action: 'document.finalize', entity: 'document', entityId: id, detail: { number: doc.number, kind: doc.kind } })
    emit('document.finalized', { id, number: doc.number, kind: doc.kind })
  }
  return c.json({ document: doc })
})

// Validate a document against EN 16931 (Factur-X/ZUGFeRD) business rules.
app.get('/api/documents/:id/validate', requireAuth, (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  return c.json({ validation: validateInvoice(doc, getSettings()) })
})

// E-mail a finalised document as a PDF to the client.
app.post('/api/documents/:id/send', requireAuth, async (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  if (!doc.number) return c.json({ error: 'Nur ausgestellte Dokumente können versendet werden.' }, 400)
  if (!doc.client_email) return c.json({ error: 'Kein Empfänger (E-Mail) am Dokument hinterlegt.' }, 400)
  const s = getSettings()

  let pdf: Buffer
  try {
    pdf = await renderDocumentPdf(doc, s)
  } catch (e) {
    return c.json({ error: 'PDF konnte nicht erstellt werden: ' + (e as Error).message }, 500)
  }
  const label = doc.kind === 'rechnung' ? 'Rechnung' : 'Angebot'
  const greeting = doc.client_name ? `Sehr geehrte Damen und Herren bei ${doc.client_name},` : 'Sehr geehrte Damen und Herren,'
  const body =
    `${greeting}\n\nanbei erhalten Sie ${label === 'Rechnung' ? 'unsere Rechnung' : 'unser Angebot'} ${doc.number} als PDF.\n\n` +
    `Mit freundlichen Grüßen\n${s.business_name ?? ''}`
  const email = { to: doc.client_email, from: SMTP.from || s.email || '', subject: `${label} ${doc.number}`, text: body }
  try {
    const { messageId, via } = await deliverMail(email, {
      attachments: [{ filename: pdfFilename(doc), content: pdf, contentType: 'application/pdf' }],
      actor: c.get('user').username,
    })
    audit({ actor: c.get('user').username, action: 'invoice.send', entity: 'document', entityId: doc.id, detail: { to: email.to, messageId, via } })
    emit('invoice.sent', { id: doc.id, number: doc.number, kind: doc.kind, to: email.to })
    return c.json({ ok: true, messageId, to: email.to })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502)
  }
})

// --- Zahlungen (payments against an invoice) ------------------------------

// List payments for an invoice plus the paid/outstanding summary.
app.get('/api/documents/:id/payments', requireAuth, (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  return c.json({
    payments: listPayments(doc.id),
    gross_cents: doc.totals.gross_cents,
    paid_cents: doc.paid_cents,
    outstanding_cents: Math.max(0, doc.totals.gross_cents - doc.paid_cents),
  })
})

// Record a payment. Settling the open amount flips the invoice to 'bezahlt'.
app.post('/api/documents/:id/payments', requireAuth, async (c) => {
  const doc = getDocument(Number(c.req.param('id')))
  if (!doc) return c.json({ error: 'not found' }, 404)
  if (doc.kind !== 'rechnung' || !doc.number) {
    return c.json({ error: 'Zahlungen nur für ausgestellte Rechnungen.' }, 400)
  }
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const amount = Math.round(Number(b.amount_cents))
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
  }
  const payment = addPayment(doc.id, {
    amount_cents: amount,
    paid_on: (b.paid_on as string) ?? null,
    method: (b.method as string) ?? null,
    note: (b.note as string) ?? null,
  })
  audit({ actor: c.get('user').username, action: 'invoice.payment', entity: 'document', entityId: doc.id, detail: { amount_cents: amount, paid_total_cents: paidCents(doc.id) } })
  emit('payment.recorded', { document_id: doc.id, amount_cents: amount, paid_total_cents: paidCents(doc.id), source: 'manual' })
  return c.json({ payment, document: getDocument(doc.id) }, 201)
})

// Delete a recorded payment (re-opens the invoice if it drops below the total).
app.delete('/api/payments/:id', requireAuth, (c) => {
  const pid = Number(c.req.param('id'))
  const docId = deletePayment(pid)
  if (docId === null) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'invoice.payment.delete', entity: 'document', entityId: docId, detail: { payment_id: pid } })
  emit('payment.deleted', { document_id: docId, payment_id: pid })
  return c.json({ document: getDocument(docId) })
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
         client_email, client_type, title, intro, notes, small_business, vat_rate)
       VALUES
        ('rechnung', @lead_id, @client_name, @client_address, @client_zip, @client_city,
         @client_email, @client_type, 'Rechnung', @intro, @notes, @small_business, @vat_rate)`,
    )
    .run({
      lead_id: src.lead_id,
      client_name: src.client_name,
      client_address: src.client_address,
      client_zip: src.client_zip,
      client_city: src.client_city,
      client_email: src.client_email,
      client_type: src.client_type,
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

// Turn a document (typically an accepted Angebot) into a draft Vertrag, carrying
// the client block, customer/lead links, net value and a Leistungsbeschreibung.
app.post('/api/documents/:id/to-contract', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const contract = contractFromDocument(id, c.get('user').username)
  if (!contract) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'contract.from_document', entity: 'contract', entityId: contract.id, detail: { document_id: id } })
  emit('contract.created', { id: contract.id, type: contract.type, from_document: id })
  return c.json({ contract }, 201)
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

// Save / replace the signed or final copy of an Angebot/Rechnung (PDF or scan).
// Same allowed formats + size cap as expense receipts. multipart field name: "file".
app.post('/api/documents/:id/signed-document', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!getDocument(id)) return c.json({ error: 'not found' }, 404)
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
  if (file.size > RECEIPT_MAX_BYTES) return c.json({ error: 'Datei zu groß (max. 10 MB).' }, 413)
  const mime = file.type || 'application/octet-stream'
  if (!RECEIPT_MIMES.has(mime)) {
    return c.json({ error: 'Nicht unterstütztes Format — PDF oder Bild (PNG/JPEG/…) erwartet.' }, 415)
  }
  const data = new Uint8Array(await file.arrayBuffer())
  const document = setDocumentSignedDoc(id, { data, name: file.name || `Dokument-${id}`, mime })
  audit({ actor: c.get('user').username, action: 'document.signed_doc.upload', entity: 'document', entityId: id, detail: { name: file.name, bytes: data.byteLength } })
  return c.json({ document })
})

app.get('/api/documents/:id/signed-document', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const doc = getDocumentSignedDoc(id)
  if (!doc) return c.json({ error: 'not found' }, 404)
  c.header('Content-Type', doc.mime)
  const asciiName = doc.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  c.header('Content-Disposition', `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`)
  return c.body(Buffer.from(doc.data) as unknown as ArrayBuffer)
})

app.delete('/api/documents/:id/signed-document', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const document = deleteDocumentSignedDoc(id)
  if (!document) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'document.signed_doc.delete', entity: 'document', entityId: id })
  return c.json({ document })
})

// --- Verträge (contracts / AGB) -------------------------------------------

app.get('/api/contracts', requireAuth, (c) => c.json({ contracts: listContracts() }))

app.get('/api/contracts/:id', requireAuth, (c) => {
  const contract = getContract(Number(c.req.param('id')))
  if (!contract) return c.json({ error: 'not found' }, 404)
  return c.json({ contract })
})

app.post('/api/contracts', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const contract = createContract(b, c.get('user').username)
  audit({ actor: c.get('user').username, action: 'contract.create', entity: 'contract', entityId: contract.id, detail: { type: contract.type, client_name: contract.client_name } })
  emit('contract.created', { id: contract.id, type: contract.type })
  return c.json({ contract }, 201)
})

app.patch('/api/contracts/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  // A status change goes through the dedicated transition (validated set).
  if (typeof b.status === 'string') {
    try {
      const contract = setContractStatus(id, b.status)
      if (!contract) return c.json({ error: 'not found' }, 404)
      return c.json({ contract })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  }
  const contract = updateContract(id, b)
  if (!contract) return c.json({ error: 'not found' }, 404)
  return c.json({ contract })
})

// Finalise: assign a gapless number, freeze the AGB text in force now, mark sent.
app.post('/api/contracts/:id/finalize', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const wasFinal = !!(db.prepare('SELECT number FROM contracts WHERE id = ?').get(id) as { number?: string } | undefined)?.number
  const contract = finalizeContract(id)
  if (!contract) return c.json({ error: 'not found' }, 404)
  if (!wasFinal) {
    audit({ actor: c.get('user').username, action: 'contract.finalize', entity: 'contract', entityId: id, detail: { number: contract.number, type: contract.type } })
    emit('contract.finalized', { id, number: contract.number, type: contract.type })
  }
  return c.json({ contract })
})

// Record acceptance / countersignature → status 'aktiv'.
app.post('/api/contracts/:id/sign', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as { signed_by?: string; signed_at?: string; note?: string }
  try {
    const contract = signContract(id, b.signed_by ?? null, b.note ?? null, b.signed_at ?? null)
    if (!contract) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'contract.sign', entity: 'contract', entityId: id, detail: { signed_by: contract.signed_by, signed_at: contract.signed_at, number: contract.number } })
    emit('contract.signed', { id, number: contract.number, signed_by: contract.signed_by })
    return c.json({ contract })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

// Download a contract as a PDF (AGB appended in full).
app.get('/api/contracts/:id/pdf', requireAuth, async (c) => {
  const contract = getContract(Number(c.req.param('id')))
  if (!contract) return c.json({ error: 'not found' }, 404)
  const buf = await renderContractPdf(contract, getSettings())
  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `inline; filename="${contractPdfFilename(contract)}"`)
  return c.body(buf as unknown as ArrayBuffer)
})

// E-mail a finalised contract as a PDF to the client for signature.
app.post('/api/contracts/:id/send', requireAuth, async (c) => {
  const contract = getContract(Number(c.req.param('id')))
  if (!contract) return c.json({ error: 'not found' }, 404)
  if (!contract.number) return c.json({ error: 'Nur festgeschriebene Verträge können versendet werden.' }, 400)
  if (!contract.client_email) return c.json({ error: 'Kein Empfänger (E-Mail) am Vertrag hinterlegt.' }, 400)
  const s = getSettings()
  let pdf: Buffer
  try {
    pdf = await renderContractPdf(contract, s)
  } catch (e) {
    return c.json({ error: 'PDF konnte nicht erstellt werden: ' + (e as Error).message }, 500)
  }
  const label = CONTRACT_TYPES.find((t) => t.id === contract.type)?.label ?? 'Vertrag'
  const greeting = contract.client_name ? `Sehr geehrte Damen und Herren bei ${contract.client_name},` : 'Sehr geehrte Damen und Herren,'
  const body =
    `${greeting}\n\nanbei erhalten Sie unseren ${label} ${contract.number} als PDF. ` +
    `Bitte prüfen Sie den Vertrag in Ruhe; bei Einverständnis senden Sie ihn uns gegengezeichnet zurück.\n\n` +
    `Mit freundlichen Grüßen\n${s.business_name ?? ''}`
  const email = { to: contract.client_email, from: SMTP.from || s.email || '', subject: `${label} ${contract.number}`, text: body }
  try {
    const { messageId, via } = await deliverMail(email, {
      attachments: [{ filename: contractPdfFilename(contract), content: pdf, contentType: 'application/pdf' }],
      actor: c.get('user').username,
    })
    audit({ actor: c.get('user').username, action: 'contract.send', entity: 'contract', entityId: contract.id, detail: { to: email.to, messageId, via } })
    return c.json({ ok: true, messageId, to: email.to })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502)
  }
})

app.delete('/api/contracts/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const r = deleteContract(id)
  if (!r.ok && r.reason === 'not found') return c.json({ error: 'not found' }, 404)
  if (!r.ok && r.reason === 'finalised') {
    return c.json({ error: 'Festgeschriebene Verträge können nicht gelöscht werden.' }, 400)
  }
  audit({ actor: c.get('user').username, action: 'contract.delete', entity: 'contract', entityId: id })
  return c.json({ ok: true })
})

// Attach / replace the countersigned document the client returns (PDF or scan).
// Same allowed formats + size cap as expense receipts. multipart field name: "file".
app.post('/api/contracts/:id/signed-document', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!getContract(id)) return c.json({ error: 'not found' }, 404)
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
  if (file.size > RECEIPT_MAX_BYTES) return c.json({ error: 'Datei zu groß (max. 10 MB).' }, 413)
  const mime = file.type || 'application/octet-stream'
  if (!RECEIPT_MIMES.has(mime)) {
    return c.json({ error: 'Nicht unterstütztes Format — PDF oder Bild (PNG/JPEG/…) erwartet.' }, 415)
  }
  const data = new Uint8Array(await file.arrayBuffer())
  const contract = setSignedDoc(id, { data, name: file.name || `Vertrag-${id}-unterschrieben`, mime })
  audit({ actor: c.get('user').username, action: 'contract.signed_doc.upload', entity: 'contract', entityId: id, detail: { name: file.name, bytes: data.byteLength } })
  return c.json({ contract })
})

// Download / view the signed document inline.
app.get('/api/contracts/:id/signed-document', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const doc = getSignedDoc(id)
  if (!doc) return c.json({ error: 'not found' }, 404)
  c.header('Content-Type', doc.mime)
  const asciiName = doc.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  c.header(
    'Content-Disposition',
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
  )
  return c.body(Buffer.from(doc.data) as unknown as ArrayBuffer)
})

app.delete('/api/contracts/:id/signed-document', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const contract = deleteSignedDoc(id)
  if (!contract) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'contract.signed_doc.delete', entity: 'contract', entityId: id })
  return c.json({ contract })
})

// --- Leistungskatalog (reusable services/products) ------------------------

app.get('/api/catalog', requireAuth, (c) => {
  const activeOnly = c.req.query('active') === '1'
  return c.json({ items: listCatalog(activeOnly) })
})

app.post('/api/catalog', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const item = createCatalogItem(b)
    audit({ actor: c.get('user').username, action: 'catalog.create', entity: 'catalog', entityId: item.id, detail: { name: item.name, unit_price_cents: item.unit_price_cents } })
    return c.json({ item }, 201)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.patch('/api/catalog/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const item = updateCatalogItem(id, b)
    if (!item) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'catalog.update', entity: 'catalog', entityId: id, detail: { fields: Object.keys(b) } })
    return c.json({ item })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.delete('/api/catalog/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!getCatalogItem(id)) return c.json({ error: 'not found' }, 404)
  deleteCatalogItem(id)
  audit({ actor: c.get('user').username, action: 'catalog.delete', entity: 'catalog', entityId: id })
  return c.json({ ok: true })
})

// --- Kunden (customer registry) -------------------------------------------

app.get('/api/customers', requireAuth, (c) => {
  const activeOnly = c.req.query('active') === '1'
  return c.json({ customers: listCustomers(activeOnly) })
})

app.get('/api/customers/:id', requireAuth, (c) => {
  const customer = getCustomer(Number(c.req.param('id')))
  if (!customer) return c.json({ error: 'not found' }, 404)
  return c.json({ customer })
})

app.post('/api/customers', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const customer = createCustomer(b)
    audit({ actor: c.get('user').username, action: 'customer.create', entity: 'customer', entityId: customer.id, detail: { name: customer.name } })
    return c.json({ customer }, 201)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.patch('/api/customers/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const customer = updateCustomer(id, b)
    if (!customer) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'customer.update', entity: 'customer', entityId: id, detail: { fields: Object.keys(b) } })
    return c.json({ customer })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.delete('/api/customers/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!getCustomer(id)) return c.json({ error: 'not found' }, 404)
  deleteCustomer(id)
  audit({ actor: c.get('user').username, action: 'customer.delete', entity: 'customer', entityId: id })
  return c.json({ ok: true })
})

// --- Ausgaben (expenses / Belege) -----------------------------------------

// Allowed receipt uploads: a PDF or a photo/scan, capped so a stray huge file
// can't bloat the DB. Kept deliberately small — receipts are invoices and photos.
const RECEIPT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
const RECEIPT_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
  'image/tiff',
])

// List expenses, optionally filtered by Belegdatum range, category or free text,
// plus the matching summary (so the view gets totals for the current filter).
app.get('/api/expenses', requireAuth, (c) => {
  const filter = {
    from: c.req.query('from') || undefined,
    to: c.req.query('to') || undefined,
    category: c.req.query('category') || undefined,
    q: c.req.query('q') || undefined,
  }
  return c.json({ expenses: listExpenses(filter), summary: expenseSummary(filter) })
})

app.get('/api/expenses/:id', requireAuth, (c) => {
  const exp = getExpense(Number(c.req.param('id')))
  if (!exp) return c.json({ error: 'not found' }, 404)
  return c.json({ expense: exp })
})

app.post('/api/expenses', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const gross = Math.round(Number(b.gross_cents))
  if (!Number.isFinite(gross) || gross <= 0) {
    return c.json({ error: 'Bruttobetrag (Cent) muss positiv sein.' }, 400)
  }
  const exp = createExpense(
    {
      vendor: (b.vendor as string) ?? null,
      category: (b.category as string) ?? null,
      description: (b.description as string) ?? null,
      expense_date: (b.expense_date as string) ?? null,
      paid_on: (b.paid_on as string) ?? null,
      gross_cents: gross,
      vat_rate: Number(b.vat_rate ?? 19),
      payment_method: (b.payment_method as string) ?? null,
      note: (b.note as string) ?? null,
    },
    c.get('user').username,
  )
  audit({ actor: c.get('user').username, action: 'expense.create', entity: 'expense', entityId: exp.id, detail: { gross_cents: exp.gross_cents, category: exp.category, vendor: exp.vendor } })
  emit('expense.created', { id: exp.id, gross_cents: exp.gross_cents, category: exp.category })
  return c.json({ expense: exp }, 201)
})

app.patch('/api/expenses/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  if ('gross_cents' in b) {
    const gross = Math.round(Number(b.gross_cents))
    if (!Number.isFinite(gross) || gross <= 0) {
      return c.json({ error: 'Bruttobetrag (Cent) muss positiv sein.' }, 400)
    }
    b.gross_cents = gross
  }
  const exp = updateExpense(id, b)
  if (!exp) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'expense.update', entity: 'expense', entityId: id, detail: { fields: Object.keys(b) } })
  emit('expense.updated', { id, gross_cents: exp.gross_cents, category: exp.category })
  return c.json({ expense: exp })
})

app.delete('/api/expenses/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!deleteExpense(id)) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'expense.delete', entity: 'expense', entityId: id })
  emit('expense.deleted', { id })
  return c.json({ ok: true })
})

// Attach / replace the receipt scan. multipart/form-data field name: "file".
app.post('/api/expenses/:id/receipt', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  if (!getExpense(id)) return c.json({ error: 'not found' }, 404)
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
  if (file.size > RECEIPT_MAX_BYTES) {
    return c.json({ error: 'Datei zu groß (max. 10 MB).' }, 413)
  }
  const mime = file.type || 'application/octet-stream'
  if (!RECEIPT_MIMES.has(mime)) {
    return c.json({ error: 'Nicht unterstütztes Format — PDF oder Bild (PNG/JPEG/…) erwartet.' }, 415)
  }
  const data = new Uint8Array(await file.arrayBuffer())
  const exp = setReceipt(id, { data, name: file.name || `beleg-${id}`, mime })
  audit({ actor: c.get('user').username, action: 'expense.receipt.upload', entity: 'expense', entityId: id, detail: { name: file.name, bytes: data.byteLength } })
  return c.json({ expense: exp })
})

// Download / view the receipt scan inline.
app.get('/api/expenses/:id/receipt', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const receipt = getReceipt(id)
  if (!receipt) return c.json({ error: 'not found' }, 404)
  c.header('Content-Type', receipt.mime)
  // RFC 5987 filename* for non-ASCII receipt names (umlauts), with an ASCII fallback.
  const asciiName = receipt.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  c.header(
    'Content-Disposition',
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(receipt.name)}`,
  )
  return c.body(Buffer.from(receipt.data) as unknown as ArrayBuffer)
})

app.delete('/api/expenses/:id/receipt', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  const exp = deleteReceipt(id)
  if (!exp) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'expense.receipt.delete', entity: 'expense', entityId: id })
  return c.json({ expense: exp })
})

// --- Abonnements (recurring outgoing subscriptions) ------------------------

app.get('/api/subscriptions', requireAuth, (c) => {
  const activeOnly = c.req.query('active') === '1'
  return c.json({ subscriptions: listSubscriptions(activeOnly), summary: subscriptionSummary() })
})

app.get('/api/subscriptions/:id', requireAuth, (c) => {
  const sub = getSubscription(Number(c.req.param('id')))
  if (!sub) return c.json({ error: 'not found' }, 404)
  return c.json({ subscription: sub })
})

app.post('/api/subscriptions', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const amount = Math.round(Number(b.amount_cents))
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
  }
  const sub = createSubscription(
    {
      vendor: (b.vendor as string) ?? null,
      description: (b.description as string) ?? null,
      category: (b.category as string) ?? null,
      amount_cents: amount,
      vat_rate: Number(b.vat_rate ?? 19),
      cadence: (b.cadence as string) ?? null,
      next_renewal: (b.next_renewal as string) ?? null,
      payment_method: (b.payment_method as string) ?? null,
      active: b.active as number | boolean | undefined,
      note: (b.note as string) ?? null,
    },
    c.get('user').username,
  )
  audit({ actor: c.get('user').username, action: 'subscription.create', entity: 'subscription', entityId: sub.id, detail: { vendor: sub.vendor, amount_cents: sub.amount_cents, cadence: sub.cadence } })
  return c.json({ subscription: sub }, 201)
})

app.patch('/api/subscriptions/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  if ('amount_cents' in b) {
    const amount = Math.round(Number(b.amount_cents))
    if (!Number.isFinite(amount) || amount <= 0) {
      return c.json({ error: 'Betrag (Cent) muss positiv sein.' }, 400)
    }
    b.amount_cents = amount
  }
  const sub = updateSubscription(id, b)
  if (!sub) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'subscription.update', entity: 'subscription', entityId: id, detail: { fields: Object.keys(b) } })
  return c.json({ subscription: sub })
})

app.delete('/api/subscriptions/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!deleteSubscription(id)) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'subscription.delete', entity: 'subscription', entityId: id })
  return c.json({ ok: true })
})

// --- scraper (config + status) --------------------------------------------

// Fallback defaults if the operator hasn't customised the lists yet. Trades are
// generic German Handwerk (region-neutral); towns and region are intentionally
// empty so nothing location-specific ships — the operator sets their own area in
// the Scraper settings (`using_defaults` tells the panel when they haven't).
const DEFAULT_SCRAPER = {
  trades: [
    'Schreiner', 'Maler', 'Dachdecker', 'Elektro', 'Sanitär Heizung',
    'Metallbau', 'Glaser', 'Bodenleger', 'Raumausstatter', 'GaLaBau',
  ],
  towns: [] as string[],
  region: '',
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
  const region = (s.scraper_region ?? '').trim()
  return c.json({
    trades: trades.length ? trades : DEFAULT_SCRAPER.trades,
    towns: towns.length ? towns : DEFAULT_SCRAPER.towns,
    region: region || DEFAULT_SCRAPER.region,
    min_score: s.scraper_min_score ?? DEFAULT_SCRAPER.min_score,
    max_pairs: s.scraper_max_pairs ?? DEFAULT_SCRAPER.max_pairs,
    per_pair: s.scraper_per_pair ?? DEFAULT_SCRAPER.per_pair,
    using_defaults: { trades: trades.length === 0, towns: towns.length === 0, region: !region },
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
  return c.json({
    total, scraped, last, today, byStage, recent,
    run: scrapeRunState(),
    reachable: scraperReachable(),
    service_token_configured: serviceTokenConfigured(),
  })
})

// Trigger a discovery run from the UI. Fire-and-poll: returns immediately, then
// the panel watches /api/scraper/status for progress and the final result. A
// `dry` run uses offline fixtures (no Anthropic key, no cost) for testing.
app.post('/api/scraper/run', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { dry?: boolean }
  const r = startScrape({ dry: !!b.dry })
  if (!r.started) return c.json({ error: r.detail ?? 'Konnte nicht starten.' }, 409)
  audit({ actor: c.get('user').username, action: 'scraper.run', detail: { dry: !!b.dry } })
  return c.json({ started: true })
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

app.get('/api/export/expenses.csv', requireAuth, (c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  const expenses = expensesInRange(from, to)
  audit({ actor: c.get('user').username, action: 'export.expenses', detail: { from, to, count: expenses.length } })
  return csvResponse(c, expensesCsv(expenses), exportFilename('ausgaben', from, to))
})

app.get('/api/export/expenses-datev.csv', requireAuth, (c) => {
  const from = c.req.query('from')
  const to = c.req.query('to')
  const expenses = expensesInRange(from, to)
  audit({ actor: c.get('user').username, action: 'export.expenses_datev', detail: { from, to, count: expenses.length } })
  return csvResponse(c, expensesDatevCsv(expenses, getSettings()), exportFilename('ausgaben-datev', from, to))
})

// Export the lead pipeline as CSV — the counterpart to the .xlsx import. Honours
// the same stage/q filters as GET /api/leads, so it exports what you're viewing.
app.get('/api/export/leads.csv', requireAuth, (c) => {
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
    .prepare(`SELECT * FROM leads ${where} ORDER BY score DESC, created_at DESC`)
    .all(...params) as unknown as LeadRow[]
  audit({ actor: c.get('user').username, action: 'export.leads', detail: { stage, q, count: rows.length } })
  return csvResponse(c, leadsCsv(rows), exportFilename('leads'))
})

// --- admin: database backup (operator owns their data) ---------------------

// A full DB snapshot contains every tenant's data — admin-only (the route lives
// under /api/admin but was previously gated by requireAuth, so any member could
// pull the whole database; tightened to requireAdmin).
app.get('/api/admin/backup', requireAdmin, (c) => {
  const buf = snapshot()
  audit({ actor: c.get('user').username, action: 'admin.backup', detail: { bytes: buf.length } })
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Disposition', `attachment; filename="${snapshotFilename()}"`)
  return c.body(buf as unknown as ArrayBuffer)
})

// Restore a previously downloaded snapshot — the upload counterpart to the backup
// download. Validates the file, then replaces the live data in one transaction
// (rolls back on any failure). Admin-only and audited; destructive by design.
const RESTORE_MAX_BYTES = 200 * 1024 * 1024 // 200 MB
app.post('/api/admin/restore', requireAdmin, async (c) => {
  const form = await c.req.parseBody()
  const file = form['file']
  if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
  if (file.size > RESTORE_MAX_BYTES) return c.json({ error: 'Datei zu groß (max. 200 MB).' }, 413)
  let result
  try {
    result = restoreFromBuffer(Buffer.from(await file.arrayBuffer()))
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
  audit({ actor: c.get('user').username, action: 'admin.restore', detail: { ...result, bytes: file.size } })
  return c.json({ ok: true, ...result })
})

// --- dashboard (read-only KPIs) -------------------------------------------

app.get('/api/dashboard', requireAuth, (c) => c.json({ dashboard: buildDashboard() }))

// EÜR / period financial report (revenue − expenses by category + USt position).
app.get('/api/report/euer', requireAuth, (c) => {
  const from = c.req.query('from') || undefined
  const to = c.req.query('to') || undefined
  return c.json({ report: buildEuer(from, to) })
})

// --- users (multi-user; management is admin-only) -------------------------

// Any signed-in user may read the roster (for the lead-assignment dropdown).
app.get('/api/users', requireAuth, (c) => c.json({ users: listUsers() }))

app.post('/api/users', requireAdmin, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const user = createUser(String(b.username ?? ''), String(b.password ?? ''), b.role)
    audit({ actor: c.get('user').username, action: 'user.create', entity: 'user', entityId: user.id, detail: { username: user.username, role: user.role } })
    return c.json({ user }, 201)
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.patch('/api/users/:id', requireAdmin, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  try {
    const user = updateUser(id, {
      role: b.role,
      password: typeof b.password === 'string' && b.password ? b.password : undefined,
    })
    if (!user) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'user.update', entity: 'user', entityId: id, detail: { role: user.role, password_reset: typeof b.password === 'string' && !!b.password } })
    return c.json({ user })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

app.delete('/api/users/:id', requireAdmin, (c) => {
  const id = Number(c.req.param('id'))
  if (id === c.get('user').id) return c.json({ error: 'Das eigene Konto kann nicht gelöscht werden.' }, 400)
  try {
    if (!deleteUser(id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'user.delete', entity: 'user', entityId: id })
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400)
  }
})

// --- Serienrechnungen (recurring invoices) --------------------------------

app.get('/api/recurring', requireAuth, (c) => c.json({ recurring: listRecurring() }))

app.post('/api/recurring', requireAuth, async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = createRecurring(b)
  audit({ actor: c.get('user').username, action: 'recurring.create', entity: 'recurring', entityId: r.id, detail: { cadence: r.cadence, next_run: r.next_run } })
  return c.json({ recurring: r }, 201)
})

app.patch('/api/recurring/:id', requireAuth, async (c) => {
  const id = Number(c.req.param('id'))
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = updateRecurring(id, b)
  if (!r) return c.json({ error: 'not found' }, 404)
  return c.json({ recurring: r })
})

app.delete('/api/recurring/:id', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!deleteRecurring(id)) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'recurring.delete', entity: 'recurring', entityId: id })
  return c.json({ ok: true })
})

// Generate a draft invoice from a template now (and advance its schedule).
app.post('/api/recurring/:id/run', requireAuth, (c) => {
  const id = Number(c.req.param('id'))
  if (!getRecurring(id)) return c.json({ error: 'not found' }, 404)
  const doc = runRecurring(id)
  if (!doc) return c.json({ error: 'not found' }, 404)
  audit({ actor: c.get('user').username, action: 'recurring.run', entity: 'recurring', entityId: id, detail: { document_id: doc.id } })
  return c.json({ document: doc }, 201)
})

// Generate drafts for every due template (the scheduler calls the same path).
app.post('/api/recurring/run-due', requireAuth, (c) => {
  const result = processDueRecurring()
  if (result.generated) {
    audit({ actor: c.get('user').username, action: 'recurring.run_due', detail: result })
  }
  return c.json(result)
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

// --- recurring-invoice scheduler ------------------------------------------
// Generate drafts for due Serienrechnungen on an interval. Drafts only (no
// number, no send), so this never acts on its own beyond preparing work for a
// human. Set RECURRING_DISABLE=1 to turn it off.
if (process.env.RECURRING_DISABLE !== '1') {
  const runDue = () => {
    try {
      const { generated } = processDueRecurring()
      if (generated) console.log(`recurring: ${generated} Rechnungsentwurf/-entwürfe erzeugt`)
    } catch (e) {
      console.warn('recurring scheduler error:', (e as Error).message)
    }
  }
  setTimeout(runDue, 15_000).unref() // shortly after boot
  setInterval(runDue, 6 * 60 * 60 * 1000).unref() // every 6h
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
