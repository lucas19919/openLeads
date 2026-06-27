import { db, type CustomerRow } from './db'

// Kunden (customer registry). A client maintained once and reused. The client
// fields on a document/contract/template are still a value snapshot — see
// customerClientFields() — so editing a customer never rewrites issued papers.

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


