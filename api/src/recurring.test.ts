import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-recurring-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { getDocument } = await import('./documents')
const {
  addMonths,
  advanceDate,
  createRecurring,
  getRecurring,
  runRecurring,
  processDueRecurring,
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
