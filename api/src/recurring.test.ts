import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-recurring-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { getDocument } = await import('./documents')
const { createCustomer } = await import('./customers')
const { createContract, deleteContract } = await import('./contracts')
const {
  addMonths,
  advanceDate,
  createRecurring,
  getRecurring,
  runRecurring,
  processDueRecurring,
  recurringFromContract,
  listRecurring,
  defaultItemsFromContract,
} = await import('./recurring')

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

test('addMonths clamps the day to the target month end', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28') // Feb has no 31st
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29') // leap year
  assert.equal(addMonths('2026-01-15', 3), '2026-04-15')
  assert.equal(addMonths('2026-12-10', 1), '2027-01-10') // year rollover
})

test('advanceDate steps by cadence', () => {
  assert.equal(advanceDate('2026-06-20', 'monatlich'), '2026-07-20')
  assert.equal(advanceDate('2026-06-20', 'quartalsweise'), '2026-09-20')
  assert.equal(advanceDate('2026-06-20', 'jährlich'), '2027-06-20')
})

test('running a template emits a draft invoice and advances the schedule', () => {
  const r = createRecurring({
    client_name: 'Wartung GmbH',
    title: 'Wartungspauschale',
    items: [{ description: 'Hosting & Wartung', quantity: 1, unit: 'Monat', unit_price_cents: 9900 }],
    cadence: 'monatlich',
    next_run: '2026-06-01',
    small_business: 1,
  })
  const doc = runRecurring(r.id, '2026-06-01')!
  assert.equal(doc.kind, 'rechnung')
  assert.equal(doc.number, null) // a draft — no number consumed
  assert.equal(doc.status, 'entwurf')
  assert.equal(doc.client_name, 'Wartung GmbH')
  assert.equal(doc.items.length, 1)
  assert.equal(doc.totals.gross_cents, 9900)

  const after = getRecurring(r.id)!
  assert.equal(after.last_run, '2026-06-01')
  assert.equal(after.next_run, '2026-07-01')
})

test('processDueRecurring only fires templates that are due', () => {
  const due = createRecurring({ title: 'Fällig', next_run: '2026-06-01', items: [{ description: 'x', quantity: 1, unit: 'Stk', unit_price_cents: 1000 }] })
  const future = createRecurring({ title: 'Später', next_run: '2099-01-01', items: [] })

  const res = processDueRecurring('2026-06-15')
  assert.ok(res.generated >= 1)
  assert.ok(res.document_ids.every((id) => getDocument(id)?.status === 'entwurf'))
  // the future template did not advance
  assert.equal(getRecurring(future.id)!.next_run, '2099-01-01')
  // the due one did
  assert.notEqual(getRecurring(due.id)!.next_run, '2026-06-01')
})

test('recurringFromContract prefills client, links contract_id, default items from value', () => {
  const cust = createCustomer({ name: 'Host GmbH', city: 'München' })
  const k = createContract({
    customer_id: cust.id,
    type: 'wartungsvertrag',
    title: 'Hosting & Pflege',
    value_cents: 4900,
    start_date: '2026-07-01',
  })
  const r = recurringFromContract(k.id)
  assert.equal(r.contract_id, k.id)
  assert.equal(r.customer_id, cust.id)
  assert.equal(r.client_name, 'Host GmbH')
  assert.equal(r.client_city, 'München')
  assert.equal(r.title, 'Hosting & Pflege')
  assert.equal(r.next_run, '2026-07-01')
  const items = JSON.parse(r.items) as { unit_price_cents: number; description: string }[]
  assert.equal(items.length, 1)
  assert.equal(items[0].unit_price_cents, 4900)
  assert.match(items[0].description, /Hosting|Vertrag|Leistung/)

  assert.throws(() => recurringFromContract(999999), /Vertrag nicht gefunden/)
  assert.throws(() => createRecurring({ contract_id: 999999 }), /Vertrag nicht gefunden/)
})

test('listRecurring filters by contract_id / customer_id in SQL', () => {
  const c = createCustomer({ name: 'Filter Kunde' })
  const k = createContract({ customer_id: c.id, title: 'V' })
  const r1 = recurringFromContract(k.id, { title: 'Serie A' })
  createRecurring({ customer_id: c.id, title: 'Ohne Vertrag' })
  const byContract = listRecurring({ contract_id: k.id })
  assert.equal(byContract.length, 1)
  assert.equal(byContract[0].id, r1.id)
  const byCust = listRecurring({ customer_id: c.id })
  assert.ok(byCust.length >= 2)
})

test('deleting a draft contract nulls series contract_id (ON DELETE SET NULL)', () => {
  const k = createContract({ title: 'Draft link', value_cents: 1000 })
  const r = recurringFromContract(k.id)
  assert.equal(r.contract_id, k.id)
  const del = deleteContract(k.id)
  assert.equal(del.ok, true)
  assert.equal(getRecurring(r.id)!.contract_id, null)
})

test('defaultItemsFromContract returns empty when value is 0', () => {
  const k = createContract({ title: 'Null', value_cents: 0 })
  assert.deepEqual(defaultItemsFromContract(k), [])
})
