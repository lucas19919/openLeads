import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

// Isolate to a throwaway DB (DB_PATH is read when db.ts is first evaluated, so set
// it before the dynamic import). Same pattern as expenses.test.ts.
const DB_FILE = join(tmpdir(), `openleads-subscriptions-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  createSubscription,
  updateSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  subscriptionSummary,
  yearlyCents,
} = await import('./subscriptions')

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

test('yearlyCents scales by cadence', () => {
  assert.equal(yearlyCents(1000, 'monatlich'), 12000)
  assert.equal(yearlyCents(1000, 'quartalsweise'), 4000)
  assert.equal(yearlyCents(1000, 'jährlich'), 1000)
})

test('createSubscription derives monthly/yearly run-rate', () => {
  const s = createSubscription(
    { vendor: 'Anthropic', amount_cents: 3000, cadence: 'monatlich', category: 'software' },
    'tester',
  )
  assert.equal(s.vendor, 'Anthropic')
  assert.equal(s.monthly_cents, 3000)
  assert.equal(s.yearly_cents, 36000)
  assert.equal(s.active, 1)
})

test('quarterly subscription normalises to a monthly run-rate', () => {
  const s = createSubscription(
    { vendor: 'Hoster', amount_cents: 3000, cadence: 'quartalsweise', category: 'telefon_internet' },
    'tester',
  )
  assert.equal(s.yearly_cents, 12000)
  assert.equal(s.monthly_cents, 1000)
})

test('invalid category/cadence fall back to defaults', () => {
  const s = createSubscription({ vendor: 'X', amount_cents: 100, category: 'bogus', cadence: 'weekly' }, null)
  assert.equal(s.category, 'software')
  assert.equal(s.cadence, 'monatlich')
})

test('empty vendor is replaced with a placeholder', () => {
  const s = createSubscription({ vendor: '   ', amount_cents: 100 }, null)
  assert.equal(s.vendor, 'Unbenannt')
})

test('summary counts only active subscriptions in the run-rate', () => {
  // Fresh DB scoped to this test run already has the rows from prior tests; clear.
  db.prepare('DELETE FROM subscriptions').run()
  createSubscription({ vendor: 'A', amount_cents: 1000, cadence: 'monatlich' }, null) // 10€/mo
  createSubscription({ vendor: 'B', amount_cents: 1200, cadence: 'jährlich' }, null) // 1€/mo
  const inactive = createSubscription({ vendor: 'C', amount_cents: 9999, cadence: 'monatlich' }, null)
  updateSubscription(inactive.id, { active: 0 })

  const sum = subscriptionSummary()
  assert.equal(sum.count, 3)
  assert.equal(sum.active_count, 2)
  assert.equal(sum.monthly_cents, 1000 + 100) // 11€
  assert.equal(sum.yearly_cents, (1000 + 100) * 12)
})

test('upcoming surfaces active renewals within the window', () => {
  db.prepare('DELETE FROM subscriptions').run()
  createSubscription(
    { vendor: 'Soon', amount_cents: 500, cadence: 'monatlich', next_renewal: '2026-01-10' },
    null,
  )
  createSubscription(
    { vendor: 'Later', amount_cents: 500, cadence: 'monatlich', next_renewal: '2026-12-31' },
    null,
  )
  const sum = subscriptionSummary(30, '2026-01-01')
  assert.equal(sum.upcoming.length, 1)
  assert.equal(sum.upcoming[0].vendor, 'Soon')
})

test('update + delete round-trip', () => {
  db.prepare('DELETE FROM subscriptions').run()
  const s = createSubscription({ vendor: 'Edit me', amount_cents: 1000 }, null)
  const upd = updateSubscription(s.id, { amount_cents: 2000, cadence: 'jährlich' })
  assert.equal(upd?.amount_cents, 2000)
  assert.equal(upd?.monthly_cents, Math.round(2000 / 12))
  assert.equal(deleteSubscription(s.id), true)
  assert.equal(getSubscription(s.id), null)
  assert.equal(listSubscriptions().length, 0)
})
