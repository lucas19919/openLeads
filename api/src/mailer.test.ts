import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeOutreachEmail, fillPlaceholders, buildFooter } from './mailer'
import type { OutreachRow, LeadRow, SettingsRow } from './db'

function settings(over: Partial<SettingsRow> = {}): SettingsRow {
  return {
    id: 1, business_name: 'Web Studio', owner: 'Lena Reimers', address: 'Hauptstr. 1',
    zip: '80331', city: 'München', email: 'hallo@webstudio.de', phone: '089 12345',
    website: 'webstudio.de', tax_id: 'DE123456789', iban: null, bic: null, bank: null,
    small_business: 1, vat_rate: 19, payment_terms: 14, rechnung_prefix: 'RE-', rechnung_next: 1,
    angebot_prefix: 'AN-', angebot_next: 1, scraper_trades: null, scraper_towns: null,
    scraper_min_score: null, scraper_max_pairs: null, scraper_per_pair: null, verzug_base_rate: 1.27, datev_revenue_account: null, datev_debitor_account: null,
    ...over,
  }
}

const lead = { id: 7, email: 'info@maler-mueller.de', company: 'Maler Müller' } as LeadRow

function outreach(over: Partial<OutreachRow> = {}): OutreachRow {
  return {
    id: 1, lead_id: 7, channel: 'email', subject: 'Ihre Website', language: 'de',
    legal_basis: null, status: 'freigegeben', model: 'x', created_at: '', updated_at: '',
    body: 'Sehr geehrte Damen und Herren,\n\n... Mit freundlichen Grüßen\n{{absender_name}}\n{{absender_firma}}',
    ...over,
  }
}

test('placeholders resolve to the business profile', () => {
  const out = fillPlaceholders('{{absender_name}} / {{absender_firma}}', settings())
  assert.equal(out, 'Lena Reimers / Web Studio')
})

test('footer carries Impressum + opt-out (UWG/DSGVO)', () => {
  const f = buildFooter(settings())
  assert.match(f, /Web Studio/)
  assert.match(f, /Steuernr\.\/USt-IdNr\.: DE123456789/)
  assert.match(f, /Art\. 21 DSGVO/)
  assert.match(f, /kein Interesse/)
})

test('composed email targets the lead and appends compliance footer', () => {
  const e = composeOutreachEmail(outreach(), lead, settings())
  assert.equal(e.to, 'info@maler-mueller.de')
  assert.equal(e.subject, 'Ihre Website')
  assert.match(e.text, /Lena Reimers/)        // placeholder filled
  assert.doesNotMatch(e.text, /\{\{/)          // no leftover placeholders
  assert.match(e.text, /Art\. 21 DSGVO/)       // footer present
})

test('refuses a lead without an email', () => {
  assert.throws(() => composeOutreachEmail(outreach(), { ...lead, email: null } as LeadRow, settings()))
})
