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
  'include_payment_link, accounting_provider, accounting_external_id, accounting_pushed_at, ' +
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

  const itemsByDoc = new Map<number, DocumentItemRow[]>()
  const allItems = db
    .prepare('SELECT * FROM document_items ORDER BY document_id, sort, id')
    .all() as unknown as DocumentItemRow[]
  for (const it of allItems) {
    const bucket = itemsByDoc.get(it.document_id)
    if (bucket) bucket.push(it)
    else itemsByDoc.set(it.document_id, [it])
  }

  const paidByDoc = new Map<number, number>()
  const paidRows = db
    .prepare('SELECT document_id, COALESCE(SUM(amount_cents), 0) AS p FROM payments GROUP BY document_id')
    .all() as unknown as { document_id: number; p: number }[]
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
      .prepare('SELECT id, kind, number FROM documents WHERE id = ?')
      .get(id) as unknown as Pick<DocumentRow, 'id' | 'kind' | 'number'> | undefined
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
    return getDocument(id)
  })
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
