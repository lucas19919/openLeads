import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Isolate to a throwaway DB so the test never touches a real leads.db. DB_PATH is
// read when db.ts is first evaluated, so set it before the dynamic import.
const DB_FILE = join(tmpdir(), `openleads-storno-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { getDocument, replaceItems, finalizeDraft, stornoFromDocument } = await import('./documents')
const { buildDashboard } = await import('./dashboard')
const { buildEuer } = await import('./report')
const { createCustomer, customerOverview } = await import('./customers')

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

/** Draft Rechnung with one 899,00 € line (§19 → gross = net). */
function makeDraftInvoice(customerId?: number): number {
  const info = db
    .prepare(
      `INSERT INTO documents (kind, customer_id, client_name, client_city, client_type, small_business, vat_rate)
       VALUES ('rechnung', ?, 'Storno Test GmbH', 'München', 'geschaeft', 1, 19)`,
    )
    .run(customerId ?? null)
  const id = Number(info.lastInsertRowid)
  replaceItems(id, [
    { description: 'Website Starter', quantity: 1, unit: 'pauschal', unit_price_cents: 89_900 },
  ])
  return id
}

test('stornoFromDocument negates a finalised Rechnung and links it', () => {
  const id = makeDraftInvoice()
  const orig = finalizeDraft(id)!
  assert.ok(orig.number)

  const storno = stornoFromDocument(id)
  assert.equal(storno.kind, 'rechnung')
  assert.equal(storno.number, null) // draft — reviewed and finalised by a human
  assert.equal(storno.corrects_document_id, id)
  assert.equal(storno.client_name, 'Storno Test GmbH')
  assert.equal(storno.title, `Stornorechnung zu ${orig.number}`)
  assert.match(storno.intro ?? '', new RegExp(orig.number!))
  assert.equal(storno.items.length, 1)
  assert.equal(storno.items[0].unit_price_cents, -89_900)
  assert.equal(storno.totals.gross_cents, -89_900)

  // The original is untouched until the Storno is finalised.
  assert.equal(getDocument(id)!.status, 'versendet')
})

test('storno rules: only finalised Rechnungen, no doubles, no storno-of-storno', () => {
  // Draft → refused.
  const draftId = makeDraftInvoice()
  assert.throws(() => stornoFromDocument(draftId), /festgeschriebene/)

  const id = makeDraftInvoice()
  finalizeDraft(id)
  const storno = stornoFromDocument(id)

  // Second storno while one is pending → refused.
  assert.throws(() => stornoFromDocument(id), /existiert bereits/)
  // A Storno cannot be storniert itself (even once finalised).
  finalizeDraft(storno.id)
  assert.throws(() => stornoFromDocument(storno.id), /Stornorechnung kann nicht/)
  // The original is now storniert → refused with the right message.
  assert.throws(() => stornoFromDocument(id), /bereits storniert/)
})

test('finalising the Storno flips the original and the pair nets to zero in every aggregate', () => {
  const c = createCustomer({ name: 'Storno KPIs GmbH' })
  const before = buildDashboard()
  const euerBefore = buildEuer()

  const id = makeDraftInvoice(c.id)
  finalizeDraft(id)
  const storno = stornoFromDocument(id)
  finalizeDraft(storno.id)

  // Original flipped in the same transaction; the Storno itself stays a
  // normal issued document.
  assert.equal(getDocument(id)!.status, 'storniert')
  assert.ok(getDocument(storno.id)!.number)

  // Dashboard: net revenue and open amounts unchanged by the pair.
  const after = buildDashboard()
  assert.equal(after.invoices.net_total_cents, before.invoices.net_total_cents)
  assert.equal(after.invoices.open_total_cents, before.invoices.open_total_cents)

  // EÜR: revenue unchanged by the pair.
  const euerAfter = buildEuer()
  assert.equal(euerAfter.revenue.net_cents, euerBefore.revenue.net_cents)

  // Customer KPIs: nothing invoiced or open left for this customer …
  const o = customerOverview(c.id)!
  assert.equal(o.kpis.invoiced_gross_cents, 0)
  assert.equal(o.kpis.open_cents, 0)
  // … but both papers remain visible in the linked list.
  assert.equal(o.documents.filter((d) => d.kind === 'rechnung').length, 2)
})
