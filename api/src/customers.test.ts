import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-customers-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  createCustomer,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  listCustomers,
  customerOverview,
} = await import('./customers')
const { createContract, getContract, updateContract, setSignedDoc, setContractStatus } =
  await import('./contracts')
const { createRecurring, updateRecurring } = await import('./recurring')
const { addPayment } = await import('./payments')

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

test('createCustomer requires a name and round-trips', () => {
  assert.throws(() => createCustomer({ name: '  ' }), /Name/)
  const c = createCustomer({ name: 'Bäckerei Huber', city: 'München', email: 'huber@x.de', vat_id: 'DE123456789' })
  assert.equal(c.name, 'Bäckerei Huber')
  assert.equal(c.client_type, 'geschaeft')
  assert.equal(c.active, 1)
  assert.deepEqual(getCustomer(c.id), c)
})

test('update + active filter + delete', () => {
  const c = createCustomer({ name: 'Alt GmbH' })
  updateCustomer(c.id, { active: 0, city: 'Köln' })
  assert.equal(getCustomer(c.id)!.city, 'Köln')
  assert.ok(!listCustomers(true).some((x) => x.id === c.id)) // inactive excluded
  assert.ok(listCustomers(false).some((x) => x.id === c.id))
  assert.equal(deleteCustomer(c.id), true)
  assert.equal(getCustomer(c.id), null)
})

test('a contract created from a customer prefills the client snapshot + links the id', () => {
  const c = createCustomer({ name: 'Vertrag GmbH', address: 'Hauptstr. 1', zip: '80331', city: 'München', client_type: 'privat' })
  const k = createContract({ customer_id: c.id, title: 'Wartung', value_cents: 10000 })
  assert.equal(k.customer_id, c.id)
  assert.equal(k.client_name, 'Vertrag GmbH')
  assert.equal(k.client_city, 'München')
  assert.equal(k.client_type, 'privat') // carried from the customer
  // Editing the customer afterwards must NOT change the contract snapshot.
  updateCustomer(c.id, { name: 'Umbenannt GmbH' })
  assert.equal(getContract(k.id)!.client_name, 'Vertrag GmbH')
})

test('an explicit client field overrides the customer prefill', () => {
  const c = createCustomer({ name: 'Standard GmbH', city: 'München' })
  const k = createContract({ customer_id: c.id, client_name: 'Sondername', title: 'X' })
  assert.equal(k.client_name, 'Sondername')
  assert.equal(k.client_city, 'München') // not overridden → from customer
})

test('a recurring template created from a customer prefills + links', () => {
  const c = createCustomer({ name: 'Serie GmbH', email: 's@x.de' })
  const r = createRecurring({ customer_id: c.id, title: 'Hosting', cadence: 'monatlich' })
  assert.equal(r.customer_id, c.id)
  assert.equal(r.client_name, 'Serie GmbH')
  assert.equal(r.client_email, 's@x.de')
})

test('unknown customer_id on create throws; link-on-edit does not rewrite snapshot', () => {
  assert.throws(() => createContract({ customer_id: 999999, title: 'X' }), /Kunde nicht gefunden/)
  assert.throws(() => createRecurring({ customer_id: 999999 }), /Kunde nicht gefunden/)

  const c1 = createCustomer({ name: 'Link A', city: 'München' })
  const c2 = createCustomer({ name: 'Link B', city: 'Berlin' })
  const k = createContract({ customer_id: c1.id, title: 'Wartung' })
  assert.equal(k.client_name, 'Link A')
  const updated = updateContract(k.id, { customer_id: c2.id })!
  assert.equal(updated.customer_id, c2.id)
  assert.equal(updated.client_name, 'Link A') // snapshot untouched
  assert.throws(() => updateContract(k.id, { customer_id: 999999 }), /Kunde nicht gefunden/)

  const r = createRecurring({ customer_id: c1.id, title: 'Serie' })
  const ru = updateRecurring(r.id, { customer_id: c2.id })!
  assert.equal(ru.customer_id, c2.id)
  assert.equal(ru.client_name, 'Link A')
})

/** Finalised §19 invoice linked to a customer, single line item = gross. */
function makeCustomerInvoice(customerId: number, gross: number, opts: { number?: string; status?: string } = {}): number {
  const num = opts.number ?? `RE-T-${customerId}-${gross}-${Math.random().toString(36).slice(2, 6)}`
  const info = db
    .prepare(
      `INSERT INTO documents
        (kind, number, status, customer_id, client_name, small_business, vat_rate, client_type, issue_date)
       VALUES ('rechnung', ?, ?, ?, 'Test', 1, 19, 'geschaeft', '2026-06-01')`,
    )
    .run(num, opts.status ?? 'versendet', customerId)
  const id = Number(info.lastInsertRowid)
  db.prepare(
    'INSERT INTO document_items (document_id, description, quantity, unit_price_cents, sort) VALUES (?, ?, 1, ?, 0)',
  ).run(id, 'Leistung', gross)
  return id
}

test('customerOverview aggregates KPIs (partial payment, quotes, active contracts) and surfaces signed flag', () => {
  const c = createCustomer({ name: 'Overview GmbH', city: 'München' })
  const inv1 = makeCustomerInvoice(c.id, 11900) // 119 €
  const inv2 = makeCustomerInvoice(c.id, 5000)
  addPayment(inv1, { amount_cents: 5000 })
  // Draft quote counts; storno invoice must not.
  db.prepare(
    `INSERT INTO documents (kind, number, status, customer_id, client_name, small_business, vat_rate, client_type)
     VALUES ('angebot', NULL, 'entwurf', ?, 'Overview GmbH', 1, 19, 'geschaeft')`,
  ).run(c.id)
  makeCustomerInvoice(c.id, 9999, { number: `RE-ST-${c.id}`, status: 'storniert' })

  const kAktiv = createContract({ customer_id: c.id, title: 'Aktiv', value_cents: 1000 })
  // Force status aktiv without finalise (number stays null — fine for KPI).
  setContractStatus(kAktiv.id, 'aktiv')
  createContract({ customer_id: c.id, title: 'Entwurf' }) // status entwurf
  createRecurring({ customer_id: c.id, title: 'Hosting', active: 1 })
  createRecurring({ customer_id: c.id, title: 'Pause', active: 0 })

  setSignedDoc(kAktiv.id, {
    data: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    name: 'signiert.pdf',
    mime: 'application/pdf',
  })

  const o = customerOverview(c.id)!
  assert.equal(o.kpis.invoices_count, 2)
  assert.equal(o.kpis.invoiced_gross_cents, 11900 + 5000)
  assert.equal(o.kpis.paid_cents, 5000)
  assert.equal(o.kpis.open_cents, (11900 - 5000) + 5000)
  assert.equal(o.kpis.quotes_count, 1)
  assert.equal(o.kpis.contracts_active, 1)
  assert.equal(o.kpis.contracts_total, 2)
  assert.equal(o.kpis.series_active, 1)

  const signed = o.contracts.find((x) => x.id === kAktiv.id)
  assert.ok(signed)
  assert.equal(signed!.has_signed_doc, true)
  assert.equal(signed!.signed_doc_name, 'signiert.pdf')
  assert.equal((signed as unknown as { signed_doc_data?: unknown }).signed_doc_data, undefined)
})

test('customerOverview returns null for missing customer; list caps do not shrink KPIs', () => {
  assert.equal(customerOverview(999999), null)

  const c = createCustomer({ name: 'Many Invoices GmbH' })
  // 22 finalised invoices × 100 cents; list is capped at 20 but KPI must count all.
  for (let i = 0; i < 22; i++) {
    makeCustomerInvoice(c.id, 100, { number: `RE-MANY-${c.id}-${i}` })
  }
  const o = customerOverview(c.id)!
  assert.equal(o.kpis.invoices_count, 22)
  assert.equal(o.kpis.invoiced_gross_cents, 2200)
  assert.equal(o.documents.length, 20)
})
