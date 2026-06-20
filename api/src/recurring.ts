import { db, type RecurringInvoiceRow } from './db'
import { getDocument, replaceItems, type DocItemInput, type FullDocument } from './documents'

// Serienrechnungen (recurring invoices). A template carries the client, the line
// items and a cadence; each period it spawns a *draft* Rechnung (no number, no
// send) that a human reviews and finalises. That keeps the in-the-loop principle
// — nothing leaves the building automatically — while removing the retype.

const MONTHS_PER_CADENCE: Record<string, number> = {
  monatlich: 1,
  quartalsweise: 3,
  jährlich: 12,
}

/** Add whole months to a YYYY-MM-DD date, clamping the day to the month's end. */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, 1))
  base.setUTCMonth(base.getUTCMonth() + n)
  const year = base.getUTCFullYear()
  const month = base.getUTCMonth()
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Next issue date for a cadence, starting from `from` (defaults to monthly). */
export function advanceDate(from: string, cadence: string): string {
  return addMonths(from, MONTHS_PER_CADENCE[cadence] ?? 1)
}

export interface RecurringInput {
  client_name?: string | null
  client_address?: string | null
  client_zip?: string | null
  client_city?: string | null
  client_email?: string | null
  client_type?: string | null
  lead_id?: number | null
  title?: string | null
  intro?: string | null
  notes?: string | null
  items?: DocItemInput[]
  small_business?: number | boolean | null
  vat_rate?: number | null
  cadence?: string | null
  next_run?: string | null
  active?: number | boolean | null
}

function bool(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt
  return v ? 1 : 0
}

export function listRecurring(): RecurringInvoiceRow[] {
  return db
    .prepare('SELECT * FROM recurring_invoices ORDER BY active DESC, next_run, id')
    .all() as unknown as RecurringInvoiceRow[]
}

export function getRecurring(id: number): RecurringInvoiceRow | null {
  return (
    (db.prepare('SELECT * FROM recurring_invoices WHERE id = ?').get(id) as unknown as
      | RecurringInvoiceRow
      | undefined) ?? null
  )
}

export function createRecurring(input: RecurringInput): RecurringInvoiceRow {
  const next_run = input.next_run || new Date().toISOString().slice(0, 10)
  const info = db
    .prepare(
      `INSERT INTO recurring_invoices
        (client_name, client_address, client_zip, client_city, client_email, client_type,
         lead_id, title, intro, notes, items, small_business, vat_rate, cadence, next_run, active)
       VALUES
        (@client_name, @client_address, @client_zip, @client_city, @client_email, @client_type,
         @lead_id, @title, @intro, @notes, @items, @small_business, @vat_rate, @cadence, @next_run, @active)`,
    )
    .run({
      client_name: input.client_name ?? null,
      client_address: input.client_address ?? null,
      client_zip: input.client_zip ?? null,
      client_city: input.client_city ?? null,
      client_email: input.client_email ?? null,
      client_type: input.client_type === 'privat' ? 'privat' : 'geschaeft',
      lead_id: input.lead_id ?? null,
      title: input.title ?? null,
      intro: input.intro ?? null,
      notes: input.notes ?? null,
      items: JSON.stringify(Array.isArray(input.items) ? input.items : []),
      small_business: bool(input.small_business, 1),
      vat_rate: Number(input.vat_rate ?? 19),
      cadence: input.cadence && input.cadence in MONTHS_PER_CADENCE ? input.cadence : 'monatlich',
      next_run,
      active: bool(input.active, 1),
    })
  return getRecurring(Number(info.lastInsertRowid))!
}

const EDITABLE_COLS = new Set([
  'client_name', 'client_address', 'client_zip', 'client_city', 'client_email', 'client_type',
  'lead_id', 'title', 'intro', 'notes', 'small_business', 'vat_rate', 'cadence', 'next_run', 'active',
])

export function updateRecurring(id: number, patch: RecurringInput): RecurringInvoiceRow | null {
  if (!getRecurring(id)) return null
  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'items') {
      sets.push('items = @items')
      params.items = JSON.stringify(Array.isArray(value) ? value : [])
      continue
    }
    if (!EDITABLE_COLS.has(key)) continue
    let v: string | number | null
    if (key === 'small_business' || key === 'active') v = value ? 1 : 0
    else v = (value as string | number | null) ?? null
    sets.push(`${key} = @${key}`)
    params[key] = v
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE recurring_invoices SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getRecurring(id)
}

export function deleteRecurring(id: number): boolean {
  const r = db.prepare('DELETE FROM recurring_invoices WHERE id = ?').run(id)
  return r.changes > 0
}

/**
 * Materialise one draft Rechnung from a template and advance its schedule.
 * The generated document is a plain draft (status 'entwurf', no number), so it
 * never consumes an invoice number until a human finalises it.
 */
export function runRecurring(id: number, today: string = new Date().toISOString().slice(0, 10)): FullDocument | null {
  const tmpl = getRecurring(id)
  if (!tmpl) return null
  const info = db
    .prepare(
      `INSERT INTO documents
        (kind, lead_id, client_name, client_address, client_zip, client_city, client_email,
         client_type, title, intro, notes, small_business, vat_rate)
       VALUES
        ('rechnung', @lead_id, @client_name, @client_address, @client_zip, @client_city, @client_email,
         @client_type, @title, @intro, @notes, @small_business, @vat_rate)`,
    )
    .run({
      lead_id: tmpl.lead_id,
      client_name: tmpl.client_name,
      client_address: tmpl.client_address,
      client_zip: tmpl.client_zip,
      client_city: tmpl.client_city,
      client_email: tmpl.client_email,
      client_type: tmpl.client_type,
      title: tmpl.title ?? 'Rechnung',
      intro: tmpl.intro,
      notes: tmpl.notes,
      small_business: tmpl.small_business,
      vat_rate: tmpl.vat_rate,
    })
  const docId = Number(info.lastInsertRowid)
  let items: DocItemInput[] = []
  try {
    items = JSON.parse(tmpl.items) as DocItemInput[]
  } catch {
    items = []
  }
  if (items.length) replaceItems(docId, items)
  db.prepare(
    "UPDATE recurring_invoices SET last_run = ?, next_run = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(today, advanceDate(tmpl.next_run, tmpl.cadence), id)
  return getDocument(docId)
}

/** Generate drafts for every active template whose next_run is due (<= today). */
export function processDueRecurring(today: string = new Date().toISOString().slice(0, 10)): {
  generated: number
  document_ids: number[]
} {
  const due = db
    .prepare('SELECT id FROM recurring_invoices WHERE active = 1 AND next_run <= ? ORDER BY next_run, id')
    .all(today) as unknown as { id: number }[]
  const document_ids: number[] = []
  for (const r of due) {
    const doc = runRecurring(r.id, today)
    if (doc) document_ids.push(doc.id)
  }
  return { generated: document_ids.length, document_ids }
}
