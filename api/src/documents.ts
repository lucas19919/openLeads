import { db, DOC_KINDS, type DocumentRow, type DocumentItemRow, type SettingsRow } from './db'

export interface DocItemInput {
  description?: string | null
  quantity?: number
  unit?: string | null
  unit_price_cents?: number
}

export interface DocTotals {
  net_cents: number
  vat_cents: number
  gross_cents: number
}

export interface FullDocument extends Omit<DocumentRow, 'signed_doc_data'> {
  items: DocumentItemRow[]
  totals: DocTotals
  /** Sum of recorded payments (cents). `gross_cents - paid_cents` = open amount. */
  paid_cents: number
  /** Whether a signed/returned copy is stored (the bytes never ship in JSON). */
  has_signed_doc: boolean
}

export function getSettings(): SettingsRow {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as SettingsRow
}

// node:sqlite has no .transaction() helper (unlike better-sqlite3) — wrap manually.
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/** Body keys a PATCH may write on a draft (the route maps them 1:1 to columns). */
export const DOC_EDITABLE = new Set([
  'client_name', 'client_address', 'client_zip', 'client_city', 'client_email',
  'client_type', 'title', 'intro', 'notes', 'due_date', 'small_business', 'vat_rate',
  'buyer_reference', 'client_vat_id', 'customer_id', 'lead_id',
])

// Once a document carries a number it is issued and GoBD-immutable. Only the
// Stamm-links and post-issuance metadata may still change — never the content
// the number was assigned to (recipient block, items, tax posture).
const DOC_EDITABLE_FINAL = new Set([
  'customer_id', 'lead_id', 'due_date', 'client_type', 'client_email',
])

/** Throws when a PATCH body would touch frozen content of an issued document. */
export function assertDocumentPatchable(finalised: boolean, body: Record<string, unknown>): void {
  if (!finalised) return
  const offending = Object.keys(body).filter(
    (k) => (k === 'items' || DOC_EDITABLE.has(k)) && !DOC_EDITABLE_FINAL.has(k),
  )
  if (offending.length)
    throw new Error(
      `Festgeschriebene Dokumente sind unveränderlich (GoBD); nicht änderbar: ${offending.join(', ')}.`,
    )
}

/** Net/VAT/gross from line items. §19 (Kleinunternehmer) → no VAT line. */
export function computeTotals(
  items: Pick<DocumentItemRow, 'quantity' | 'unit_price_cents'>[],
  smallBusiness: boolean,
  vatRate: number,
): DocTotals {
  const net_cents = items.reduce(
    (sum, it) => sum + Math.round(it.quantity * it.unit_price_cents),
    0,
  )
  const vat_cents = smallBusiness ? 0 : Math.round((net_cents * vatRate) / 100)
  return { net_cents, vat_cents, gross_cents: net_cents + vat_cents }
}

// Explicit column list so reads never drag the signed-document BLOB (up to
// 10 MB per row) through memory just to render a list or a JSON detail. The
// flag (signed_doc_data IS NOT NULL) stands in for the bytes.
const DOC_COLUMNS =
  'id, kind, number, lead_id, customer_id, client_name, client_address, client_zip, ' +
  'client_city, client_email, title, intro, notes, status, issue_date, due_date, ' +
  'small_business, vat_rate, buyer_reference, client_type, client_vat_id, ' +
  'corrects_document_id, ' +
  'created_at, updated_at, signed_doc_name, signed_doc_mime, signed_doc_size, ' +
  '(signed_doc_data IS NOT NULL) AS has_signed_doc'

type DocRowLite = Omit<DocumentRow, 'signed_doc_data'> & { has_signed_doc: number }

function assemble(doc: DocRowLite, items: DocumentItemRow[], paidCents: number): FullDocument {
  const { has_signed_doc, ...rest } = doc
  return {
    ...rest,
    items,
    totals: computeTotals(items, !!doc.small_business, doc.vat_rate),
    paid_cents: paidCents,
    has_signed_doc: !!has_signed_doc,
  }
}

/** Fetch a document with its sorted items and computed totals, or null. */
export function getDocument(id: number): FullDocument | null {
  const doc = db.prepare(`SELECT ${DOC_COLUMNS} FROM documents WHERE id = ?`).get(id) as unknown as
    | DocRowLite
    | undefined
  if (!doc) return null
  const items = db
    .prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY sort, id')
    .all(id) as unknown as DocumentItemRow[]
  const paid = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS p FROM payments WHERE document_id = ?')
    .get(id) as unknown as { p: number }
  return assemble(doc, items, paid.p)
}

/**
 * List documents (optionally by kind), newest first, with items and totals.
 * Three fixed queries total — items and payments are fetched in bulk and
 * bucketed, instead of two extra queries per document (the old N+1).
 */
export function listDocuments(kind?: string, customerId?: number): FullDocument[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (kind) {
    where.push('kind = ?')
    params.push(kind)
  }
  if (customerId != null) {
    where.push('customer_id = ?')
    params.push(customerId)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const docs = db
    .prepare(`SELECT ${DOC_COLUMNS} FROM documents ${whereSql} ORDER BY created_at DESC, id DESC`)
    .all(...params) as unknown as DocRowLite[]
  if (docs.length === 0) return []

  // Only load items/payments for the returned docs (not the whole tables).
  const ids = docs.map((d) => d.id)
  const placeholders = ids.map(() => '?').join(',')

  const itemsByDoc = new Map<number, DocumentItemRow[]>()
  const allItems = db
    .prepare(
      `SELECT * FROM document_items WHERE document_id IN (${placeholders}) ORDER BY document_id, sort, id`,
    )
    .all(...ids) as unknown as DocumentItemRow[]
  for (const it of allItems) {
    const bucket = itemsByDoc.get(it.document_id)
    if (bucket) bucket.push(it)
    else itemsByDoc.set(it.document_id, [it])
  }

  const paidByDoc = new Map<number, number>()
  const paidRows = db
    .prepare(
      `SELECT document_id, COALESCE(SUM(amount_cents), 0) AS p FROM payments
        WHERE document_id IN (${placeholders})
        GROUP BY document_id`,
    )
    .all(...ids) as unknown as { document_id: number; p: number }[]
  for (const r of paidRows) paidByDoc.set(r.document_id, r.p)

  return docs.map((d) => assemble(d, itemsByDoc.get(d.id) ?? [], paidByDoc.get(d.id) ?? 0))
}

/** Replace all line items of a document in one transaction. */
export function replaceItems(documentId: number, items: DocItemInput[]): void {
  tx(() => {
    db.prepare('DELETE FROM document_items WHERE document_id = ?').run(documentId)
    const ins = db.prepare(
      `INSERT INTO document_items (document_id, description, quantity, unit, unit_price_cents, sort)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    items.forEach((it, i) => {
      ins.run(
        documentId,
        it.description ?? null,
        Number(it.quantity ?? 1),
        it.unit ?? null,
        Math.round(Number(it.unit_price_cents ?? 0)),
        i,
      )
    })
  })
}

/**
 * Finalise a draft document in a single transaction: assign the next gapless
 * number (<PREFIX><YEAR>-<0001>), set issue/due dates, and mark it 'versendet'.
 *
 * Number assignment and the document write share one transaction so the counter
 * can never be consumed without the matching invoice — gaplessness is a legal
 * requirement (§14 UStG / GoBD). The counter only ever increases, so the
 * sequence stays gapless across a year boundary too.
 *
 * Returns the finalised document, the already-finalised document unchanged if it
 * had a number, or null if the id doesn't exist.
 */
export function finalizeDraft(id: number): FullDocument | null {
  return tx(() => {
    const doc = db
      .prepare('SELECT id, kind, number, corrects_document_id FROM documents WHERE id = ?')
      .get(id) as unknown as
      | Pick<DocumentRow, 'id' | 'kind' | 'number' | 'corrects_document_id'>
      | undefined
    if (!doc) return null
    if (doc.number) return getDocument(id) // already finalised — no-op
    const s = getSettings()
    const kind = doc.kind as (typeof DOC_KINDS)[number]
    const prefix = kind === 'rechnung' ? s.rechnung_prefix : s.angebot_prefix
    const next = kind === 'rechnung' ? s.rechnung_next : s.angebot_next
    const col = kind === 'rechnung' ? 'rechnung_next' : 'angebot_next'
    const number = `${prefix}${new Date().getFullYear()}-${String(next).padStart(4, '0')}`
    const today = new Date().toISOString().slice(0, 10)
    const due = new Date(Date.now() + s.payment_terms * 86400000).toISOString().slice(0, 10)
    db.prepare(`UPDATE settings SET ${col} = ? WHERE id = 1`).run(next + 1)
    db.prepare(
      `UPDATE documents
         SET number = ?, issue_date = ?, due_date = COALESCE(due_date, ?),
             status = 'versendet', updated_at = datetime('now')
       WHERE id = ?`,
    ).run(number, today, kind === 'rechnung' ? due : null, id)
    // Finalising a Stornorechnung is the moment the cancellation becomes real:
    // the corrected original flips to 'storniert' in the same transaction.
    if (doc.corrects_document_id != null) {
      db.prepare(
        `UPDATE documents SET status = 'storniert', updated_at = datetime('now') WHERE id = ?`,
      ).run(doc.corrects_document_id)
    }
    return getDocument(id)
  })
}

/**
 * Create a draft Stornorechnung (Korrekturrechnung) for a finalised Rechnung:
 * the same recipient snapshot and items with negated unit prices, plus a
 * reference to the original number (§14 UStG). The original is NOT touched yet
 * — it flips to 'storniert' when the Storno is finalised (see finalizeDraft),
 * so an abandoned draft leaves the books unchanged.
 */
export function stornoFromDocument(id: number): FullDocument {
  const orig = getDocument(id)
  if (!orig) throw new Error('Rechnung nicht gefunden.')
  if (orig.kind !== 'rechnung' || !orig.number)
    throw new Error('Nur festgeschriebene Rechnungen können storniert werden.')
  if (orig.corrects_document_id != null)
    throw new Error('Eine Stornorechnung kann nicht storniert werden.')
  if (orig.status === 'storniert') throw new Error('Diese Rechnung ist bereits storniert.')
  const existing = db
    .prepare(
      `SELECT id, number FROM documents
        WHERE corrects_document_id = ? AND status != 'storniert'`,
    )
    .get(id) as unknown as { id: number; number: string | null } | undefined
  if (existing)
    throw new Error(
      `Zu dieser Rechnung existiert bereits eine Stornorechnung (${existing.number ?? `Entwurf #${existing.id}`}).`,
    )

  const [y, m, d] = (orig.issue_date ?? '').split('-')
  const issued = d && m && y ? `${d}.${m}.${y}` : orig.issue_date
  const info = db
    .prepare(
      `INSERT INTO documents
        (kind, lead_id, customer_id, corrects_document_id, client_name, client_address,
         client_zip, client_city, client_email, client_vat_id, buyer_reference, client_type,
         title, intro, small_business, vat_rate)
       VALUES
        ('rechnung', @lead_id, @customer_id, @corrects_document_id, @client_name, @client_address,
         @client_zip, @client_city, @client_email, @client_vat_id, @buyer_reference, @client_type,
         @title, @intro, @small_business, @vat_rate)`,
    )
    .run({
      lead_id: orig.lead_id,
      customer_id: orig.customer_id ?? null,
      corrects_document_id: orig.id,
      client_name: orig.client_name,
      client_address: orig.client_address,
      client_zip: orig.client_zip,
      client_city: orig.client_city,
      client_email: orig.client_email,
      client_vat_id: orig.client_vat_id ?? null,
      buyer_reference: orig.buyer_reference ?? null,
      client_type: orig.client_type,
      title: `Stornorechnung zu ${orig.number}`,
      intro: `Storno zur Rechnung ${orig.number} vom ${issued}. Die Positionen werden vollständig gutgeschrieben.`,
      small_business: orig.small_business,
      vat_rate: orig.vat_rate,
    })
  const newId = Number(info.lastInsertRowid)
  replaceItems(
    newId,
    orig.items.map((it) => ({
      description: it.description,
      quantity: it.quantity,
      unit: it.unit,
      unit_price_cents: -it.unit_price_cents,
    })),
  )
  return getDocument(newId)!
}

// --- signed/returned-copy store (the signed Angebot/Rechnung the client returns) -

export interface SignedDocInput {
  data: Uint8Array
  name: string
  mime: string
}

/** Attach (or replace) the signed/returned scan or PDF on a document. */
export function setDocumentSignedDoc(id: number, doc: SignedDocInput): FullDocument | null {
  if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(id)) return null
  db.prepare(
    `UPDATE documents
       SET signed_doc_data = ?, signed_doc_name = ?, signed_doc_mime = ?, signed_doc_size = ?,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(doc.data, doc.name, doc.mime, doc.data.byteLength, id)
  return getDocument(id)
}

/** Remove the stored signed copy, keeping the document itself. */
export function deleteDocumentSignedDoc(id: number): FullDocument | null {
  if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(id)) return null
  db.prepare(
    `UPDATE documents
       SET signed_doc_data = NULL, signed_doc_name = NULL, signed_doc_mime = NULL, signed_doc_size = NULL,
           updated_at = datetime('now')
     WHERE id = ?`,
  ).run(id)
  return getDocument(id)
}

/** Fetch the stored signed-copy bytes + metadata for download, or null. */
export function getDocumentSignedDoc(id: number): { data: Uint8Array; name: string; mime: string } | null {
  const row = db
    .prepare('SELECT signed_doc_data, signed_doc_name, signed_doc_mime FROM documents WHERE id = ?')
    .get(id) as unknown as
    | { signed_doc_data: Uint8Array | null; signed_doc_name: string | null; signed_doc_mime: string | null }
    | undefined
  if (!row || !row.signed_doc_data) return null
  return {
    data: row.signed_doc_data,
    name: row.signed_doc_name || `Dokument-${id}`,
    mime: row.signed_doc_mime || 'application/octet-stream',
  }
}
