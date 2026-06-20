import { test } from 'node:test'
import assert from 'node:assert/strict'
import { suggestedLevel, computeDunning, VERZUG_PAUSCHALE_CENTS } from './dunning'
import type { FullDocument } from './documents'
import type { SettingsRow } from './db'

function inv(
  grossCents: number,
  dueDate: string | null,
  over: Partial<FullDocument> = {},
): FullDocument {
  return {
    id: 1, kind: 'rechnung', number: 'RE-1', due_date: dueDate, issue_date: '2026-01-01',
    small_business: 0, vat_rate: 19, items: [], client_name: 'X', client_type: 'geschaeft',
    paid_cents: 0,
    totals: { net_cents: grossCents, vat_cents: 0, gross_cents: grossCents },
    ...over,
  } as unknown as FullDocument
}

test('suggestedLevel escalates with days overdue', () => {
  assert.equal(suggestedLevel(0), 0)
  assert.equal(suggestedLevel(5), 0)
  assert.equal(suggestedLevel(15), 1)
  assert.equal(suggestedLevel(30), 2)
  assert.equal(suggestedLevel(60), 3)
})

test('§288 BGB interest: €1000, 30 days, base 1.27 → €8.44 + €40 pauschale', () => {
  const d = computeDunning(inv(100000, '2026-05-20'), { verzug_base_rate: 1.27 } as SettingsRow, undefined, '2026-06-19')
  assert.equal(d.days_overdue, 30)
  assert.equal(d.interest_rate_percent, 10.27)
  assert.equal(d.interest_cents, 844)
  assert.equal(d.pauschale_cents, VERZUG_PAUSCHALE_CENTS)
  assert.equal(d.total_claim_cents, 104844)
})

test('level 0 (Zahlungserinnerung) charges no interest or pauschale', () => {
  const d = computeDunning(inv(100000, '2026-06-15'), { verzug_base_rate: 1.27 } as SettingsRow, 0, '2026-06-19')
  assert.equal(d.interest_cents, 0)
  assert.equal(d.pauschale_cents, 0)
  assert.equal(d.total_claim_cents, 100000)
})

test('not yet due → zero days overdue', () => {
  const d = computeDunning(inv(50000, '2026-12-31'), { verzug_base_rate: 1.27 } as SettingsRow, undefined, '2026-06-19')
  assert.equal(d.days_overdue, 0)
})

test('interest accrues on the OUTSTANDING amount after a partial payment', () => {
  // €1000 gross, €400 already paid → only €600 is overdue.
  const d = computeDunning(inv(100000, '2026-05-20', { paid_cents: 40000 }), { verzug_base_rate: 1.27 } as SettingsRow, undefined, '2026-06-19')
  assert.equal(d.outstanding_cents, 60000)
  assert.equal(d.interest_cents, 506) // 60000 * 10.27% * 30/365
  assert.equal(d.total_claim_cents, 64506) // 60000 + 506 + 4000
})

test('Privat debtor owes no €40 Pauschale (§288(5) BGB is B2B only)', () => {
  const d = computeDunning(inv(100000, '2026-05-20', { client_type: 'privat' }), { verzug_base_rate: 1.27 } as SettingsRow, undefined, '2026-06-19')
  assert.equal(d.pauschale_cents, 0)
  assert.equal(d.interest_cents, 844)
  assert.equal(d.total_claim_cents, 100844)
})
