import { db, type PaymentRow } from './db'
import { getDocument, type FullDocument } from './documents'

// Payment recording for invoices. An invoice is settled by one or more payment
// rows; "paid" is their sum, which supports partial payments. Recording a
// payment that covers the open amount flips the invoice to 'bezahlt'; removing
// one that drops it back below the total reopens it to 'versendet'. Storno is
// never touched here.

export interface PaymentInput {
  amount_cents: number
  paid_on?: string | null
  method?: string | null
  note?: string | null
}

/** Sum of all payments recorded against a document, in cents. */
export function paidCents(documentId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS p FROM payments WHERE document_id = ?')
    .get(documentId) as unknown as { p: number }
  return row.p
}

export function listPayments(documentId: number): PaymentRow[] {
  return db
    .prepare('SELECT * FROM payments WHERE document_id = ? ORDER BY paid_on, id')
    .all(documentId) as unknown as PaymentRow[]
}

/**
 * Reconcile a finalised invoice's status with its recorded payments. Only acts
 * on issued invoices (a Rechnung with a number) that aren't storniert, and only
 * toggles between 'versendet' and 'bezahlt' — never overwrites a manual storno.
 * Returns the (possibly unchanged) document.
 */
function reconcileStatus(documentId: number): FullDocument | null {
  const doc = getDocument(documentId)
  if (!doc) return null
  if (doc.kind !== 'rechnung' || !doc.number || doc.status === 'storniert') return doc
  const fullyPaid = doc.paid_cents >= doc.totals.gross_cents && doc.totals.gross_cents > 0
  const target = fullyPaid ? 'bezahlt' : 'versendet'
  if (target !== doc.status && (doc.status === 'versendet' || doc.status === 'bezahlt')) {
    db.prepare("UPDATE documents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(
      target,
      documentId,
    )
    return getDocument(documentId)
  }
  return doc
}

export function addPayment(documentId: number, input: PaymentInput): PaymentRow {
  const paid_on = input.paid_on || new Date().toISOString().slice(0, 10)
  const info = db
    .prepare(
      'INSERT INTO payments (document_id, amount_cents, paid_on, method, note) VALUES (?, ?, ?, ?, ?)',
    )
    .run(documentId, Math.round(input.amount_cents), paid_on, input.method ?? null, input.note ?? null)
  reconcileStatus(documentId)
  return db
    .prepare('SELECT * FROM payments WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as unknown as PaymentRow
}

/** Delete a payment; returns the document id it belonged to (for re-reconcile), or null. */
export function deletePayment(paymentId: number): number | null {
  const row = db.prepare('SELECT document_id FROM payments WHERE id = ?').get(paymentId) as unknown as
    | { document_id: number }
    | undefined
  if (!row) return null
  db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId)
  reconcileStatus(row.document_id)
  return row.document_id
}
