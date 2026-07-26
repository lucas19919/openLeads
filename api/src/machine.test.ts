import { test, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'

// Isolate to a throwaway DB. DB_PATH is read when db.ts is first evaluated, so set
// it before the dynamic import (same pattern as the other suites).
const DB_FILE = join(tmpdir(), `openleads-machine-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { registerMachineRoutes } = await import('./routes/machine')
const { csrfExempt } = await import('./routes/middleware')
type Vars = import('./routes/middleware').Vars

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

// Mirror the composition in index.ts: the CSRF guard wraps /api/*, exempting
// what csrfExempt allows through, then the machine routes are registered.
const app = new Hono<{ Variables: Vars }>()
const csrfGuard = csrf({ origin: 'http://localhost:5173' })
app.use('/api/*', (c, next) => (csrfExempt(c) ? next() : csrfGuard(c, next)))
// Control route: proves the guard is actually active for non-exempt paths.
app.post('/api/csrf-probe', (c) => c.json({ ok: true }))
registerMachineRoutes(app)

const TOKEN = 'machine-secret-for-tests'
const AUTH = { authorization: `Bearer ${TOKEN}` }
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' }

beforeEach(() => {
  process.env.CRM_MACHINE_TOKEN = TOKEN
  delete process.env.CRM_MACHINE_PRINCIPAL
})

function leadEvents(id: number): Array<{ actor: string; type: string; to_stage: string | null }> {
  return db
    .prepare('SELECT actor, type, to_stage FROM lead_events WHERE lead_id = ? ORDER BY id')
    .all(id) as never
}

test('health probe answers without auth and without data', async () => {
  delete process.env.CRM_MACHINE_TOKEN
  const res = await app.request('/api/machine/health')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, service: 'openleads' })
})

test('fail closed: unset or empty CRM_MACHINE_TOKEN rejects every bearer', async () => {
  delete process.env.CRM_MACHINE_TOKEN
  let res = await app.request('/api/machine/leads', { headers: AUTH })
  assert.equal(res.status, 401)

  process.env.CRM_MACHINE_TOKEN = ''
  res = await app.request('/api/machine/leads', { headers: AUTH })
  assert.equal(res.status, 401)
})

test('missing or wrong bearer → 401', async () => {
  let res = await app.request('/api/machine/leads')
  assert.equal(res.status, 401)

  res = await app.request('/api/machine/leads', {
    headers: { authorization: 'Bearer definitely-wrong' },
  })
  assert.equal(res.status, 401)

  // A personal API token is not a machine token — the surfaces stay separate.
  res = await app.request('/api/machine/leads', { headers: { authorization: 'Bearer ol_abc' } })
  assert.equal(res.status, 401)
})

test('create → list → get → patch round-trips with the machine principal as actor', async () => {
  const create = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'Maschinen GmbH', website: 'https://maschinen-gmbh.de' }),
  })
  assert.equal(create.status, 201)
  const { id } = (await create.json()) as { id: number }
  assert.ok(id > 0)

  const row = db.prepare('SELECT source, stage FROM leads WHERE id = ?').get(id) as {
    source: string
    stage: string
  }
  assert.equal(row.source, 'machine') // default source for machine creates
  assert.equal(row.stage, 'neu')
  assert.equal(leadEvents(id)[0]?.actor, 'machine:mcp')

  const list = await app.request('/api/machine/leads?stage=neu&q=Maschinen', { headers: AUTH })
  assert.equal(list.status, 200)
  const { leads } = (await list.json()) as { leads: Array<{ id: number }> }
  assert.ok(leads.some((l) => l.id === id))

  const get = await app.request(`/api/machine/leads/${id}`, { headers: AUTH })
  assert.equal(get.status, 200)
  const detail = (await get.json()) as { lead: { id: number }; events: unknown[] }
  assert.equal(detail.lead.id, id)
  assert.ok(detail.events.length >= 1)

  const patch = await app.request(`/api/machine/leads/${id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ stage: 'kontaktiert', notes: 'automatisch qualifiziert' }),
  })
  assert.equal(patch.status, 200)
  const { lead } = (await patch.json()) as { lead: { stage: string } }
  assert.equal(lead.stage, 'kontaktiert')
  const events = leadEvents(id)
  const move = events.find((e) => e.type === 'stage_change')
  assert.equal(move?.actor, 'machine:mcp')
  assert.equal(move?.to_stage, 'kontaktiert')
})

test('creating a known domain dedupes instead of inserting twice', async () => {
  const res = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'Maschinen GmbH 2', website: 'http://www.maschinen-gmbh.de' }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { deduped?: boolean; id: number }
  assert.equal(body.deduped, true)
})

test('an explicit source and CRM_MACHINE_PRINCIPAL both win over the defaults', async () => {
  process.env.CRM_MACHINE_PRINCIPAL = 'machine:nightly-import'
  const res = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'QuellCo', website: 'quellco.de', source: 'scraper' }),
  })
  assert.equal(res.status, 201)
  const { id } = (await res.json()) as { id: number }
  const row = db.prepare('SELECT source FROM leads WHERE id = ?').get(id) as { source: string }
  assert.equal(row.source, 'scraper')
  assert.equal(leadEvents(id)[0]?.actor, 'machine:nightly-import')
})

test('unknown id → 404, invalid stage → 400 with nothing persisted', async () => {
  let res = await app.request('/api/machine/leads/999999', { headers: AUTH })
  assert.equal(res.status, 404)

  res = await app.request('/api/machine/leads/999999', {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ stage: 'kontaktiert' }),
  })
  assert.equal(res.status, 404)

  const create = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'StageCo', website: 'stageco-maschine.de' }),
  })
  const { id } = (await create.json()) as { id: number }
  res = await app.request(`/api/machine/leads/${id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ stage: 'nonsense' }),
  })
  assert.equal(res.status, 400)
  const row = db.prepare('SELECT stage FROM leads WHERE id = ?').get(id) as { stage: string }
  assert.equal(row.stage, 'neu')
})

test('CSRF: machine routes are exempt, the rest of /api is not', async () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' }

  // The control route shows the guard rejects a form post without an Origin…
  let res = await app.request('/api/csrf-probe', { method: 'POST', headers: form, body: 'x=1' })
  assert.equal(res.status, 403)

  // …while a machine POST without Origin never hits CSRF: no bearer is a clean
  // 401 from machine auth, a valid bearer goes through to the route.
  res = await app.request('/api/machine/leads', { method: 'POST', headers: form, body: 'x=1' })
  assert.equal(res.status, 401)

  res = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: { ...AUTH, ...form },
    body: 'x=1',
  })
  assert.equal(res.status, 201) // non-JSON body → empty lead body, but no CSRF rejection
})
