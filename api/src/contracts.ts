import { db, CONTRACT_TYPES, CONTRACT_STATUSES, type ContractRow, type SettingsRow } from './db'
import { getSettings, getDocument, tx } from './documents'
import { getCustomer } from './customers'

// Verträge (contracts). A contract is a standalone agreement with a client. It is
// drafted, finalised (which assigns a gapless number and freezes the AGB text in
// force at that moment), sent for signature, then marked aktiv once countersigned.
// Same in-the-loop posture as invoicing: nothing leaves the building on its own.

const TYPE_IDS = new Set(CONTRACT_TYPES.map((t) => t.id))

export interface ContractTotals {
  net_cents: number
  vat_cents: number
  gross_cents: number
}

// The client-facing shape: the contract minus the raw signed-document bytes, plus
// a has_signed_doc flag (mirrors the expense/receipt serialiser).
export interface FullContract extends Omit<ContractRow, 'signed_doc_data'> {
  totals: ContractTotals
  has_signed_doc: boolean
}

export interface ContractInput {
  type?: string | null
  lead_id?: number | null
  customer_id?: number | null
  document_id?: number | null
  client_name?: string | null
  client_address?: string | null
  client_zip?: string | null
  client_city?: string | null
  client_email?: string | null
  client_type?: string | null
  title?: string | null
  intro?: string | null
  body?: string | null
  value_cents?: number | null
  small_business?: number | boolean | null
  vat_rate?: number | null
  payment_terms?: string | null
  start_date?: string | null
  end_date?: string | null
  notice_period?: string | null
  notes?: string | null
}

function bool(v: unknown, dflt: number): number {
  if (v === undefined || v === null) return dflt
  return v ? 1 : 0
}

/** Gross from a contract's net value: §19 (Kleinunternehmer) carries no VAT. */
export function contractTotals(value_cents: number, smallBusiness: boolean, vatRate: number): ContractTotals {
  const net_cents = Math.round(value_cents)
  const vat_cents = smallBusiness ? 0 : Math.round((net_cents * vatRate) / 100)
  return { net_cents, vat_cents, gross_cents: net_cents + vat_cents }
}

function withTotals(row: ContractRow): FullContract {
  const { signed_doc_data, ...rest } = row
  return {
    ...rest,
    totals: contractTotals(row.value_cents, !!row.small_business, row.vat_rate),
    has_signed_doc: signed_doc_data != null,
  }
}

// SELECT list that omits the BLOB — listing signed-document bytes would be wasteful.
// (signed_doc_data IS NOT NULL) is aliased so withTotals can still set the flag.
const COLS_NO_BLOB =
  'id, number, type, lead_id, customer_id, document_id, client_name, client_address, ' +
  'client_zip, client_city, client_email, client_type, title, intro, body, agb_text, ' +
  'value_cents, small_business, vat_rate, payment_terms, start_date, end_date, notice_period, ' +
  'status, issue_date, signed_at, signed_by, signed_note, notes, created_by, created_at, ' +
  'updated_at, signed_doc_name, signed_doc_mime, signed_doc_size, ' +
  'CASE WHEN signed_doc_data IS NOT NULL THEN X\'01\' ELSE NULL END AS signed_doc_data'

export function listContracts(): FullContract[] {
  const rows = db
    .prepare(`SELECT ${COLS_NO_BLOB} FROM contracts ORDER BY created_at DESC, id DESC`)
    .all() as unknown as ContractRow[]
  return rows.map(withTotals)
}

export function getContract(id: number): FullContract | null {
  const row = db.prepare(`SELECT ${COLS_NO_BLOB} FROM contracts WHERE id = ?`).get(id) as unknown as
    | ContractRow
    | undefined
  return row ? withTotals(row) : null
}

export function createContract(input: ContractInput, createdBy?: string | null): FullContract {
  const s = getSettings()
  const type = input.type && TYPE_IDS.has(input.type as never) ? input.type : 'dienstvertrag'

  // Prefill precedence: explicit field > linked customer > linked lead.
  const customer = input.customer_id != null ? getCustomer(Number(input.customer_id)) : null
  let name = input.client_name ?? customer?.name ?? null
  let address = input.client_address ?? customer?.address ?? null
  let zip = input.client_zip ?? customer?.zip ?? null
  let city = input.client_city ?? customer?.city ?? null
  let email = input.client_email ?? customer?.email ?? null
  const clientType = input.client_type ?? customer?.client_type ?? 'geschaeft'
  const leadId = input.lead_id != null ? Number(input.lead_id) : customer?.lead_id ?? null
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
      `INSERT INTO contracts
        (type, lead_id, customer_id, document_id, client_name, client_address, client_zip, client_city,
         client_email, client_type, title, intro, body, value_cents, small_business, vat_rate,
         payment_terms, start_date, end_date, notice_period, notes, created_by)
       VALUES
        (@type, @lead_id, @customer_id, @document_id, @client_name, @client_address, @client_zip, @client_city,
         @client_email, @client_type, @title, @intro, @body, @value_cents, @small_business, @vat_rate,
         @payment_terms, @start_date, @end_date, @notice_period, @notes, @created_by)`,
    )
    .run({
      type,
      lead_id: leadId,
      customer_id: customer?.id ?? null,
      document_id: input.document_id != null ? Number(input.document_id) : null,
      client_name: name,
      client_address: address,
      client_zip: zip,
      client_city: city,
      client_email: email,
      client_type: clientType === 'privat' ? 'privat' : 'geschaeft',
      title: input.title ?? CONTRACT_TYPES.find((t) => t.id === type)?.label ?? 'Vertrag',
      intro: input.intro ?? null,
      body: input.body ?? null,
      value_cents: Math.round(Number(input.value_cents ?? 0)),
      small_business: bool(input.small_business, s.small_business),
      vat_rate: Number(input.vat_rate ?? s.vat_rate),
      payment_terms: input.payment_terms ?? null,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      notice_period: input.notice_period ?? null,
      notes: input.notes ?? null,
      created_by: createdBy ?? null,
    })
  return getContract(Number(info.lastInsertRowid))!
}

const EDITABLE_COLS = new Set([
  'type', 'lead_id', 'document_id', 'client_name', 'client_address', 'client_zip', 'client_city',
  'client_email', 'client_type', 'title', 'intro', 'body', 'value_cents', 'small_business',
  'vat_rate', 'payment_terms', 'start_date', 'end_date', 'notice_period', 'notes',
])

export function updateContract(id: number, patch: ContractInput): FullContract | null {
  if (!getContract(id)) return null
  const sets: string[] = []
  const params: Record<string, string | number | null> = { id }
  for (const [key, value] of Object.entries(patch)) {
    if (!EDITABLE_COLS.has(key)) continue
    if (key === 'type' && !(typeof value === 'string' && TYPE_IDS.has(value as never))) continue
    let v: string | number | null
    if (key === 'small_business') v = value ? 1 : 0
    else if (key === 'value_cents') v = Math.round(Number(value ?? 0))
    else if (typeof value === 'boolean') v = value ? 1 : 0
    else v = (value as string | number | null) ?? null
    sets.push(`${key} = @${key}`)
    params[key] = v
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE contracts SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }
  return getContract(id)
}

/** Set a status that isn't covered by finalise/sign (e.g. abgelehnt, beendet). */
export function setContractStatus(id: number, status: string): FullContract | null {
  if (!CONTRACT_STATUSES.includes(status as never)) throw new Error('Ungültiger Status.')
  const c = getContract(id)
  if (!c) return null
  db.prepare("UPDATE contracts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
  return getContract(id)
}

/**
 * Finalise a draft contract: assign the next gapless number, snapshot the AGB
 * text in force now, set the issue date, and mark it 'versendet'. The number and
 * the write share one transaction so the counter is never consumed without the
 * matching contract (gapless, like invoicing). Re-finalising is a no-op.
 */
export function finalizeContract(id: number): FullContract | null {
  return tx(() => {
    const row = db.prepare('SELECT * FROM contracts WHERE id = ?').get(id) as unknown as
      | ContractRow
      | undefined
    if (!row) return null
    if (row.number) return getContract(id) // already finalised — no-op
    const s = getSettings() as SettingsRow
    const prefix = s.contract_prefix ?? 'V-'
    const next = s.contract_next ?? 1
    const number = `${prefix}${new Date().getFullYear()}-${String(next).padStart(4, '0')}`
    const today = new Date().toISOString().slice(0, 10)
    db.prepare('UPDATE settings SET contract_next = ? WHERE id = 1').run(next + 1)
    db.prepare(
      `UPDATE contracts
         SET number = ?, issue_date = COALESCE(issue_date, ?), agb_text = ?,
             status = 'versendet', updated_at = datetime('now')
       WHERE id = ?`,
    ).run(number, today, s.agb_text ?? null, id)
    return getContract(id)
  })
}

/** Record acceptance/countersignature → status 'aktiv'. */
export function signContract(
  id: number,
  by: string | null,
  note: string | null,
  signedAt?: string | null,
): FullContract | null {
  const c = getContract(id)
  if (!c) return null
  if (!c.number) throw new Error('Nur festgeschriebene Verträge können als unterzeichnet markiert werden.')
  const at = signedAt || new Date().toISOString().slice(0, 10)
  db.prepare(
    `UPDATE contracts
       SET status = 'aktiv', signed_at = ?, signed_by = ?, signed_note = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(at, by ?? null, note ?? null, id)
  return getContract(id)
}

/**
 * Seed a draft contract from a document (typically an accepted Angebot): the
 * client block, customer/lead links, the net value and a Leistungsbeschreibung
 * built from the document's line items are carried over. Returns null if the
 * document doesn't exist. The contract is a draft (no number, AGB not yet frozen).
 */
export function contractFromDocument(docId: number, createdBy?: string | null): FullContract | null {
  const doc = getDocument(docId)
  if (!doc) return null
  const euro = (c: number) => (c / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
  const qty = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 })
  const lines = doc.items
    .filter((it) => (it.description ?? '').trim() || it.unit_price_cents !== 0)
    .map(
      (it) =>
        `• ${qty(it.quantity)}× ${it.description ?? 'Leistung'}${it.unit ? ` (${it.unit})` : ''} — ${euro(Math.round(it.quantity * it.unit_price_cents))}`,
    )
    .join('\n')
  const body =
    (doc.intro && doc.intro.trim() ? doc.intro.trim() + '\n\n' : '') +
    (lines ? `Gegenstand dieses Vertrags sind die folgenden Leistungen:\n${lines}` : '')
  return createContract(
    {
      type: 'werkvertrag',
      title: doc.title || `Vertrag zu ${doc.number ?? 'Angebot'}`,
      client_name: doc.client_name,
      client_address: doc.client_address,
      client_zip: doc.client_zip,
      client_city: doc.client_city,
      client_email: doc.client_email,
      client_type: doc.client_type,
      lead_id: doc.lead_id,
      customer_id: doc.customer_id,
      document_id: doc.id,
      body,
      value_cents: doc.totals.net_cents,
      small_business: doc.small_business,
      vat_rate: doc.vat_rate,
      notes: `Aus ${doc.kind === 'angebot' ? 'Angebot' : 'Rechnung'} ${doc.number ?? '(Entwurf)'} erstellt.`,
    },
    createdBy,
  )
}

export function deleteContract(id: number): { ok: boolean; reason?: string } {
  const row = db.prepare('SELECT number FROM contracts WHERE id = ?').get(id) as
    | { number: string | null }
    | undefined
  if (!row) return { ok: false, reason: 'not found' }
  // Keep the trail intact: a finalised (numbered) contract must not vanish.
  if (row.number) return { ok: false, reason: 'finalised' }
  db.prepare('DELETE FROM contracts WHERE id = ?').run(id)
  return { ok: true }
}

// --- signed-document store (the countersigned contract the client returns) ------

export interface SignedDocInput {
  data: Uint8Array
  name: string
  mime: string
}

/** Attach (or replace) the signed-document scan/PDF on a contract. */
export function setSignedDoc(id: number, doc: SignedDocInput): FullContract | null {
  if (!db.prepare('SELECT id FROM contracts WHERE id = ?').get(id)) return null
  db.prepare(
    `UPDATE contracts
       SET signed_doc_data = ?, signed_doc_name = ?, signed_doc_mime = ?, signed_doc_size = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(doc.data, doc.name, doc.mime, doc.data.byteLength, id)
  return getContract(id)
}

/** Remove the signed document, keeping the contract itself. */
export function deleteSignedDoc(id: number): FullContract | null {
  if (!db.prepare('SELECT id FROM contracts WHERE id = ?').get(id)) return null
  db.prepare(
    `UPDATE contracts
       SET signed_doc_data = NULL, signed_doc_name = NULL, signed_doc_mime = NULL, signed_doc_size = NULL,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(id)
  return getContract(id)
}

/** Fetch the signed-document bytes + metadata for download, or null if none. */
export function getSignedDoc(id: number): { data: Uint8Array; name: string; mime: string } | null {
  const row = db
    .prepare('SELECT signed_doc_data, signed_doc_name, signed_doc_mime FROM contracts WHERE id = ?')
    .get(id) as unknown as
    | { signed_doc_data: Uint8Array | null; signed_doc_name: string | null; signed_doc_mime: string | null }
    | undefined
  if (!row || !row.signed_doc_data) return null
  return {
    data: row.signed_doc_data,
    name: row.signed_doc_name || `Vertrag-${id}-unterschrieben`,
    mime: row.signed_doc_mime || 'application/octet-stream',
  }
}
