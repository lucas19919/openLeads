import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFacturXXml } from './facturx'
import type { FullDocument } from './documents'
import type { SettingsRow } from './db'

// facturx.ts has no runtime DB import (types only), so this is a pure unit test.

function settings(over: Partial<SettingsRow> = {}): SettingsRow {
  return {
    id: 1, business_name: 'Web Studio', owner: 'L. R.', address: 'Hauptstr. 1',
    zip: '80331', city: 'München', email: 'hallo@webstudio.de', phone: null,
    website: null, tax_id: 'DE123456789', iban: 'DE89 3704 0044 0532 0130 00',
    bic: null, bank: null, small_business: 0, vat_rate: 19, payment_terms: 14,
    rechnung_prefix: 'RE-', rechnung_next: 2, angebot_prefix: 'AN-', angebot_next: 1,
    scraper_trades: null, scraper_towns: null, scraper_min_score: null,
    scraper_max_pairs: null, scraper_per_pair: null, verzug_base_rate: 1.27, datev_revenue_account: null, datev_debitor_account: null,
    ...over,
  }
}

function invoice(over: Partial<FullDocument> = {}): FullDocument {
  const items = over.items ?? [
    { id: 1, document_id: 1, description: 'Website', quantity: 1, unit: 'Pauschal', unit_price_cents: 100000, sort: 0 },
  ]
  const small = over.small_business ?? 0
  const net = items.reduce((s, it) => s + Math.round(it.quantity * it.unit_price_cents), 0)
  const vat = small ? 0 : Math.round((net * (over.vat_rate ?? 19)) / 100)
  return {
    id: 1, kind: 'rechnung', number: 'RE-2026-0001', lead_id: null,
    client_name: 'Maler Müller', client_address: 'Dorfstr. 2', client_zip: '85435',
    client_city: 'Erding', client_email: null, title: 'Rechnung', intro: null, notes: null,
    status: 'versendet', issue_date: '2026-06-19', due_date: '2026-07-03',
    small_business: small, vat_rate: over.vat_rate ?? 19, buyer_reference: null,
    created_at: '', updated_at: '', items,
    totals: { net_cents: net, vat_cents: vat, gross_cents: net + vat },
    ...over,
  }
}

test('CII XML carries EN 16931 profile + core terms', () => {
  const xml = buildFacturXXml(invoice(), settings())
  assert.match(xml, /urn:cen\.eu:en16931:2017/)
  assert.match(xml, /<ram:ID>RE-2026-0001<\/ram:ID>/)
  assert.match(xml, /<ram:TypeCode>380<\/ram:TypeCode>/) // invoice
  assert.match(xml, /<ram:GrandTotalAmount>1190\.00<\/ram:GrandTotalAmount>/)
  assert.match(xml, /<ram:RateApplicablePercent>19<\/ram:RateApplicablePercent>/)
  assert.match(xml, /schemeID="VA"/) // DE VAT id
})

test('§19 Kleinunternehmer → category E, 0% and exemption reason', () => {
  const xml = buildFacturXXml(invoice({ small_business: 1 }), settings({ small_business: 1 }))
  assert.match(xml, /<ram:CategoryCode>E<\/ram:CategoryCode>/)
  assert.match(xml, /§ 19 UStG/)
  assert.match(xml, /<ram:GrandTotalAmount>1000\.00<\/ram:GrandTotalAmount>/)
})

test('BuyerReference (BT-10 Leitweg-ID) is emitted when set', () => {
  const xml = buildFacturXXml(invoice({ buyer_reference: '04011000-1234512345-06' }), settings())
  assert.match(xml, /<ram:BuyerReference>04011000-1234512345-06<\/ram:BuyerReference>/)
  // ...and absent when not set.
  assert.doesNotMatch(buildFacturXXml(invoice(), settings()), /<ram:BuyerReference>/)
})

test('XML escaping prevents injection from names', () => {
  const xml = buildFacturXXml(invoice({ client_name: 'A & B <Bau>' }), settings())
  assert.match(xml, /A &amp; B &lt;Bau&gt;/)
  assert.doesNotMatch(xml, /<Bau>/)
})
