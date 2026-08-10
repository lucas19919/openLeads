import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type { LeadRow } from './db'

const DB_FILE = join(tmpdir(), `openleads-facts-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { recordFact, resolveFact, listFacts, pendingFacts, ledgerOnlyFacts } = await import('./facts')

let seq = 0
function makeLead(fields: Partial<LeadRow> = {}): LeadRow {
  const info = db
    .prepare(`INSERT INTO leads (domain, company, city, email, priority, stage, source) VALUES (?, ?, ?, ?, 'mittel', 'neu', 'manual')`)
    .run(`t${++seq}.example`, fields.company ?? null, fields.city ?? null, fields.email ?? null)
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as LeadRow
}

function lead(id: number): LeadRow {
  return db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow
}

const base = {
  evidence: 'primary' as const,
  detail: 'Impressum nennt den Wert',
  method: 'impressum.parse',
  source_url: 'https://example.de/impressum',
  actor: 'ai',
}

after(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(DB_FILE, { force: true })
  rmSync(`${DB_FILE}-wal`, { force: true })
  rmSync(`${DB_FILE}-shm`, { force: true })
})

test('direkter Beleg füllt ein leeres Feld', () => {
  const l = makeLead()
  const r = recordFact({ ...base, lead_id: l.id, field: 'city', value: 'Osnabrück' })
  assert.equal(r.applied, true)
  assert.equal(r.status, 'uebernommen')
  assert.equal(lead(l.id).city, 'Osnabrück')
})

test('mittelbarer Beleg wird zum Vorschlag, das Feld bleibt leer', () => {
  const l = makeLead()
  const r = recordFact({ ...base, lead_id: l.id, field: 'city', value: 'Bremen', evidence: 'supporting' })
  assert.equal(r.applied, false)
  assert.equal(r.status, 'offen')
  assert.equal(lead(l.id).city, null)
})

test('von Hand gesetzte Werte werden auch bei direktem Beleg nicht überschrieben', () => {
  const l = makeLead({ city: 'Hannover' })
  const r = recordFact({ ...base, lead_id: l.id, field: 'city', value: 'Osnabrück' })
  assert.equal(r.applied, false)
  assert.equal(r.status, 'offen')
  assert.equal(lead(l.id).city, 'Hannover', 'der Mensch behält recht')
  assert.match(r.reason, /von Hand gesetzt/i)
})

test('ein früher selbst gesetzter Wert darf durch einen direkten Beleg ersetzt werden', () => {
  const l = makeLead()
  recordFact({ ...base, lead_id: l.id, field: 'company', value: 'Dach Meier', evidence: 'primary' })
  assert.equal(lead(l.id).company, 'Dach Meier')

  const r = recordFact({ ...base, lead_id: l.id, field: 'company', value: 'Dach Meier GmbH' })
  assert.equal(r.applied, true)
  assert.equal(lead(l.id).company, 'Dach Meier GmbH')
})

test('ein bereits korrekter Wert wird bestätigt, nicht neu geschrieben', () => {
  const l = makeLead({ city: 'Kiel' })
  const before = lead(l.id).updated_at
  const r = recordFact({ ...base, lead_id: l.id, field: 'city', value: 'kiel' })
  assert.equal(r.status, 'uebernommen')
  assert.equal(r.applied, false, 'nichts zu schreiben')
  assert.equal(lead(l.id).updated_at, before)
})

test('ein Widerspruch ändert nie das Feld', () => {
  const l = makeLead({ email: 'alt@example.de' })
  const r = recordFact({
    ...base,
    lead_id: l.id,
    field: 'email',
    value: 'neu@example.de',
    evidence: 'contradiction',
    detail: 'Impressum nennt eine andere Adresse als der Lead',
  })
  assert.equal(r.applied, false)
  assert.equal(r.status, 'widersprochen')
  assert.equal(lead(l.id).email, 'alt@example.de')
})

test('Impressum-Felder ohne Lead-Spalte landen trotzdem im Ledger', () => {
  const l = makeLead()
  const r = recordFact({ ...base, lead_id: l.id, field: 'vat_id', value: 'DE123456789' })
  assert.equal(r.status, 'uebernommen')
  assert.equal(r.applied, false, 'es gibt keine Spalte, in die geschrieben werden könnte')
  assert.deepEqual(ledgerOnlyFacts(l.id), { vat_id: 'DE123456789' })
})

test('mobile_friendly wird auf die Integer-Spalte abgebildet', () => {
  const yes = makeLead()
  recordFact({ ...base, lead_id: yes.id, field: 'mobile_friendly', value: 'ja', method: 'tech.probe' })
  assert.equal(lead(yes.id).mobile_friendly, 1)

  const no = makeLead()
  recordFact({ ...base, lead_id: no.id, field: 'mobile_friendly', value: 'nein', method: 'tech.probe' })
  assert.equal(lead(no.id).mobile_friendly, 0)
})

test('ein Fakt ohne Beleg wird abgewiesen', () => {
  const l = makeLead()
  assert.throws(() => recordFact({ ...base, lead_id: l.id, field: 'city', value: 'Ulm', detail: '  ' }), /Beleg/)
  assert.throws(() => recordFact({ ...base, lead_id: l.id, field: 'city', value: '' }), /Wert/)
})

test('der Mensch kann einen Vorschlag übernehmen — auch bei schwachem Beleg', () => {
  const l = makeLead()
  const r = recordFact({ ...base, lead_id: l.id, field: 'trade', value: 'Dachdecker', evidence: 'supporting' })
  assert.equal(lead(l.id).trade, null)

  const resolved = resolveFact(r.fact.id, true, 'lucas')
  assert.equal(resolved.applied, true)
  assert.equal(lead(l.id).trade, 'Dachdecker')
  assert.throws(() => resolveFact(r.fact.id, true, 'lucas'), /bereits entschieden/)
})

test('ein verworfener Vorschlag ändert nichts und verschwindet aus der Prüfliste', () => {
  const l = makeLead()
  const r = recordFact({ ...base, lead_id: l.id, field: 'trade', value: 'Metallbau', evidence: 'supporting' })
  assert.ok(pendingFacts(200).some((f) => f.id === r.fact.id))

  resolveFact(r.fact.id, false, 'lucas')
  assert.equal(lead(l.id).trade, null)
  assert.equal(listFacts(l.id, { status: 'verworfen' }).length, 1)
  assert.ok(!pendingFacts(200).some((f) => f.id === r.fact.id))
})

test('das Ledger behält jede Beobachtung, auch die abgelehnten', () => {
  const l = makeLead({ city: 'Lübeck' })
  recordFact({ ...base, lead_id: l.id, field: 'city', value: 'Lübeck' })
  recordFact({ ...base, lead_id: l.id, field: 'city', value: 'Travemünde', evidence: 'supporting' })
  const all = listFacts(l.id, { field: 'city' })
  assert.equal(all.length, 2)
  assert.ok(all.every((f) => f.detail && f.method))
})
