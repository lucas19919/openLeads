import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-aitools-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { companyFromDomain } = await import('./ai/weblookup')
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

test('companyFromDomain derives a readable name from a host/URL', () => {
  assert.equal(companyFromDomain('https://www.druckhaus-nord24.example/'), 'Druckhaus Nord 24')
  assert.equal(companyFromDomain('hansmeier-metallbau.example'), 'Hansmeier Metallbau')
  assert.equal(companyFromDomain(''), null)
})

test('create_lead inserts a lead and derives the company from the domain', async () => {
  const res = (await runTool('create_lead', { website: 'https://restaurierung.werkstatt-muster.example/' }, ctx)) as {
    ok: boolean
    lead: { id: number; company: string; website: string; stage: string; source: string }
  }
  assert.equal(res.ok, true)
  assert.equal(res.lead.company, 'Restaurierung')
  assert.equal(res.lead.stage, 'neu')
  assert.equal(res.lead.source, 'ai')
  const row = db.prepare('SELECT company FROM leads WHERE id = ?').get(res.lead.id) as { company: string }
  assert.equal(row.company, 'Restaurierung') // actually persisted, not just returned
})

test('create_lead places the lead straight into the requested pipeline stage', async () => {
  const res = (await runTool(
    'create_lead',
    { website: 'https://dachdecker-mueller.de', stage: 'angebot' },
    ctx,
  )) as { ok: boolean; lead: { id: number; stage: string } }
  assert.equal(res.lead.stage, 'angebot')
  const ev = db
    .prepare("SELECT to_stage FROM lead_events WHERE lead_id = ? AND type = 'stage_change'")
    .get(res.lead.id) as { to_stage: string } | undefined
  assert.equal(ev?.to_stage, 'angebot') // move was recorded, not just the row flipped
})

test('create_document links a lead and fills client_name from the lead company', async () => {
  const lead = (await runTool('create_lead', { website: 'https://metzgerei-rosenheim.example', company: 'Metzgerei Rosenheim' }, ctx)) as {
    lead: { id: number }
  }
  // No client_name passed — it must fall back to the lead's company, and the
  // 575 € net price must persist as 57500 cents.
  const res = (await runTool(
    'create_document',
    { kind: 'angebot', lead_id: lead.lead.id, items: [{ description: 'Pauschale', quantity: 1, unit_price_cents: 57500 }] },
    ctx,
  )) as { ok: boolean; document: { kind: string; lead_id: number; client_name: string; items: { unit_price_cents: number }[] } }
  assert.equal(res.document.kind, 'angebot')
  assert.equal(res.document.lead_id, lead.lead.id)
  assert.equal(res.document.client_name, 'Metzgerei Rosenheim')
  assert.equal(res.document.items[0].unit_price_cents, 57500)
})

test('create_document rejects a lead_id that does not exist', async () => {
  const res = (await runTool('create_document', { kind: 'angebot', lead_id: 999999 }, ctx)) as { error?: string }
  assert.match(res.error ?? '', /nicht gefunden/)
})

test('create_lead respects explicit fields and dedupes by domain', async () => {
  const a = (await runTool(
    'create_lead',
    { website: 'http://druckhaus-nord24.example', company: 'Druckhaus Nord 24', trade: 'Druck', city: 'Köln' },
    ctx,
  )) as { ok: boolean; lead: { id: number; trade: string; city: string } }
  assert.equal(a.lead.trade, 'Druck')
  assert.equal(a.lead.city, 'Köln')

  const dupe = (await runTool('create_lead', { website: 'https://www.druckhaus-nord24.example/impressum' }, ctx)) as {
    ok: boolean
    deduped: boolean
    lead: { id: number }
  }
  assert.equal(dupe.deduped, true)
  assert.equal(dupe.lead.id, a.lead.id) // same registrable domain → same row
})
