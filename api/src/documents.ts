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

export interface FullDocument extends DocumentRow {
  items: DocumentItemRow[]
  totals: DocTotals
  /** Sum of recorded payments (cents). `gross_cents - paid_cents` = open amount. */
  paid_cents: number
}

export function getSettings(): SettingsRow {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get() as unknown as SettingsRow
}

// node:sqlite has no .transaction() helper (unlike better-sqlite3) — wrap manually.
function tx<T>(fn: () => T): T {
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

/** Fetch a document with its sorted items and computed totals, or null. */
export function getDocument(id: number): FullDocument | null {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
    | DocumentRow
    | undefined
  if (!doc) return null
  const items = db
    .prepare('SELECT * FROM document_items WHERE document_id = ? ORDER BY sort, id')
    .all(id) as unknown as DocumentItemRow[]
  const paid = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS p FROM payments WHERE document_id = ?')
    .get(id) as unknown as { p: number }
  return {
    ...doc,
    items,
    totals: computeTotals(items, !!doc.small_business, doc.vat_rate),
    paid_cents: paid.p,
  }
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
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as unknown as
      | DocumentRow
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
    return getDocument(id)
  })
}
