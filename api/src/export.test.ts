import { test } from 'node:test'
import assert from 'node:assert/strict'
import { invoicesCsv, datevCsv, deAmount, deDate } from './export'
import { computeTotals, type FullDocument } from './documents'
import type { SettingsRow } from './db'

function settings(over: Partial<SettingsRow> = {}): SettingsRow {
  return { small_business: 0, datev_revenue_account: null, datev_debitor_account: null, ...over } as unknown as SettingsRow
}

function inv(over: Partial<FullDocument> = {}): FullDocument {
  const items = over.items ?? [{ id: 1, document_id: 1, description: 'Web', quantity: 1, unit: 'Pauschal', unit_price_cents: 250000, sort: 0 }]
  const small = !!(over.small_business ?? 0)
  const vat_rate = over.vat_rate ?? 19
  return {
    id: 1, kind: 'rechnung', number: 'RE-2026-0001', client_name: 'Maler Müller', client_city: 'Erding',
    issue_date: '2026-06-19', due_date: '2026-07-03', status: 'versendet',
    ...over,
    small_business: small ? 1 : 0, vat_rate, items, totals: computeTotals(items, small, vat_rate),
  } as unknown as FullDocument
}

test('deAmount / deDate use German conventions', () => {
  assert.equal(deAmount(250000), '2500,00')
  assert.equal(deDate('2026-06-19'), '19.06.2026')
})

test('invoice journal CSV has header + tax fields', () => {
  const csv = invoicesCsv([inv()])
  const [head, row] = csv.trim().split('\r\n')
  assert.match(head, /Rechnungsnummer;Rechnungsdatum/)
  assert.match(row, /RE-2026-0001;19\.06\.2026/)
  assert.match(row, /2500,00;19%;475,00;2975,00;nein/)
})

test('DATEV booking: gross, S, accounts, BU-Schlüssel 3 for 19%', () => {
  const csv = datevCsv([inv()], settings())
  const row = csv.trim().split('\r\n')[1]
  // Umsatz;S;Konto(10000);Gegenkonto(8400);BU(3);Datum;Beleg;Text;Steuersatz
  assert.match(row, /^2975,00;S;10000;8400;3;19\.06\.2026;RE-2026-0001;Maler Müller;19$/)
})

test('DATEV booking for §19 has no BU-Schlüssel and 8200 revenue', () => {
  const csv = datevCsv([inv({ small_business: 1 })], settings({ small_business: 1 }))
  const row = csv.trim().split('\r\n')[1]
  assert.match(row, /^2500,00;S;10000;8200;;19\.06\.2026;RE-2026-0001;Maler Müller;0$/)
})

test('CSV escapes a customer name containing a semicolon', () => {
  const csv = invoicesCsv([inv({ client_name: 'Müller; Söhne GmbH' })])
  assert.match(csv, /"Müller; Söhne GmbH"/)
})

test('CSV neutralises spreadsheet formula injection', () => {
  const csv = invoicesCsv([inv({ client_name: '=cmd|calc!A1' })])
  // The dangerous leading '=' is prefixed with an apostrophe (and the cell is
  // not emitted as a live formula).
  assert.match(csv, /;'=cmd\|calc!A1;|"'=cmd\|calc!A1"/)
  assert.doesNotMatch(csv, /;=cmd/)
})
