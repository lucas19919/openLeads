import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-contracts-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const {
  createContract,
  listContracts,
  getContract,
  updateContract,
  finalizeContract,
  signContract,
  setContractStatus,
  deleteContract,
  contractTotals,
  contractFromDocument,
  setSignedDoc,
  getSignedDoc,
  deleteSignedDoc,
} = await import('./contracts')
const { renderContractPdf, contractPdfFilename } = await import('./contractPdf')
const { getSettings, getDocument, replaceItems, finalizeDraft } = await import('./documents')

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

test('contractTotals: §19 carries no VAT, otherwise gross adds VAT', () => {
  assert.deepEqual(contractTotals(100000, true, 19), { net_cents: 100000, vat_cents: 0, gross_cents: 100000 })
  assert.deepEqual(contractTotals(100000, false, 19), { net_cents: 100000, vat_cents: 19000, gross_cents: 119000 })
})

test('a new contract is a draft with no number', () => {
  const c = createContract({
    type: 'wartungsvertrag',
    client_name: 'Bäckerei Huber',
    title: 'Wartungsvertrag Website',
    body: 'Pflege und Wartung der Website.',
    value_cents: 19900,
    small_business: 1,
  })
  assert.equal(c.number, null)
  assert.equal(c.status, 'entwurf')
  assert.equal(c.type, 'wartungsvertrag')
  assert.equal(c.totals.gross_cents, 19900)
  assert.equal(c.agb_text, null)
})

test('an unknown type falls back to dienstvertrag', () => {
  const c = createContract({ type: 'nonsense', client_name: 'X' })
  assert.equal(c.type, 'dienstvertrag')
})

test('finalise assigns a gapless number, freezes the AGB, sets the issue date, marks sent', () => {
  // Set a standard AGB on the business profile first.
  db.prepare('UPDATE settings SET agb_text = ?, contract_prefix = ?, contract_next = ? WHERE id = 1').run(
    'Diese AGB gelten.',
    'V-',
    1,
  )
  const year = new Date().getFullYear()

  const a = createContract({ client_name: 'Kunde A' })
  const fa = finalizeContract(a.id)!
  assert.equal(fa.number, `V-${year}-0001`)
  assert.equal(fa.status, 'versendet')
  assert.equal(fa.agb_text, 'Diese AGB gelten.') // snapshot frozen at finalise
  assert.ok(fa.issue_date)

  const b = createContract({ client_name: 'Kunde B' })
  const fb = finalizeContract(b.id)!
  assert.equal(fb.number, `V-${year}-0002`) // gapless increment

  // Changing the standard AGB afterwards must NOT change an already-issued contract.
  db.prepare('UPDATE settings SET agb_text = ? WHERE id = 1').run('Neue AGB!')
  assert.equal(getContract(a.id)!.agb_text, 'Diese AGB gelten.')
})

test('re-finalising is a no-op (number not consumed twice)', () => {
  const c = createContract({ client_name: 'Kunde C' })
  const first = finalizeContract(c.id)!
  const again = finalizeContract(c.id)!
  assert.equal(first.number, again.number)
})

test('sign moves a finalised contract to aktiv and records the signatory', () => {
  const c = createContract({ client_name: 'Kunde D' })
  // Cannot sign a draft.
  assert.throws(() => signContract(c.id, 'Max Mustermann', null), /festgeschrieben/)
  finalizeContract(c.id)
  const signed = signContract(c.id, 'Max Mustermann', 'persönlich', '2026-06-20')!
  assert.equal(signed.status, 'aktiv')
  assert.equal(signed.signed_by, 'Max Mustermann')
  assert.equal(signed.signed_at, '2026-06-20')
})

test('setContractStatus validates the status', () => {
  const c = createContract({ client_name: 'Kunde E' })
  assert.throws(() => setContractStatus(c.id, 'bogus'), /Status/)
  assert.equal(setContractStatus(c.id, 'abgelehnt')!.status, 'abgelehnt')
})

test('updateContract patches editable fields and recomputes totals', () => {
  const c = createContract({ client_name: 'Kunde F', value_cents: 10000, small_business: 0, vat_rate: 19 })
  const u = updateContract(c.id, { value_cents: 50000, payment_terms: 'monatlich' })!
  assert.equal(u.value_cents, 50000)
  assert.equal(u.totals.gross_cents, 59500)
  assert.equal(u.payment_terms, 'monatlich')
})

test('drafts can be deleted; finalised contracts cannot', () => {
  const draft = createContract({ client_name: 'Kunde G' })
  assert.deepEqual(deleteContract(draft.id), { ok: true })
  assert.equal(getContract(draft.id), null)

  const issued = createContract({ client_name: 'Kunde H' })
  finalizeContract(issued.id)
  assert.deepEqual(deleteContract(issued.id), { ok: false, reason: 'finalised' })
  assert.ok(getContract(issued.id)) // still there
})

test('contractFromDocument seeds a draft from an Angebot (client, value, body, link)', () => {
  // Build a finalised Angebot with two lines (net 300€), small_business off.
  const info = db
    .prepare("INSERT INTO documents (kind, client_name, client_city, small_business, vat_rate, status) VALUES ('angebot', 'Relaunch GmbH', 'München', 0, 19, 'entwurf')")
    .run()
  const docId = Number(info.lastInsertRowid)
  replaceItems(docId, [
    { description: 'Konzept', quantity: 1, unit: 'Pauschal', unit_price_cents: 20000 },
    { description: 'Umsetzung', quantity: 2, unit: 'Tag', unit_price_cents: 5000 },
  ])
  finalizeDraft(docId)

  const k = contractFromDocument(docId)!
  assert.equal(k.number, null) // a draft
  assert.equal(k.type, 'werkvertrag')
  assert.equal(k.client_name, 'Relaunch GmbH')
  assert.equal(k.client_city, 'München')
  assert.equal(k.document_id, docId) // linked back to the Angebot
  assert.equal(k.value_cents, 30000) // net total carried over
  assert.equal(k.small_business, 0)
  assert.match(k.body ?? '', /Konzept/)
  assert.match(k.body ?? '', /Umsetzung/)
  assert.match(getDocument(docId)!.number ?? '', /^AN-/) // sanity: the source is an Angebot
})

test('contractFromDocument returns null for a missing document', () => {
  assert.equal(contractFromDocument(999999), null)
})

test('signed document: store, expose has_signed_doc without leaking bytes, fetch, delete', () => {
  const c = createContract({ client_name: 'Signdoc GmbH' })
  finalizeContract(c.id)
  assert.equal(getContract(c.id)!.has_signed_doc, false)

  const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]) // "%PDF" + noise
  const updated = setSignedDoc(c.id, { data: bytes, name: 'unterschrieben.pdf', mime: 'application/pdf' })!
  assert.equal(updated.has_signed_doc, true)
  // The public shape must NOT carry the raw bytes.
  assert.equal((updated as Record<string, unknown>).signed_doc_data, undefined)
  assert.equal(updated.signed_doc_name, 'unterschrieben.pdf')
  assert.equal(updated.signed_doc_size, bytes.byteLength)
  // list also reports the flag without shipping bytes.
  const inList = listContracts().find((k) => k.id === c.id)!
  assert.equal(inList.has_signed_doc, true)
  assert.equal((inList as Record<string, unknown>).signed_doc_data, undefined)

  // The bytes are retrievable via the dedicated fetch.
  const fetched = getSignedDoc(c.id)!
  assert.equal(fetched.mime, 'application/pdf')
  assert.deepEqual([...fetched.data], [...bytes])

  // Delete clears it.
  assert.equal(deleteSignedDoc(c.id)!.has_signed_doc, false)
  assert.equal(getSignedDoc(c.id), null)
})

test('signed-doc helpers return null for a missing contract', () => {
  assert.equal(setSignedDoc(999999, { data: new Uint8Array([1]), name: 'x', mime: 'application/pdf' }), null)
  assert.equal(getSignedDoc(999999), null)
  assert.equal(deleteSignedDoc(999999), null)
})

test('renderContractPdf produces a valid multi-page PDF (long AGB paginates)', async () => {
  db.prepare('UPDATE settings SET business_name=?, owner=?, city=?, agb_text=? WHERE id=1').run(
    'Web Studio Müller',
    'Lena Müller',
    'München',
    // long enough to force a page break and exercise buffered-page footer stamping
    Array(60).fill('§ Lange AGB-Klausel mit Text zur Prüfung des Seitenumbruchs.').join(' '),
  )
  const c = createContract({
    type: 'werkvertrag',
    client_name: 'Bäckerei Huber',
    client_address: 'Hauptstr. 1',
    client_zip: '80331',
    client_city: 'München',
    title: 'Werkvertrag Relaunch',
    intro: 'Die Parteien vereinbaren einen Relaunch.',
    body: 'Neugestaltung der Website inkl. CMS.',
    value_cents: 500000,
    small_business: 0,
    vat_rate: 19,
    payment_terms: '50% bei Auftrag, 50% bei Abnahme.',
    start_date: '2026-07-01',
    end_date: '2026-09-30',
    notice_period: '4 Wochen zum Monatsende',
  })
  const f = finalizeContract(c.id)!
  const buf = await renderContractPdf(f, getSettings())
  assert.ok(buf.length > 1000)
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-')
  assert.match(contractPdfFilename(f), /^Vertrag_V-\d{4}-\d{4}\.pdf$/)
})
