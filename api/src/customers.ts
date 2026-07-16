import { db, type CustomerRow } from './db'

// Kunden (customer registry). A client maintained once and reused. The client
// fields on a document/contract/template are still a value snapshot — so editing
// a customer never rewrites issued papers. The overview restores the prior
// per-client cockpit (KPIs + linked tables); KPIs use unbounded aggregates,
// lists are capped (LIMIT 20).

export interface CustomerInput {
  name?: string | null
  contact_name?: string | null
  address?: string | null
  zip?: string | null
  city?: string | null
  email?: string | null
  phone?: string | null
  vat_id?: string | null
  client_type?: string | null
  payment_terms?: number | null
  lead_id?: number | null
  notes?: string | null
  active?: number | boolean | null
}

function bool(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt
  return v ? 1 : 0
}

export function listCustomers(activeOnly = false): CustomerRow[] {
  const where = activeOnly ? 'WHERE active = 1' : ''
  return db
    .prepare(`SELECT * FROM customers ${where} ORDER BY name COLLATE NOCASE, id`)
    .all() as unknown as CustomerRow[]
}

export function getCustomer(id: number): CustomerRow | null {
  return (
    (db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as unknown as CustomerRow | undefined) ??
    null
  )
}

/** First customer linked to a pipeline lead (if any). */
export function getCustomerByLeadId(leadId: number): CustomerRow | null {
  return (
    (db
      .prepare('SELECT * FROM customers WHERE lead_id = ? ORDER BY id LIMIT 1')
      .get(leadId) as unknown as CustomerRow | undefined) ?? null
  )
}

export function createCustomer(input: CustomerInput): CustomerRow {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('Name ist erforderlich.')
  const info = db
    .prepare(
      `INSERT INTO customers
        (name, contact_name, address, zip, city, email, phone, vat_id, client_type, payment_terms, lead_id, notes, active)
       VALUES
        (@name, @contact_name, @address, @zip, @city, @email, @phone, @vat_id, @client_type, @payment_terms, @lead_id, @notes, @active)`,
    )
    .run({
      name,
      contact_name: input.contact_name ?? null,
      address: input.address ?? null,
      zip: input.zip ?? null,
      city: input.city ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      vat_id: input.vat_id ?? null,
      client_type: input.client_type === 'privat' ? 'privat' : 'geschaeft',
      payment_terms: input.payment_terms != null ? Math.round(Number(input.payment_terms)) : null,
      lead_id: input.lead_id != null ? Number(input.lead_id) : null,
      notes: input.notes ?? null,
      active: bool(input.active, 1),
    })
  return getCustomer(Number(info.lastInsertRowid))!
}

const EDITABLE_COLS = new Set([
  'name', 'contact_name', 'address', 'zip', 'city', 'email', 'phone', 'vat_id',
  'client_type', 'payment_terms', 'lead_id', 'notes', 'active',
])

export function updateCustomer(id: number, patch: CustomerInput): CustomerRow | null {
  if (!getCustomer(id)) return null
  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_COLS.has(key)) continue
    let v: string | number | null
    if (key === 'active') v = value ? 1 : 0
    else if (key === 'name') {
      const n = String(value ?? '').trim()
      if (!n) throw new Error('Name ist erforderlich.')
      v = n
    } else if (key === 'payment_terms') v = value == null || value === '' ? null : Math.round(Number(value))
    else if (typeof value === 'boolean') v = value ? 1 : 0
    else v = (value as string | number | null) ?? null
    sets.push(`${key} = @${key}`)
    params[key] = v
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getCustomer(id)
}

export function deleteCustomer(id: number): boolean {
  // Documents keep their value snapshot; the FK is ON DELETE SET NULL, so deleting
  // a customer just unlinks it — issued papers are unaffected.
  const r = db.prepare('DELETE FROM customers WHERE id = ?').run(id)
  return r.changes > 0
}

// --- Customer overview (per-client cockpit) ---------------------------------

const LIST_LIMIT = 20

export interface CustomerOverviewKpis {
  invoices_count: number
  invoiced_gross_cents: number
  paid_cents: number
  open_cents: number
  quotes_count: number
  contracts_active: number
  contracts_total: number
  series_active: number
}

export interface CustomerOverviewDoc {
  id: number
  kind: string
  number: string | null
  status: string
  title: string | null
  issue_date: string | null
  gross_cents: number
  paid_cents: number
  open_cents: number
  has_signed_doc: boolean
}

export interface CustomerOverviewContract {
  id: number
  number: string | null
  type: string
  status: string
  title: string | null
  value_cents: number
  start_date: string | null
  end_date: string | null
  has_signed_doc: boolean
  signed_doc_name: string | null
}

export interface CustomerOverviewRecurring {
  id: number
  title: string | null
  cadence: string
  next_run: string
  active: number
  contract_id: number | null
  contract_number: string | null
}

export interface CustomerOverview {
  customer: CustomerRow
  kpis: CustomerOverviewKpis
  documents: CustomerOverviewDoc[]
  contracts: CustomerOverviewContract[]
  recurring: CustomerOverviewRecurring[]
}

type DocMoneyRow = {
  id: number
  kind: string
  number: string | null
  status: string
  title: string | null
  issue_date: string | null
  small_business: number
  vat_rate: number
  has_signed_doc: number | null
}

/** Same net/VAT/gross math as documents.computeTotals (kept local to avoid import cycles). */
function docGross(
  items: { quantity: number; unit_price_cents: number }[],
  smallBusiness: boolean,
  vatRate: number,
): number {
  const net = items.reduce((sum, it) => sum + Math.round(it.quantity * it.unit_price_cents), 0)
  const vat = smallBusiness ? 0 : Math.round((net * vatRate) / 100)
  return net + vat
}

/** Gross/paid for a set of document ids (bulk items + payments). */
function moneyByDocIds(ids: number[]): Map<number, { gross: number; paid: number }> {
  const out = new Map<number, { gross: number; paid: number }>()
  if (!ids.length) return out

  const meta = db
    .prepare(
      `SELECT id, small_business, vat_rate FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as unknown as { id: number; small_business: number; vat_rate: number }[]
  const metaById = new Map(meta.map((m) => [m.id, m]))

  const items = db
    .prepare(
      `SELECT document_id, quantity, unit_price_cents FROM document_items
        WHERE document_id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(...ids) as unknown as { document_id: number; quantity: number; unit_price_cents: number }[]
  const itemsByDoc = new Map<number, { quantity: number; unit_price_cents: number }[]>()
  for (const it of items) {
    const bucket = itemsByDoc.get(it.document_id)
    if (bucket) bucket.push(it)
    else itemsByDoc.set(it.document_id, [it])
  }

  const paidRows = db
    .prepare(
      `SELECT document_id, COALESCE(SUM(amount_cents), 0) AS p FROM payments
        WHERE document_id IN (${ids.map(() => '?').join(',')})
        GROUP BY document_id`,
    )
    .all(...ids) as unknown as { document_id: number; p: number }[]
  const paidByDoc = new Map(paidRows.map((r) => [r.document_id, r.p]))

  for (const docId of ids) {
    const m = metaById.get(docId)
    if (!m) continue
    out.set(docId, {
      gross: docGross(itemsByDoc.get(docId) ?? [], !!m.small_business, m.vat_rate),
      paid: paidByDoc.get(docId) ?? 0,
    })
  }
  return out
}

/**
 * Per-customer cockpit: full KPI aggregates (unbounded) + capped linked lists.
 * Returns null if the customer does not exist. Phase A: no contract_id on series.
 */
export function customerOverview(id: number): CustomerOverview | null {
  const customer = getCustomer(id)
  if (!customer) return null

  // --- KPI aggregates (no LIMIT) ---
  // Storno pairs net to zero: cancelled originals and their Stornorechnungen
  // are both excluded from the money KPIs (the lists below still show them).
  const invoices = db
    .prepare(
      `SELECT id, small_business, vat_rate FROM documents
        WHERE customer_id = ? AND kind = 'rechnung'
          AND number IS NOT NULL AND status != 'storniert'
          AND corrects_document_id IS NULL`,
    )
    .all(id) as unknown as { id: number; small_business: number; vat_rate: number }[]
  const invoiceIds = invoices.map((d) => d.id)
  const money = moneyByDocIds(invoiceIds)

  let invoiced_gross_cents = 0
  let paid_cents = 0
  let open_cents = 0
  for (const invId of invoiceIds) {
    const m = money.get(invId) ?? { gross: 0, paid: 0 }
    invoiced_gross_cents += m.gross
    paid_cents += m.paid
    open_cents += Math.max(0, m.gross - m.paid)
  }

  const quotes_count = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM documents WHERE customer_id = ? AND kind = 'angebot'`)
      .get(id) as { c: number }
  ).c
  const contracts_active = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM contracts WHERE customer_id = ? AND status = 'aktiv'`)
      .get(id) as { c: number }
  ).c
  const contracts_total = (
    db.prepare(`SELECT COUNT(*) AS c FROM contracts WHERE customer_id = ?`).get(id) as { c: number }
  ).c
  const series_active = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM recurring_invoices WHERE customer_id = ? AND active = 1`)
      .get(id) as { c: number }
  ).c

  const kpis: CustomerOverviewKpis = {
    invoices_count: invoiceIds.length,
    invoiced_gross_cents,
    paid_cents,
    open_cents,
    quotes_count,
    contracts_active,
    contracts_total,
    series_active,
  }

  // --- List windows (LIMIT 20) ---
  const docRows = db
    .prepare(
      `SELECT id, kind, number, status, title, issue_date, small_business, vat_rate,
              (signed_doc_data IS NOT NULL) AS has_signed_doc
         FROM documents WHERE customer_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`,
    )
    .all(id) as unknown as DocMoneyRow[]
  const listMoney = moneyByDocIds(docRows.map((d) => d.id))
  const documents: CustomerOverviewDoc[] = docRows.map((d) => {
    const m = listMoney.get(d.id) ?? { gross: 0, paid: 0 }
    return {
      id: d.id,
      kind: d.kind,
      number: d.number,
      status: d.status,
      title: d.title,
      issue_date: d.issue_date,
      gross_cents: m.gross,
      paid_cents: m.paid,
      open_cents: Math.max(0, m.gross - m.paid),
      has_signed_doc: !!d.has_signed_doc,
    }
  })

  const contractRows = db
    .prepare(
      `SELECT id, number, type, status, title, value_cents, start_date, end_date,
              signed_doc_name,
              (signed_doc_data IS NOT NULL) AS has_signed_doc
         FROM contracts WHERE customer_id = ?
         ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`,
    )
    .all(id) as unknown as {
    id: number
    number: string | null
    type: string
    status: string
    title: string | null
    value_cents: number
    start_date: string | null
    end_date: string | null
    signed_doc_name: string | null
    has_signed_doc: number | null
  }[]
  const contracts: CustomerOverviewContract[] = contractRows.map((r) => ({
    id: r.id,
    number: r.number,
    type: r.type,
    status: r.status,
    title: r.title,
    value_cents: r.value_cents,
    start_date: r.start_date,
    end_date: r.end_date,
    has_signed_doc: !!r.has_signed_doc,
    signed_doc_name: r.signed_doc_name,
  }))

  const recurring = db
    .prepare(
      `SELECT r.id, r.title, r.cadence, r.next_run, r.active, r.contract_id,
              c.number AS contract_number
         FROM recurring_invoices r
         LEFT JOIN contracts c ON c.id = r.contract_id
        WHERE r.customer_id = ?
        ORDER BY r.active DESC, r.next_run, r.id LIMIT ${LIST_LIMIT}`,
    )
    .all(id) as unknown as CustomerOverviewRecurring[]

  return { customer, kpis, documents, contracts, recurring }
}


