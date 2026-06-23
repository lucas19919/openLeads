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
  assert.equal(companyFromDomain('https://www.print-factory24.de/'), 'Print Factory 24')
  assert.equal(companyFromDomain('thomaskraus-metallbau.de'), 'Thomaskraus Metallbau')
  assert.equal(companyFromDomain(''), null)
})

test('create_lead inserts a lead and derives the company from the domain', async () => {
  const res = (await runTool('create_lead', { website: 'https://restaurierung.christina-haubs.de/' }, ctx)) as {
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

test('create_lead respects explicit fields and dedupes by domain', async () => {
  const a = (await runTool(
    'create_lead',
    { website: 'http://print-factory24.de', company: 'Print Factory 24', trade: 'Druck', city: 'Köln' },
    ctx,
  )) as { ok: boolean; lead: { id: number; trade: string; city: string } }
  assert.equal(a.lead.trade, 'Druck')
  assert.equal(a.lead.city, 'Köln')

  const dupe = (await runTool('create_lead', { website: 'https://www.print-factory24.de/impressum' }, ctx)) as {
    ok: boolean
    deduped: boolean
    lead: { id: number }
  }
  assert.equal(dupe.deduped, true)
  assert.equal(dupe.lead.id, a.lead.id) // same registrable domain → same row
})
