import { db, type RecurringInvoiceRow } from './db'
import { getDocument, replaceItems, type DocItemInput, type FullDocument } from './documents'
import { getCustomer } from './customers'
import { getContract, type FullContract } from './contracts'

// Serienrechnungen (recurring invoices). A template carries the client, the line
// items and a cadence; each period it spawns a *draft* Rechnung (no number, no
// send) that a human reviews and finalises. That keeps the in-the-loop principle
// — nothing leaves the building automatically — while removing the retype.
// Optional contract_id links the billing plan to a Vertrag (e.g. Wartungsvertrag).

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
  customer_id?: number | null
  contract_id?: number | null
  title?: string | null
  intro?: string | null
  notes?: string | null
  items?: DocItemInput[]
  small_business?: number | boolean | null
  vat_rate?: number | null
  cadence?: string | null
  next_run?: string | null
  active?: number | boolean | null
  include_payment_link?: number | boolean | null
}

export interface RecurringListOpts {
  customer_id?: number
  contract_id?: number
  active?: boolean
}

function bool(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt
  return v ? 1 : 0
}

export function listRecurring(opts: RecurringListOpts = {}): RecurringInvoiceRow[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.customer_id != null) {
    where.push('customer_id = ?')
    params.push(Number(opts.customer_id))
  }
  if (opts.contract_id != null) {
    where.push('contract_id = ?')
    params.push(Number(opts.contract_id))
  }
  if (opts.active === true) {
    where.push('active = 1')
  } else if (opts.active === false) {
    where.push('active = 0')
  }
  const sql =
    'SELECT * FROM recurring_invoices' +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY active DESC, next_run, id'
  return db.prepare(sql).all(...params) as unknown as RecurringInvoiceRow[]
}

export function getRecurring(id: number): RecurringInvoiceRow | null {
  return (
    (db.prepare('SELECT * FROM recurring_invoices WHERE id = ?').get(id) as unknown as
      | RecurringInvoiceRow
      | undefined) ?? null
  )
}

/** One line from contract value when items are not supplied. */
export function defaultItemsFromContract(k: FullContract): DocItemInput[] {
  if (!k.value_cents || k.value_cents <= 0) return []
  const ref = k.number ? `Vertrag ${k.number}` : (k.title ?? 'Vertrag')
  return [
    {
      description: `Leistung laut ${ref}`,
      quantity: 1,
      unit: 'Monat',
      unit_price_cents: k.value_cents,
    },
  ]
}

export function createRecurring(input: RecurringInput): RecurringInvoiceRow {
  const next_run = input.next_run || new Date().toISOString().slice(0, 10)

  // Resolve optional FKs (unknown → error, not silent null).
  let customer = null as ReturnType<typeof getCustomer>
  if (input.customer_id != null) {
    customer = getCustomer(Number(input.customer_id))
    if (!customer) throw new Error('Kunde nicht gefunden.')
  }
  let contract = null as FullContract | null
  if (input.contract_id != null) {
    contract = getContract(Number(input.contract_id))
    if (!contract) throw new Error('Vertrag nicht gefunden.')
  }

  // Prefill: explicit > contract snapshot > customer (> lead for remaining nulls).
  if (!customer && contract?.customer_id != null) {
    customer = getCustomer(contract.customer_id)
  }

  let name = input.client_name ?? contract?.client_name ?? customer?.name ?? null
  let address = input.client_address ?? contract?.client_address ?? customer?.address ?? null
  let zip = input.client_zip ?? contract?.client_zip ?? customer?.zip ?? null
  let city = input.client_city ?? contract?.client_city ?? customer?.city ?? null
  let email = input.client_email ?? contract?.client_email ?? customer?.email ?? null
  const clientType =
    input.client_type ?? contract?.client_type ?? customer?.client_type ?? 'geschaeft'
  const leadId =
    input.lead_id != null
      ? Number(input.lead_id)
      : (contract?.lead_id ?? customer?.lead_id ?? null)

  if (leadId) {
    const lead = db.prepare('SELECT company, city, email FROM leads WHERE id = ?').get(leadId) as
      | { company: string | null; city: string | null; email: string | null }
      | undefined
    if (lead) {
      name = name ?? lead.company
      city = city ?? lead.city
      email = email ?? lead.email
    }
  }

  const info = db
    .prepare(
      `INSERT INTO recurring_invoices
        (client_name, client_address, client_zip, client_city, client_email, client_type,
         lead_id, customer_id, contract_id, title, intro, notes, items, small_business, vat_rate,
         cadence, next_run, active, include_payment_link)
       VALUES
        (@client_name, @client_address, @client_zip, @client_city, @client_email, @client_type,
         @lead_id, @customer_id, @contract_id, @title, @intro, @notes, @items, @small_business, @vat_rate,
         @cadence, @next_run, @active, @include_payment_link)`,
    )
    .run({
      client_name: name,
      client_address: address,
      client_zip: zip,
      client_city: city,
      client_email: email,
      client_type: clientType === 'privat' ? 'privat' : 'geschaeft',
      lead_id: leadId,
      customer_id: customer?.id ?? contract?.customer_id ?? null,
      contract_id: contract?.id ?? null,
      title: input.title ?? contract?.title ?? null,
      intro: input.intro ?? null,
      notes: input.notes ?? null,
      items: JSON.stringify(Array.isArray(input.items) ? input.items : []),
      small_business: bool(
        input.small_business,
        contract ? contract.small_business : 1,
      ),
      vat_rate: Number(input.vat_rate ?? contract?.vat_rate ?? 19),
      cadence: input.cadence && input.cadence in MONTHS_PER_CADENCE ? input.cadence : 'monatlich',
      next_run,
      active: bool(input.active, 1),
      include_payment_link: bool(input.include_payment_link, 1),
    })
  return getRecurring(Number(info.lastInsertRowid))!
}

/**
 * Create a Serienrechnung billing plan from a Vertrag (Wartungsvertrag etc.).
 * items: undefined → default from value_cents; explicit array (incl. []) is kept.
 */
export function recurringFromContract(
  contractId: number,
  input: RecurringInput = {},
): RecurringInvoiceRow {
  const k = getContract(contractId)
  if (!k) throw new Error('Vertrag nicht gefunden.')
  return createRecurring({
    contract_id: k.id,
    customer_id: input.customer_id ?? k.customer_id,
    client_name: input.client_name ?? k.client_name,
    client_address: input.client_address ?? k.client_address,
    client_zip: input.client_zip ?? k.client_zip,
    client_city: input.client_city ?? k.client_city,
    client_email: input.client_email ?? k.client_email,
    client_type: input.client_type ?? k.client_type,
    lead_id: input.lead_id ?? k.lead_id,
    title: input.title ?? k.title ?? 'Serienrechnung',
    intro: input.intro,
    notes: input.notes,
    small_business: input.small_business ?? k.small_business,
    vat_rate: input.vat_rate ?? k.vat_rate,
    cadence: input.cadence ?? 'monatlich',
    next_run: input.next_run ?? k.start_date ?? new Date().toISOString().slice(0, 10),
    items: input.items !== undefined ? input.items : defaultItemsFromContract(k),
    active: input.active,
    include_payment_link: input.include_payment_link,
  })
}

const EDITABLE_COLS = new Set([
  'client_name', 'client_address', 'client_zip', 'client_city', 'client_email', 'client_type',
  'lead_id', 'customer_id', 'contract_id', 'title', 'intro', 'notes', 'small_business', 'vat_rate',
  'cadence', 'next_run', 'active', 'include_payment_link',
])

export function updateRecurring(id: number, patch: RecurringInput): RecurringInvoiceRow | null {
  if (!getRecurring(id)) return null
  // Link-only for customer/contract: never auto-copy client_* on PATCH.
  if (patch.customer_id !== undefined && patch.customer_id !== null) {
    if (!getCustomer(Number(patch.customer_id))) throw new Error('Kunde nicht gefunden.')
  }
  if (patch.contract_id !== undefined && patch.contract_id !== null) {
    if (!getContract(Number(patch.contract_id))) throw new Error('Vertrag nicht gefunden.')
  }
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
    if (key === 'small_business' || key === 'active' || key === 'include_payment_link') v = value ? 1 : 0
    else if (key === 'customer_id' || key === 'lead_id' || key === 'contract_id') {
      v = value == null || value === '' ? null : Number(value)
    } else v = (value as string | number | null) ?? null
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
        (kind, lead_id, customer_id, client_name, client_address, client_zip, client_city, client_email,
         client_type, title, intro, notes, small_business, vat_rate, include_payment_link)
       VALUES
        ('rechnung', @lead_id, @customer_id, @client_name, @client_address, @client_zip, @client_city, @client_email,
         @client_type, @title, @intro, @notes, @small_business, @vat_rate, @include_payment_link)`,
    )
    .run({
      lead_id: tmpl.lead_id,
      customer_id: tmpl.customer_id,
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
      include_payment_link: tmpl.include_payment_link,
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
