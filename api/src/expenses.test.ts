import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Isolate to a throwaway DB (DB_PATH is read when db.ts is first evaluated, so set
// it before the dynamic import). Same pattern as payments.test.ts.
const DB_FILE = join(tmpdir(), `openleads-expenses-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  splitGross,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpense,
  listExpenses,
  setReceipt,
  getReceipt,
  deleteReceipt,
  expenseSummary,
  normalizeCategory,
  categoryAccount,
} = await import('./expenses')

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

test('splitGross herausrechnen: 119,00 € @ 19% → 100,00 net + 19,00 Vorsteuer', () => {
  assert.deepEqual(splitGross(11900, 19), { net_cents: 10000, vat_cents: 1900 })
})

test('splitGross: 7% and 0% rates', () => {
  assert.deepEqual(splitGross(10700, 7), { net_cents: 10000, vat_cents: 700 })
  assert.deepEqual(splitGross(5000, 0), { net_cents: 5000, vat_cents: 0 })
})

test('splitGross rounds the net and keeps gross = net + vat', () => {
  const { net_cents, vat_cents } = splitGross(10000, 19) // 100,00 € gross
  assert.equal(net_cents + vat_cents, 10000) // no cent lost to rounding
  assert.equal(net_cents, 8403) // 10000 / 1.19 rounded
})

test('createExpense derives + persists net/Vorsteuer from gross + rate', () => {
  const e = createExpense({ vendor: 'Bürohaus', category: 'bueromaterial', gross_cents: 11900, vat_rate: 19 }, 'tester')
  assert.equal(e.gross_cents, 11900)
  assert.equal(e.net_cents, 10000)
  assert.equal(e.vat_cents, 1900)
  assert.equal(e.created_by, 'tester')
  assert.equal(e.has_receipt, false)
  assert.equal(getExpense(e.id)!.vendor, 'Bürohaus')
})

test('createExpense defaults expense_date to today and coerces unknown category', () => {
  const e = createExpense({ gross_cents: 1000, category: 'does-not-exist' as never }, null)
  assert.match(e.expense_date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(e.category, 'sonstiges')
})

test('updateExpense recomputes net/Vorsteuer when gross or rate change', () => {
  const e = createExpense({ gross_cents: 11900, vat_rate: 19 }, null)
  const u = updateExpense(e.id, { gross_cents: 10700, vat_rate: 7 })!
  assert.equal(u.gross_cents, 10700)
  assert.equal(u.vat_rate, 7)
  assert.equal(u.net_cents, 10000)
  assert.equal(u.vat_cents, 700)
})

test('updateExpense leaves derived fields alone when only metadata changes', () => {
  const e = createExpense({ gross_cents: 11900, vat_rate: 19, vendor: 'A' }, null)
  const u = updateExpense(e.id, { vendor: 'B', note: 'geändert' })!
  assert.equal(u.vendor, 'B')
  assert.equal(u.note, 'geändert')
  assert.equal(u.net_cents, 10000) // unchanged
  assert.equal(u.vat_cents, 1900)
})

test('receipt round-trip: set, fetch bytes, then delete', () => {
  const e = createExpense({ gross_cents: 5000 }, null)
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const withReceipt = setReceipt(e.id, { data: bytes, name: 'rechnung.pdf', mime: 'application/pdf' })!
  assert.equal(withReceipt.has_receipt, true)
  assert.equal(withReceipt.receipt_name, 'rechnung.pdf')
  assert.equal(withReceipt.receipt_size, 5)

  const fetched = getReceipt(e.id)!
  assert.equal(fetched.mime, 'application/pdf')
  assert.deepEqual([...fetched.data], [1, 2, 3, 4, 5])

  deleteReceipt(e.id)
  assert.equal(getExpense(e.id)!.has_receipt, false)
  assert.equal(getReceipt(e.id), null)
})

test('deleteExpense removes the row', () => {
  const e = createExpense({ gross_cents: 5000 }, null)
  assert.equal(deleteExpense(e.id), true)
  assert.equal(getExpense(e.id), null)
  assert.equal(deleteExpense(e.id), false) // already gone
})

test('listExpenses filters by date range and category', () => {
  // Clean slate for the filter assertions.
  db.exec('DELETE FROM expenses')
  createExpense({ gross_cents: 1000, category: 'kfz', expense_date: '2026-01-15' }, null)
  createExpense({ gross_cents: 2000, category: 'kfz', expense_date: '2026-03-15' }, null)
  createExpense({ gross_cents: 3000, category: 'miete', expense_date: '2026-03-20' }, null)

  assert.equal(listExpenses({ from: '2026-03-01' }).length, 2)
  assert.equal(listExpenses({ category: 'kfz' }).length, 2)
  assert.equal(listExpenses({ from: '2026-03-01', category: 'kfz' }).length, 1)
})

test('expenseSummary totals + per-category breakdown', () => {
  db.exec('DELETE FROM expenses')
  createExpense({ gross_cents: 11900, vat_rate: 19, category: 'kfz' }, null) // net 10000, vst 1900
  createExpense({ gross_cents: 5000, vat_rate: 0, category: 'miete' }, null) // net 5000, vst 0

  const s = expenseSummary()
  assert.equal(s.count, 2)
  assert.equal(s.gross_cents, 16900)
  assert.equal(s.net_cents, 15000)
  assert.equal(s.vat_cents, 1900)
  assert.equal(s.by_category.length, 2)
  assert.equal(s.by_category.find((c) => c.category === 'kfz')!.gross_cents, 11900)
})

test('category helpers: normalize + SKR03 account lookup', () => {
  assert.equal(normalizeCategory('kfz'), 'kfz')
  assert.equal(normalizeCategory('nope'), 'sonstiges')
  assert.equal(categoryAccount('kfz'), '4530')
  assert.equal(categoryAccount('unknown'), '4980') // fallback
})
