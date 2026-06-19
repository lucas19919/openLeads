import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateInvoice } from './validate'
import { computeTotals, type FullDocument } from './documents'
import type { SettingsRow } from './db'

function settings(over: Partial<SettingsRow> = {}): SettingsRow {
  return {
    id: 1, business_name: 'Web Studio', owner: 'L', address: 'Hauptstr. 1', zip: '80331',
    city: 'München', email: 'h@ws.de', phone: null, website: null, tax_id: 'DE123456789',
    iban: 'DE89370400440532013000', bic: null, bank: null, small_business: 0, vat_rate: 19,
    payment_terms: 14, rechnung_prefix: 'RE-', rechnung_next: 1, angebot_prefix: 'AN-',
    angebot_next: 1, scraper_trades: null, scraper_towns: null, scraper_min_score: null,
    scraper_max_pairs: null, scraper_per_pair: null, verzug_base_rate: 1.27, datev_revenue_account: null, datev_debitor_account: null, ...over,
  }
}

function invoice(over: Partial<FullDocument> = {}): FullDocument {
  const items = over.items ?? [
    { id: 1, document_id: 1, description: 'Website', quantity: 1, unit: 'Pauschal', unit_price_cents: 100000, sort: 0 },
  ]
  const small = !!(over.small_business ?? 0)
  const vatRate = over.vat_rate ?? 19
  return {
    id: 1, kind: 'rechnung', number: 'RE-2026-0001', lead_id: null, client_name: 'Maler Müller',
    client_address: 'Dorfstr. 2', client_zip: '85435', client_city: 'Erding', client_email: null,
    title: 'Rechnung', intro: null, notes: null, status: 'versendet', issue_date: '2026-06-19',
    due_date: '2026-07-03', small_business: small ? 1 : 0, vat_rate: vatRate, buyer_reference: null,
    created_at: '', updated_at: '', items, totals: computeTotals(items, small, vatRate), ...over,
  }
}

test('a well-formed standard-rated invoice is valid', () => {
  const r = validateInvoice(invoice(), settings())
  assert.equal(r.valid, true, JSON.stringify(r.errors))
  assert.equal(r.errors.length, 0)
})

test('draft without number/items fails BR-02 and BR-16', () => {
  const r = validateInvoice(invoice({ number: null, items: [] }), settings())
  assert.equal(r.valid, false)
  const rules = r.errors.map((e) => e.rule)
  assert.ok(rules.includes('BR-02'))
  assert.ok(rules.includes('BR-16'))
})

test('standard rate without seller VAT id triggers BR-CO-26', () => {
  const r = validateInvoice(invoice(), settings({ tax_id: null }))
  assert.ok(r.errors.some((e) => e.rule === 'BR-CO-26'))
})

test('§19 with VAT charged is rejected (BR-E-08)', () => {
  // Force an inconsistent §19 doc: small_business but non-zero vat in totals.
  const doc = invoice({ small_business: 1 })
  doc.totals = { net_cents: 100000, vat_cents: 19000, gross_cents: 119000 }
  const r = validateInvoice(doc, settings({ small_business: 1 }))
  assert.ok(r.errors.some((e) => e.rule === 'BR-E-08'))
})

test('arithmetic mismatch is caught (BR-CO-10)', () => {
  const doc = invoice()
  doc.totals = { net_cents: 99999, vat_cents: 19000, gross_cents: 118999 }
  const r = validateInvoice(doc, settings())
  assert.ok(r.errors.some((e) => e.rule === 'BR-CO-10'))
})

test('XRechnung/BR-DE: missing seller contact warns, B2G note always present', () => {
  const r = validateInvoice(invoice(), settings({ email: null, phone: null }))
  assert.ok(r.warnings.some((w) => w.rule === 'BR-DE-2/3'))
  assert.ok(r.notes.some((n) => n.rule === 'XRECHNUNG'))
  // German specifics are warnings/notes only — the B2B invoice stays valid.
  assert.equal(r.errors.length, 0)
})

test('a set Leitweg-ID flips the B2G note to BT-10 satisfied', () => {
  const r = validateInvoice(invoice({ buyer_reference: '04011000-12345-06' }), settings())
  assert.ok(r.notes.some((n) => n.rule === 'BT-10'))
  assert.ok(!r.notes.some((n) => n.rule === 'XRECHNUNG'))
})
