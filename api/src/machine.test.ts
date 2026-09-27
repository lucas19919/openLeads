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

// Trust X-Forwarded-For here (both are read once, at module load, below) so each
// test can speak from its own address. The machine surface is rate-limited to
// 120 requests per minute per client, and without this the whole suite shares
// one bucket: a suite that grows past 120 requests starts failing with 429s
// that say nothing about the code under test.
process.env.TRUST_PROXY = '1'

const { db } = await import('./db')
const { registerMachineRoutes } = await import('./routes/machine')
const { csrfExempt } = await import('./routes/middleware')
const { createContract } = await import('./contracts')
const { createExpense } = await import('./expenses')
const { createRecurring } = await import('./recurring')
const { createSubscription } = await import('./subscriptions')
const { createCatalogItem } = await import('./catalog')
const { addPayment } = await import('./payments')
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
const AUTH: Record<string, string> = { authorization: `Bearer ${TOKEN}` }
const JSON_AUTH: Record<string, string> = { ...AUTH, 'content-type': 'application/json' }

// Every test gets a fresh source address, so one test's requests can never
// exhaust the next one's rate-limit window. Mutated in place because the header
// objects are shared by reference across every request in the suite.
let client = 0

beforeEach(() => {
  process.env.CRM_MACHINE_TOKEN = TOKEN
  delete process.env.CRM_MACHINE_PRINCIPAL
  const ip = `10.0.0.${++client}`
  AUTH['x-forwarded-for'] = ip
  JSON_AUTH['x-forwarded-for'] = ip
})

function leadEvents(id: number): Array<{ actor: string; type: string; to_stage: string | null }> {
  return db
    .prepare('SELECT actor, type, to_stage FROM lead_events WHERE lead_id = ? ORDER BY id')
    .all(id) as never
}

function listLinks(id: number): Array<{ id: number; url: string }> {
  return db.prepare('SELECT id, url FROM lead_links WHERE lead_id = ?').all(id) as never
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

test('customers create → get → overview → patch → list by lead_id', async () => {
  const leadRes = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'Kunden-Lead GmbH', website: 'kunden-lead-maschine.de' }),
  })
  const { id: leadId } = (await leadRes.json()) as { id: number }

  const create = await app.request('/api/machine/customers', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({
      name: 'Kunden-Lead GmbH',
      city: 'München',
      lead_id: leadId,
      email: 'buero@kunden-lead-maschine.de',
    }),
  })
  assert.equal(create.status, 201)
  const { customer } = (await create.json()) as { customer: { id: number; name: string; lead_id: number } }
  assert.ok(customer.id > 0)
  assert.equal(customer.name, 'Kunden-Lead GmbH')
  assert.equal(customer.lead_id, leadId)

  const get = await app.request(`/api/machine/customers/${customer.id}`, { headers: AUTH })
  assert.equal(get.status, 200)

  const overview = await app.request(`/api/machine/customers/${customer.id}/overview`, { headers: AUTH })
  assert.equal(overview.status, 200)
  const ov = (await overview.json()) as { overview: { customer: { id: number }; kpis: unknown } }
  assert.equal(ov.overview.customer.id, customer.id)
  assert.ok(ov.overview.kpis)

  const patch = await app.request(`/api/machine/customers/${customer.id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ phone: '+49 89 123456', notes: 'via machine' }),
  })
  assert.equal(patch.status, 200)
  const patched = (await patch.json()) as { customer: { phone: string; notes: string } }
  assert.equal(patched.customer.phone, '+49 89 123456')
  assert.equal(patched.customer.notes, 'via machine')

  const byLead = await app.request(`/api/machine/customers?lead_id=${leadId}`, { headers: AUTH })
  assert.equal(byLead.status, 200)
  const { customers } = (await byLead.json()) as { customers: Array<{ id: number }> }
  assert.ok(customers.some((c) => c.id === customer.id))
})

test('customer create without name → 400; unknown id → 404', async () => {
  let res = await app.request('/api/machine/customers', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ city: 'Berlin' }),
  })
  assert.equal(res.status, 400)

  res = await app.request('/api/machine/customers/999999', { headers: AUTH })
  assert.equal(res.status, 404)

  res = await app.request('/api/machine/customers/999999', {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ city: 'Hamburg' }),
  })
  assert.equal(res.status, 404)
})

test('documents list/get and dashboard are readable; the books stay read-only', async () => {
  const docs = await app.request('/api/machine/documents', { headers: AUTH })
  assert.equal(docs.status, 200)
  const { documents } = (await docs.json()) as { documents: unknown[] }
  assert.ok(Array.isArray(documents))

  const missing = await app.request('/api/machine/documents/999999', { headers: AUTH })
  assert.equal(missing.status, 404)

  const dash = await app.request('/api/machine/dashboard', { headers: AUTH })
  assert.equal(dash.status, 200)
  const body = (await dash.json()) as { dashboard: { leads: { total: number } } }
  assert.ok(typeof body.dashboard.leads.total === 'number')

  // The rest of finance stays read-only on the machine surface: an agent drafts
  // invoices (see the Freigaben suite below) and nothing else here.
  for (const [method, path] of [
    ['DELETE', '/api/machine/customers/1'],
    ['POST', '/api/machine/contracts'],
    ['PATCH', '/api/machine/contracts/1'],
    ['POST', '/api/machine/expenses'],
    ['PATCH', '/api/machine/expenses/1'],
    ['DELETE', '/api/machine/expenses/1'],
    ['POST', '/api/machine/subscriptions'],
    ['POST', '/api/machine/catalog'],
    ['POST', '/api/machine/documents/1/payments'],
  ] as const) {
    const res = await app.request(path, { method, headers: JSON_AUTH, body: '{}' })
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} must not mutate`)
  }
})

// --- finance read surface ----------------------------------------------------
// Seeded through the module helpers rather than the routes: the machine surface
// has no way to create any of this, which is exactly the point.

/** Create a Stammkunde through the machine surface and return its id. */
async function newCustomer(name: string): Promise<number> {
  const res = await app.request('/api/machine/customers', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ name }),
  })
  assert.equal(res.status, 201)
  const { customer } = (await res.json()) as { customer: { id: number } }
  return customer.id
}

async function getJson(path: string): Promise<Record<string, never>> {
  const res = await app.request(path, { headers: AUTH })
  assert.equal(res.status, 200, `${path} should be readable`)
  return (await res.json()) as Record<string, never>
}

test('contracts are listable and filterable by customer and status', async () => {
  const customerId = await newCustomer('Vertrags GmbH')
  const draft = createContract({ customer_id: customerId, title: 'Wartung', value_cents: 60000 })
  const active = createContract({ customer_id: customerId, title: 'Pflege', value_cents: 12000 })
  db.prepare("UPDATE contracts SET status = 'aktiv' WHERE id = ?").run(active.id)

  const byCustomer = (await getJson(`/api/machine/contracts?customer_id=${customerId}`)) as unknown as {
    contracts: Array<{ id: number }>
    total: number
  }
  assert.equal(byCustomer.total, 2)
  assert.deepEqual(
    byCustomer.contracts.map((k) => k.id).sort(),
    [draft.id, active.id].sort(),
  )

  const narrowed = (await getJson(
    `/api/machine/contracts?customer_id=${customerId}&status=aktiv`,
  )) as unknown as { contracts: Array<{ id: number }>; total: number }
  assert.equal(narrowed.total, 1)
  assert.equal(narrowed.contracts[0]?.id, active.id)

  // A typo must not fall back to "everything" — that is the whole point of the
  // status filter being built into the WHERE clause.
  const nonsense = (await getJson('/api/machine/contracts?status=nonsense')) as unknown as {
    total: number
  }
  assert.equal(nonsense.total, 0)

  const one = (await getJson(`/api/machine/contracts/${draft.id}`)) as unknown as {
    contract: { id: number; totals: { gross_cents: number } }
  }
  assert.equal(one.contract.id, draft.id)
  assert.ok(one.contract.totals.gross_cents > 0)

  const missing = await app.request('/api/machine/contracts/999999', { headers: AUTH })
  assert.equal(missing.status, 404)
})

test('a signed contract exposes the flag and the filename, never the bytes', async () => {
  const contract = createContract({ title: 'Unterschrieben', value_cents: 5000 })
  const bytes = Buffer.from('%PDF-1.7 unterschriebener Vertrag')
  db.prepare(
    `UPDATE contracts
       SET signed_doc_data = ?, signed_doc_name = ?, signed_doc_mime = ?, signed_doc_size = ?
     WHERE id = ?`,
  ).run(bytes, 'vertrag-unterschrieben.pdf', 'application/pdf', bytes.byteLength, contract.id)

  const body = (await getJson(`/api/machine/contracts/${contract.id}`)) as unknown as {
    contract: Record<string, unknown> & { has_signed_doc: boolean; signed_doc_name: string }
  }
  assert.equal(body.contract.has_signed_doc, true)
  assert.equal(body.contract.signed_doc_name, 'vertrag-unterschrieben.pdf')
  assert.equal('signed_doc_data' in body.contract, false)

  // …and there is no download route to reach them by either.
  const pdf = await app.request(`/api/machine/contracts/${contract.id}/pdf`, { headers: AUTH })
  assert.equal(pdf.status, 404)
})

test('expenses list with a summary that follows the filter, minus the receipt bytes', async () => {
  createExpense(
    { vendor: 'Hetzner', category: 'software', gross_cents: 2380, expense_date: '2026-03-01' },
    null,
  )
  createExpense(
    { vendor: 'Vermieter', category: 'miete', gross_cents: 50000, expense_date: '2026-06-01' },
    null,
  )

  const all = (await getJson('/api/machine/expenses')) as unknown as {
    expenses: Array<Record<string, unknown> & { id: number }>
    total: number
    summary: { gross_cents: number }
  }
  assert.equal(all.total, 2)
  assert.equal(all.summary.gross_cents, 2380 + 50000)
  for (const e of all.expenses) assert.equal('receipt_data' in e, false)

  // The summary covers the filtered set, not the unfiltered table.
  const fromMay = (await getJson('/api/machine/expenses?from=2026-05-01')) as unknown as {
    total: number
    summary: { gross_cents: number }
  }
  assert.equal(fromMay.total, 1)
  assert.equal(fromMay.summary.gross_cents, 50000)

  const one = (await getJson(`/api/machine/expenses/${all.expenses[0]!.id}`)) as unknown as {
    expense: { id: number }
  }
  assert.equal(one.expense.id, all.expenses[0]!.id)

  const missing = await app.request('/api/machine/expenses/999999', { headers: AUTH })
  assert.equal(missing.status, 404)
})

test('recurring plans are readable but cannot be run from the machine surface', async () => {
  const customerId = await newCustomer('Serien GmbH')
  const plan = createRecurring({
    customer_id: customerId,
    title: 'Pflegepauschale',
    cadence: 'monatlich',
    items: [{ description: 'Pflege', quantity: 1, unit: 'Monat', unit_price_cents: 4900 }],
  })

  const byCustomer = (await getJson(
    `/api/machine/recurring?customer_id=${customerId}`,
  )) as unknown as { recurring: Array<{ id: number }>; total: number }
  assert.equal(byCustomer.total, 1)
  assert.equal(byCustomer.recurring[0]?.id, plan.id)

  const activeOnly = (await getJson('/api/machine/recurring?active=1')) as unknown as {
    recurring: Array<{ id: number }>
  }
  assert.ok(activeOnly.recurring.some((r) => r.id === plan.id))

  const one = (await getJson(`/api/machine/recurring/${plan.id}`)) as unknown as {
    recurring: { id: number }
  }
  assert.equal(one.recurring.id, plan.id)

  const missing = await app.request('/api/machine/recurring/999999', { headers: AUTH })
  assert.equal(missing.status, 404)

  // Reading the schedule is fine; triggering a billing run is not.
  const run = await app.request(`/api/machine/recurring/${plan.id}/run`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: '{}',
  })
  assert.ok(run.status === 404 || run.status === 405, 'recurring run must not be reachable')
})

test('subscriptions come with the run-rate summary over the active ones', async () => {
  const live = createSubscription(
    { vendor: 'Hetzner', amount_cents: 1000, cadence: 'monatlich', active: 1 },
    null,
  )
  createSubscription(
    { vendor: 'Altvertrag', amount_cents: 9900, cadence: 'monatlich', active: 0 },
    null,
  )

  const all = (await getJson('/api/machine/subscriptions')) as unknown as {
    subscriptions: Array<{ id: number }>
    total: number
    summary: { active_count: number; monthly_cents: number }
  }
  assert.equal(all.total, 2)
  assert.equal(all.summary.active_count, 1)
  assert.equal(all.summary.monthly_cents, 1000) // the cancelled one is not a running cost

  const activeOnly = (await getJson('/api/machine/subscriptions?active=1')) as unknown as {
    subscriptions: Array<{ id: number }>
    total: number
  }
  assert.equal(activeOnly.total, 1)
  assert.equal(activeOnly.subscriptions[0]?.id, live.id)

  const one = (await getJson(`/api/machine/subscriptions/${live.id}`)) as unknown as {
    subscription: { id: number }
  }
  assert.equal(one.subscription.id, live.id)

  const missing = await app.request('/api/machine/subscriptions/999999', { headers: AUTH })
  assert.equal(missing.status, 404)
})

test('the service catalog is readable, with ?active=1 hiding retired items', async () => {
  const live = createCatalogItem({ name: 'Website-Relaunch', unit_price_cents: 250000, active: 1 })
  const retired = createCatalogItem({ name: 'Faxdienst', unit_price_cents: 900, active: 0 })

  const all = (await getJson('/api/machine/catalog')) as unknown as {
    items: Array<{ id: number }>
    total: number
  }
  assert.equal(all.total, 2)

  const activeOnly = (await getJson('/api/machine/catalog?active=1')) as unknown as {
    items: Array<{ id: number }>
    total: number
  }
  assert.equal(activeOnly.total, 1)
  assert.equal(activeOnly.items[0]?.id, live.id)
  assert.ok(!activeOnly.items.some((i) => i.id === retired.id))

  const one = (await getJson(`/api/machine/catalog/${live.id}`)) as unknown as {
    item: { unit_price_cents: number }
  }
  assert.equal(one.item.unit_price_cents, 250000)

  const missing = await app.request('/api/machine/catalog/999999', { headers: AUTH })
  assert.equal(missing.status, 404)
})

test('list paging is opt-in: no limit is the whole list, a limit is clamped', async () => {
  for (const website of ['paging-eins-maschine.de', 'paging-zwei-maschine.de']) {
    await app.request('/api/machine/leads', {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ company: website, website }),
    })
  }

  type Page = { leads: Array<{ id: number }>; total: number; returned: number; offset: number }

  // Backwards compatible: without ?limit= the caller still gets everything.
  const all = (await getJson('/api/machine/leads')) as unknown as Page
  assert.ok(all.total >= 2)
  assert.equal(all.leads.length, all.total)
  assert.equal(all.returned, all.total)
  assert.equal(all.offset, 0)

  const first = (await getJson('/api/machine/leads?limit=1')) as unknown as Page
  assert.equal(first.returned, 1)
  assert.equal(first.leads.length, 1)
  assert.equal(first.total, all.total) // total counts the filter, not the page

  const second = (await getJson('/api/machine/leads?limit=1&offset=1')) as unknown as Page
  assert.equal(second.returned, 1)
  assert.equal(second.offset, 1)
  assert.notEqual(second.leads[0]?.id, first.leads[0]?.id)

  // An absurd limit is capped rather than honoured…
  const huge = (await getJson('/api/machine/leads?limit=99999')) as unknown as Page
  assert.equal(huge.returned, Math.min(all.total, 500))

  // …and junk falls back to the unpaged default instead of erroring.
  const junk = (await getJson('/api/machine/leads?limit=abc&offset=-5')) as unknown as Page
  assert.equal(junk.offset, 0)
  assert.equal(junk.returned, all.total)
})

test('the finance surface needs the bearer and offers no write verbs', async () => {
  for (const resource of ['contracts', 'expenses', 'recurring', 'subscriptions', 'catalog']) {
    const unauth = await app.request(`/api/machine/${resource}`)
    assert.equal(unauth.status, 401, `${resource} must require the machine bearer`)

    for (const [method, path] of [
      ['POST', `/api/machine/${resource}`],
      ['PATCH', `/api/machine/${resource}/1`],
      ['DELETE', `/api/machine/${resource}/1`],
    ] as const) {
      const res = await app.request(path, { method, headers: JSON_AUTH, body: '{}' })
      assert.ok(res.status === 404 || res.status === 405, `${method} ${path} must not mutate`)
    }
  }
})

// --- lead links, appendable notes, payments and the EÜR ----------------------

test('appending a note grows the timeline without touching the notes field', async () => {
  const create = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'NotizCo', website: 'notizco-maschine.de', notes: 'von Hand' }),
  })
  const { id } = (await create.json()) as { id: number }
  // The lead starts with the operator's note text in the field.
  await app.request(`/api/machine/leads/${id}`, {
    method: 'PATCH',
    headers: JSON_AUTH,
    body: JSON.stringify({ notes: 'von Hand' }),
  })

  const res = await app.request(`/api/machine/leads/${id}/note`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ body: 'Angerufen, Rückruf Dienstag' }),
  })
  assert.equal(res.status, 201)

  const row = db.prepare('SELECT notes FROM leads WHERE id = ?').get(id) as { notes: string | null }
  assert.equal(row.notes, 'von Hand', 'append must not clobber what the operator wrote')
  const notes = leadEvents(id).filter((e) => e.type === 'note')
  assert.equal(notes.length, 2)
  assert.equal(notes[1]?.actor, 'machine:mcp')

  // Empty body → 400, unknown lead → 404, and neither writes an event.
  const empty = await app.request(`/api/machine/leads/${id}/note`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ body: '   ' }),
  })
  assert.equal(empty.status, 400)
  const missing = await app.request('/api/machine/leads/999999/note', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ body: 'x' }),
  })
  assert.equal(missing.status, 404)
  assert.equal(leadEvents(id).filter((e) => e.type === 'note').length, 2)
})

test('links: attach → list → re-attach is idempotent → remove', async () => {
  const create = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'LinkCo', website: 'linkco-maschine.de' }),
  })
  const { id } = (await create.json()) as { id: number }

  const add = await app.request(`/api/machine/leads/${id}/links`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ url: 'preview.example.de/p/abc', label: 'Vorschau', kind: 'preview' }),
  })
  assert.equal(add.status, 201)
  const { link } = (await add.json()) as { link: { id: number; url: string; kind: string } }
  // A bare host gains https:// so the stored value is always a real href.
  assert.equal(link.url, 'https://preview.example.de/p/abc')
  assert.equal(link.kind, 'preview')

  // The attach shows up in the lead's own timeline, like a stage change does.
  assert.ok(leadEvents(id).some((e) => e.type === 'link'))

  const again = await app.request(`/api/machine/leads/${id}/links`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ url: 'https://preview.example.de/p/abc' }),
  })
  assert.equal(again.status, 200)
  const dup = (await again.json()) as { existed: boolean; link: { id: number } }
  assert.equal(dup.existed, true)
  assert.equal(dup.link.id, link.id, 'a retry must not create a second row')

  const list = await app.request(`/api/machine/leads/${id}/links`, { headers: AUTH })
  const { links } = (await list.json()) as { links: unknown[] }
  assert.equal(links.length, 1)

  // The lead detail carries them too, so one call is enough to see everything.
  const detail = await app.request(`/api/machine/leads/${id}`, { headers: AUTH })
  const body = (await detail.json()) as { links: unknown[] }
  assert.equal(body.links.length, 1)

  const del = await app.request(`/api/machine/leads/${id}/links/${link.id}`, {
    method: 'DELETE',
    headers: AUTH,
  })
  assert.equal(del.status, 200)
  const gone = await app.request(`/api/machine/leads/${id}/links/${link.id}`, {
    method: 'DELETE',
    headers: AUTH,
  })
  assert.equal(gone.status, 404)
})

test('links reject anything that is not http(s), and unknown leads', async () => {
  const create = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'BöseLinkCo', website: 'boeselinkco-maschine.de' }),
  })
  const { id } = (await create.json()) as { id: number }

  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x', '  ']) {
    const res = await app.request(`/api/machine/leads/${id}/links`, {
      method: 'POST',
      headers: JSON_AUTH,
      body: JSON.stringify({ url }),
    })
    assert.equal(res.status, 400, `${url} must be rejected`)
  }
  assert.equal(listLinks(id).length, 0)

  const missing = await app.request('/api/machine/leads/999999/links', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ url: 'https://example.de' }),
  })
  assert.equal(missing.status, 404)
})

test('deleting a lead takes its links with it', async () => {
  const create = await app.request('/api/machine/leads', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ company: 'KaskadeCo', website: 'kaskadeco-maschine.de' }),
  })
  const { id } = (await create.json()) as { id: number }
  await app.request(`/api/machine/leads/${id}/links`, {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ url: 'https://kaskadeco-maschine.de' }),
  })
  assert.equal(listLinks(id).length, 1)
  db.prepare('DELETE FROM leads WHERE id = ?').run(id)
  assert.equal(listLinks(id).length, 0)
})

test('payments hang off their invoice; an unknown invoice is a 404', async () => {
  // Documents are only creatable through the browser routes, so seed one
  // directly — the point is that the machine surface can read what was booked
  // against it, not that it could have booked it.
  const docId = Number(
    db
      .prepare("INSERT INTO documents (kind, client_name, status) VALUES ('rechnung', ?, 'offen')")
      .run('Zahler GmbH').lastInsertRowid,
  )
  addPayment(docId, { amount_cents: 25000, paid_on: '2026-08-01', method: 'überweisung' })

  const body = (await getJson(`/api/machine/documents/${docId}/payments`)) as unknown as {
    payments: Array<{ amount_cents: number }>
    total: number
  }
  assert.equal(body.total, 1)
  assert.equal(body.payments[0]?.amount_cents, 25000)

  assert.equal(
    (await app.request('/api/machine/documents/999999/payments', { headers: AUTH })).status,
    404,
    'no invoice, no payment list',
  )

  // Booking one stays with the human who can see the bank statement.
  for (const [method, path] of [
    ['POST', `/api/machine/documents/${docId}/payments`],
    ['DELETE', `/api/machine/documents/${docId}/payments/1`],
  ] as const) {
    const res = await app.request(path, { method, headers: JSON_AUTH, body: '{}' })
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} must not mutate`)
  }
})

test('the EÜR report reads as a derived view, with the VAT position', async () => {
  const ranged = (await getJson(
    '/api/machine/report/euer?from=2026-01-01&to=2026-12-31',
  )) as unknown as { report: { from: string | null; to: string | null } }
  assert.equal(ranged.report.from, '2026-01-01', 'the range is honoured, not ignored')

  const { report } = (await getJson('/api/machine/report/euer')) as unknown as {
    report: { result_net_cents: number; vat: { payable_cents: number } }
  }
  assert.equal(typeof report.result_net_cents, 'number')
  assert.equal(typeof report.vat.payable_cents, 'number')

  // Derived from invoices and expenses, so there is nothing to write to it.
  for (const [method, path] of [
    ['POST', '/api/machine/report/euer'],
    ['DELETE', '/api/machine/report/euer'],
  ] as const) {
    const res = await app.request(path, { method, headers: JSON_AUTH, body: '{}' })
    assert.ok(res.status === 404 || res.status === 405, `${method} ${path} must not mutate`)
  }
})

test('the new routes are behind the same bearer as the rest', async () => {
  delete process.env.CRM_MACHINE_TOKEN
  for (const path of [
    '/api/machine/leads/1/links',
    '/api/machine/contracts',
    '/api/machine/expenses',
    '/api/machine/subscriptions',
    '/api/machine/catalog',
    '/api/machine/report/euer',
    '/api/machine/documents/1/payments',
  ]) {
    assert.equal((await app.request(path, { headers: AUTH })).status, 401, path)
  }
  const note = await app.request('/api/machine/leads/1/note', {
    method: 'POST',
    headers: JSON_AUTH,
    body: JSON.stringify({ body: 'x' }),
  })
  assert.equal(note.status, 401)
})
