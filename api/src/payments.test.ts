import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Isolate to a throwaway DB so the test never touches a real leads.db. DB_PATH is
// read when db.ts is first evaluated, so set it before the dynamic import.
const DB_FILE = join(tmpdir(), `openleads-payments-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { getDocument } = await import('./documents')
const { addPayment, deletePayment, paidCents, listPayments } = await import('./payments')

after(() => {
  try {
    db.close()
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(DB_FILE + suffix)
    } catch {
      /* ignore */
    }
  }
})

let seq = 0
/** A finalised §19 invoice (gross = sum of items) worth `gross` cents. */
function makeInvoice(gross: number): number {
  seq++
  const info = db
    .prepare(
      `INSERT INTO documents (kind, number, status, small_business, vat_rate, client_type, issue_date, due_date)
       VALUES ('rechnung', ?, 'versendet', 1, 19, 'geschaeft', '2026-06-01', '2026-06-15')`,
    )
    .run(`RE-2026-${String(seq).padStart(4, '0')}`)
  const id = Number(info.lastInsertRowid)
  db.prepare(
    'INSERT INTO document_items (document_id, description, quantity, unit_price_cents, sort) VALUES (?, ?, 1, ?, 0)',
  ).run(id, 'Leistung', gross)
  return id
}

test('a partial payment leaves the invoice open; the closing payment marks it paid', () => {
  const id = makeInvoice(100000)
  addPayment(id, { amount_cents: 40000 })
  assert.equal(paidCents(id), 40000)
  assert.equal(getDocument(id)!.status, 'versendet')

  addPayment(id, { amount_cents: 60000 })
  assert.equal(paidCents(id), 100000)
  assert.equal(getDocument(id)!.status, 'bezahlt')
})

test('an overpayment still marks the invoice paid', () => {
  const id = makeInvoice(50000)
  addPayment(id, { amount_cents: 60000 })
  assert.equal(getDocument(id)!.status, 'bezahlt')
})

test('deleting a payment reopens a previously paid invoice', () => {
  const id = makeInvoice(100000)
  const p1 = addPayment(id, { amount_cents: 50000 })
  addPayment(id, { amount_cents: 50000 })
  assert.equal(getDocument(id)!.status, 'bezahlt')

  deletePayment(p1.id)
  assert.equal(paidCents(id), 50000)
  assert.equal(getDocument(id)!.status, 'versendet')
  assert.equal(listPayments(id).length, 1)
})

test('getDocument exposes paid_cents', () => {
  const id = makeInvoice(30000)
  addPayment(id, { amount_cents: 10000 })
  assert.equal(getDocument(id)!.paid_cents, 10000)
})
