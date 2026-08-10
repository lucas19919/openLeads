import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { Hono } from 'hono'

// Exercise the ledger over HTTP with a Bearer API token — the exact path the
// MCP server and the CLI take, so this covers the integration the in-process
// unit tests cannot.
const DB_FILE = join(tmpdir(), `openleads-factroutes-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
const { createApiToken, hashPassword } = await import('./auth')
const { registerLeadRoutes } = await import('./routes/leads')
const { registerAiRoutes } = await import('./ai/router')
const { requireAuth } = await import('./routes/middleware')
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

const app = new Hono<{ Variables: Vars }>()
registerLeadRoutes(app)
registerAiRoutes(app, requireAuth)

const uid = Number(
  db
    .prepare("INSERT INTO users (username, password_hash, role) VALUES ('agent', ?, 'admin')")
    .run(hashPassword('irrelevant'))
    .lastInsertRowid,
)
const { token } = createApiToken(uid, 'MCP', 'write')
const { token: readToken } = createApiToken(uid, 'MCP read-only', 'read')
const AUTH = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

const leadId = Number(
  db
    .prepare("INSERT INTO leads (domain, company, city, stage, source) VALUES ('acme.de', 'Acme', 'Hannover', 'neu', 'manual')")
    .run().lastInsertRowid,
)

const post = (path: string, body: unknown, headers = AUTH) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
const patch = (path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', headers: AUTH, body: JSON.stringify(body) })

test('ein belegter Fakt füllt ein leeres Feld und meldet die Begründung zurück', async () => {
  const res = await post('/api/ai/facts', {
    lead_id: leadId,
    field: 'email',
    value: 'kontakt@acme.de',
    evidence: 'primary',
    detail: 'Impressum nennt kontakt@acme.de',
    source_url: 'https://acme.de/impressum',
  })
  assert.equal(res.status, 201)
  const body = (await res.json()) as { applied: boolean; status: string; reason: string }
  assert.equal(body.applied, true)
  assert.equal(body.status, 'uebernommen')
  assert.ok(body.reason.length > 0, 'die Antwort erklärt sich selbst')
})

test('ein Fakt gegen einen von Hand gesetzten Wert landet in der Prüfliste', async () => {
  const res = await post('/api/ai/facts', {
    lead_id: leadId,
    field: 'city',
    value: 'Osnabrück',
    evidence: 'primary',
    detail: 'Impressum nennt Osnabrück als Sitz',
  })
  const body = (await res.json()) as { applied: boolean; status: string }
  assert.equal(body.applied, false)
  assert.equal(body.status, 'offen')

  const lead = db.prepare('SELECT city FROM leads WHERE id = ?').get(leadId) as { city: string }
  assert.equal(lead.city, 'Hannover')

  const pending = (await (await app.request('/api/facts/pending', { headers: AUTH })).json()) as {
    facts: { field: string; company: string }[]
  }
  assert.ok(pending.facts.some((f) => f.field === 'city' && f.company === 'Acme'))
})

test('ein unbekanntes Feld wird abgewiesen und nennt die erlaubten', async () => {
  const res = await post('/api/ai/facts', {
    lead_id: leadId,
    field: 'lieblingsfarbe',
    value: 'blau',
    evidence: 'primary',
    detail: 'stand da',
  })
  assert.equal(res.status, 400)
  assert.match(((await res.json()) as { error: string }).error, /company/)
})

test('ein erfundener Beleggrad wird abgewiesen', async () => {
  const res = await post('/api/ai/facts', {
    lead_id: leadId,
    field: 'trade',
    value: 'Dachdecker',
    evidence: 'ziemlich sicher',
    detail: 'gefühlt',
  })
  assert.equal(res.status, 400)
})

test('ein Fakt ohne Beleg wird abgewiesen', async () => {
  const res = await post('/api/ai/facts', {
    lead_id: leadId,
    field: 'trade',
    value: 'Dachdecker',
    evidence: 'primary',
    detail: '',
  })
  assert.equal(res.status, 400)
})

test('der Mensch entscheidet den Vorschlag, und das Feld folgt', async () => {
  const facts = (await (await app.request(`/api/leads/${leadId}/facts?status=offen`, { headers: AUTH })).json()) as {
    facts: { id: number; field: string }[]
  }
  const city = facts.facts.find((f) => f.field === 'city')!

  const res = await patch(`/api/facts/${city.id}`, { accept: true })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { applied: boolean }).applied, true)
  assert.equal((db.prepare('SELECT city FROM leads WHERE id = ?').get(leadId) as { city: string }).city, 'Osnabrück')
})

test('dieselbe Entscheidung ein zweites Mal wird abgewiesen', async () => {
  const facts = (await (await app.request(`/api/leads/${leadId}/facts`, { headers: AUTH })).json()) as {
    facts: { id: number; status: string }[]
  }
  const done = facts.facts.find((f) => f.status === 'uebernommen')!
  const res = await patch(`/api/facts/${done.id}`, { accept: false })
  assert.equal(res.status, 400)
})

test('die Herkunftsliste nennt Quelle und Beleg zu jedem Wert', async () => {
  const body = (await (await app.request(`/api/leads/${leadId}/facts`, { headers: AUTH })).json()) as {
    facts: { field: string; detail: string; method: string; source_url: string | null }[]
  }
  assert.ok(body.facts.length >= 2)
  assert.ok(body.facts.every((f) => f.detail && f.method))
  assert.ok(body.facts.some((f) => f.source_url?.includes('acme.de')))
})

test('ein Lese-Token darf lesen, aber nichts eintragen', async () => {
  const ok = await app.request(`/api/leads/${leadId}/facts`, {
    headers: { authorization: `Bearer ${readToken}` },
  })
  assert.equal(ok.status, 200)

  const denied = await post(
    '/api/ai/facts',
    { lead_id: leadId, field: 'phone', value: '0541 1', evidence: 'primary', detail: 'x' },
    { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' },
  )
  assert.equal(denied.status, 403)
})

test('ohne Anmeldung geht gar nichts', async () => {
  assert.equal((await app.request(`/api/leads/${leadId}/facts`)).status, 401)
  assert.equal((await app.request('/api/facts/pending')).status, 401)
})

test('Fakten zu einem unbekannten Lead laufen ins Leere statt zu krachen', async () => {
  assert.equal((await app.request('/api/leads/999999/facts', { headers: AUTH })).status, 404)
  const res = await post('/api/ai/facts', {
    lead_id: 999999,
    field: 'city',
    value: 'Nirgendwo',
    evidence: 'primary',
    detail: 'stand da',
  })
  assert.equal(res.status, 400)
})
