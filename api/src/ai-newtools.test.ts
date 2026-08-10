import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-ainew-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { runTool } = await import('./ai/tools')

const ctx = { actor: 'ai', ip: null }

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

test('create_catalog_item + list_catalog round-trip via the agent', async () => {
  const made = (await runTool('create_catalog_item', { name: 'Webdesign Stunde', unit: 'Std', unit_price_cents: 9500 }, ctx)) as {
    ok: boolean
    item: { id: number; name: string }
  }
  assert.equal(made.ok, true)
  const list = (await runTool('list_catalog', {}, ctx)) as { count: number; items: { name: string }[] }
  assert.ok(list.items.some((i) => i.name === 'Webdesign Stunde'))
})

test('create_contract drafts; the copilot can only REQUEST the Festschreiben', async () => {
  db.prepare('UPDATE settings SET agb_text = ? WHERE id = 1').run('KI-AGB gelten.')
  const made = (await runTool('create_contract', {
    type: 'wartungsvertrag',
    title: 'Wartungsvertrag',
    client_name: 'Bäckerei Huber',
    body: 'Pflege der Website.',
    value_cents: 19900,
  }, ctx)) as { ok: boolean; contract: { id: number; number: string | null; status: string } }
  assert.equal(made.ok, true)
  assert.equal(made.contract.number, null)
  assert.equal(made.contract.status, 'entwurf')

  // The one-way door is gone from the copilot's hands entirely.
  const gone = (await runTool('finalize_contract', { id: made.contract.id }, ctx)) as { error?: string }
  assert.match(gone.error ?? '', /Unbekanntes Werkzeug/)

  const asked = (await runTool('request_approval', {
    action: 'contract.finalize',
    entity_id: made.contract.id,
    reason: 'Kunde hat zugesagt',
  }, ctx)) as { ok: boolean; approval_id: number; status: string }
  assert.equal(asked.ok, true)
  assert.equal(asked.status, 'offen')

  // …and the contract is still an untouched draft: asking is not doing.
  const still = db.prepare('SELECT number, status FROM contracts WHERE id = ?').get(made.contract.id) as {
    number: string | null
    status: string
  }
  assert.equal(still.number, null)
  assert.equal(still.status, 'entwurf')

  const queue = (await runTool('list_approvals', { status: 'offen' }, ctx)) as {
    approvals: { id: number; action: string }[]
  }
  assert.ok(queue.approvals.some((a) => a.id === asked.approval_id && a.action === 'contract.finalize'))
})

test('request_approval on a missing id reports an error, not a throw', async () => {
  const r = (await runTool('request_approval', { action: 'contract.finalize', entity_id: 999999 }, ctx)) as {
    error?: string
  }
  assert.match(r.error ?? '', /nicht gefunden/)
})

test('create_customer + list_customers round-trip via the agent', async () => {
  const made = (await runTool('create_customer', { name: 'KI Kunde GmbH', city: 'Berlin', email: 'k@x.de', vat_id: 'DE999999999', client_type: 'privat' }, ctx)) as {
    ok: boolean
    customer: { id: number; name: string; client_type: string }
  }
  assert.equal(made.ok, true)
  assert.equal(made.customer.client_type, 'privat')
  const list = (await runTool('list_customers', { query: 'KI Kunde' }, ctx)) as { customers: { id: number }[] }
  assert.ok(list.customers.some((c) => c.id === made.customer.id))
})

test('create_document with customer_id prefills the recipient + USt-IdNr.', async () => {
  const c = (await runTool('create_customer', { name: 'Doc Kunde GmbH', address: 'Weg 5', zip: '10115', city: 'Berlin', vat_id: 'DE123' }, ctx)) as { customer: { id: number } }
  const doc = (await runTool('create_document', { kind: 'rechnung', customer_id: c.customer.id }, ctx)) as {
    ok: boolean
    document: { customer_id: number; client_name: string; client_city: string; client_vat_id: string }
  }
  assert.equal(doc.document.customer_id, c.customer.id)
  assert.equal(doc.document.client_name, 'Doc Kunde GmbH')
  assert.equal(doc.document.client_city, 'Berlin')
  assert.equal(doc.document.client_vat_id, 'DE123')
})

test('create_contract with customer_id prefills the Auftraggeber', async () => {
  const c = (await runTool('create_customer', { name: 'Vertrag Kunde GmbH', city: 'Hamburg' }, ctx)) as { customer: { id: number } }
  const k = (await runTool('create_contract', { title: 'Wartung', customer_id: c.customer.id }, ctx)) as {
    ok: boolean
    contract: { customer_id: number; client_name: string; client_city: string }
  }
  assert.equal(k.contract.customer_id, c.customer.id)
  assert.equal(k.contract.client_name, 'Vertrag Kunde GmbH')
  assert.equal(k.contract.client_city, 'Hamburg')
})

test('create_customer requires a name', async () => {
  const r = (await runTool('create_customer', { name: '   ' }, ctx)) as { error?: string }
  assert.match(r.error ?? '', /Name/)
})

test('create_document with an unknown customer_id reports an error', async () => {
  const r = (await runTool('create_document', { kind: 'rechnung', customer_id: 999999 }, ctx)) as { error?: string }
  assert.match(r.error ?? '', /nicht gefunden/)
})

test('contract_from_document turns an offer into a draft contract via the agent', async () => {
  const doc = (await runTool('create_document', { kind: 'angebot', client_name: 'Offer GmbH', items: [{ description: 'Projekt', quantity: 1, unit_price_cents: 50000 }] }, ctx)) as {
    document: { id: number }
  }
  const k = (await runTool('contract_from_document', { document_id: doc.document.id }, ctx)) as {
    ok: boolean
    contract: { document_id: number; client_name: string; value_cents: number }
  }
  assert.equal(k.ok, true)
  assert.equal(k.contract.document_id, doc.document.id)
  assert.equal(k.contract.client_name, 'Offer GmbH')
  assert.equal(k.contract.value_cents, 50000)
  const miss = (await runTool('contract_from_document', { document_id: 999999 }, ctx)) as { error?: string }
  assert.match(miss.error ?? '', /nicht gefunden/)
})
