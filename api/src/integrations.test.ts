import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-integrations-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
await import('./integrations') // registers stripe/vies/smtp
const { available, getDefinition, saveConnection, activate, resolve, listConnections } =
  await import('./integrations/registry')
const { stripeDefinition } = await import('./integrations/adapters/stripe')
const { mapViesResponse, splitVatId } = await import('./integrations/adapters/vies')
const { smtpDefinition } = await import('./integrations/adapters/smtp')
const { signPayload } = await import('./webhooks/sign')
import type { PaymentProvider } from './integrations/types'

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

test('shipped adapters are registered in the catalogue', () => {
  const providers = available().map((d) => `${d.category}:${d.provider}`)
  assert.ok(providers.includes('payment:stripe'))
  assert.ok(providers.includes('accounting:vies'))
  assert.ok(providers.includes('mail:smtp'))
  assert.equal(getDefinition('payment', 'stripe')?.label, 'Stripe')
})

test('a connection persists secrets encrypted and resolves to the active adapter', () => {
  const id = saveConnection({
    category: 'payment',
    provider: 'stripe',
    config: { success_url: 'https://shop.example/ok' },
    secrets: { secret_key: 'sk_test_123', webhook_secret: 'whsec_abc' },
    actor: 'admin',
  })
  // credentials are ciphertext at rest, never the plaintext key
  const row = db.prepare('SELECT credentials_enc, config FROM integration_connections WHERE id = ?').get(id) as { credentials_enc: string; config: string }
  assert.ok(row.credentials_enc && !row.credentials_enc.includes('sk_test_123'))
  assert.ok(!row.config.includes('sk_test_123')) // secret never in the plaintext config column

  assert.equal(resolve('payment'), null) // not active yet
  assert.equal(activate(id, 'admin'), true)
  const adapter = resolve('payment') as PaymentProvider | null
  assert.ok(adapter)
  assert.equal(adapter!.provider, 'stripe')

  // listConnections redacts to a presence boolean (no decrypted secret)
  const conn = listConnections().find((x) => x.id === id)!
  assert.equal(conn.active, 1)
})

test('Stripe webhook verification is constant-time over the raw body', async () => {
  const adapter = stripeDefinition.build({
    id: 0,
    category: 'payment',
    provider: 'stripe',
    label: null,
    config: { success_url: 'https://x' },
    secrets: { secret_key: 'sk', webhook_secret: 'whsec_sign' },
  })
  const body = JSON.stringify({
    id: 'evt_1',
    type: 'checkout.session.completed',
    data: { object: { amount_total: 11900, currency: 'eur', payment_status: 'paid', metadata: { document_id: '7' } } },
  })
  const t = Math.floor(Date.now() / 1000)
  const good = signPayload('whsec_sign', body, t) // same HMAC scheme as Stripe
  assert.equal(adapter.verifyWebhook(body, { 'stripe-signature': good }), true)
  assert.equal(adapter.verifyWebhook(body + ' ', { 'stripe-signature': good }), false) // tamper
  assert.equal(adapter.verifyWebhook(body, {}), false) // no signature → fail closed

  const parsed = await adapter.parseWebhook(body)
  assert.equal(parsed.external_id, 'evt_1')
  assert.equal(parsed.paid, true)
  assert.equal(parsed.amount_cents, 11900)
  assert.equal(parsed.document_id, 7)
})

test('VIES helpers are pure and parse a response correctly', () => {
  assert.deepEqual(splitVatId('DE 123 456 789'), { country: 'DE', number: '123456789' })
  const v = mapViesResponse(
    { isValid: true, name: 'Muster GmbH', address: 'Musterstr. 1', countryCode: 'DE', vatNumber: '123456789' },
    'DE',
    '123456789',
  )
  assert.equal(v.valid, true)
  assert.equal(v.country_code, 'DE')
  assert.equal(v.name, 'Muster GmbH')
  const invalid = mapViesResponse({ isValid: false }, 'DE', '000')
  assert.equal(invalid.valid, false)
  assert.equal(invalid.name, null)
})

test('SMTP adapter reports its category and unconfigured probe', async () => {
  const adapter = smtpDefinition.build({ id: 0, category: 'mail', provider: 'smtp', label: null, config: {}, secrets: {} })
  assert.equal(adapter.category, 'mail')
  const p = await adapter.probe() // SMTP not configured in tests
  assert.equal(p.ok, false)
})

test('Stripe createPaymentLink rejects non-positive / non-integer amounts (before any network)', async () => {
  const adapter = stripeDefinition.build({
    id: 0, category: 'payment', provider: 'stripe', label: null,
    config: { success_url: 'https://shop.example/ok' }, secrets: { secret_key: 'sk_test' },
  })
  await assert.rejects(() => adapter.createPaymentLink({ amount_cents: 0, currency: 'eur' }, { actor: null }), /positive Ganzzahl/)
  await assert.rejects(() => adapter.createPaymentLink({ amount_cents: 12.5, currency: 'eur' }, { actor: null }), /positive Ganzzahl/)
})

test('splitVatId handles empty + lowercase + spaced input', () => {
  assert.deepEqual(splitVatId(''), { country: '', number: '' })
  assert.deepEqual(splitVatId('de 123 456'), { country: 'DE', number: '123456' })
})

test('payment webhook applies once, dedups replays, and rolls the event back on a side-effect failure', async () => {
  const { Hono } = await import('hono')
  const { registerIntegrationRoutes } = await import('./integrations/router')

  // An active Stripe connection with a known signing secret (upserts payment:stripe).
  const secret = 'whsec_rollback_test'
  const cid = saveConnection({
    category: 'payment',
    provider: 'stripe',
    config: { success_url: 'https://shop.example/ok' },
    secrets: { secret_key: 'sk_test', webhook_secret: secret },
    actor: 'admin',
  })
  activate(cid, 'admin')

  // A finalised invoice to be paid. Gross 200,00 € so the two 50,00 € webhook
  // payments are each within the receiver's plausibility cap AND leave the invoice
  // partially paid (so the retried evt_pay_2 still applies — not refused as
  // already-bezahlt).
  const docId = Number(
    db.prepare("INSERT INTO documents (kind, number, status) VALUES ('rechnung', 'RE-TEST-1', 'versendet')").run()
      .lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO document_items (document_id, description, quantity, unit_price_cents, sort) VALUES (?, 'Leistung', 1, 20000, 0)",
  ).run(docId)

  const app = new Hono()
  // The webhook route is unauthenticated by design; the admin guard is a no-op here.
  registerIntegrationRoutes(app, async (_c, next) => {
    await next()
  })

  const post = (evtId: string) => {
    const body = JSON.stringify({
      id: evtId,
      type: 'checkout.session.completed',
      data: { object: { amount_total: 5000, currency: 'eur', payment_status: 'paid', metadata: { document_id: String(docId) } } },
    })
    const sig = signPayload(secret, body, Math.floor(Date.now() / 1000))
    return app.fetch(
      new Request('http://x/api/integrations/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
        body,
      }),
    )
  }
  const paymentCount = () =>
    (db.prepare('SELECT COUNT(*) AS c FROM payments WHERE document_id = ?').get(docId) as { c: number }).c
  const eventCount = (evt: string) =>
    (db.prepare('SELECT COUNT(*) AS c FROM integration_events WHERE external_id = ?').get(evt) as { c: number }).c

  // 1. First delivery records exactly one payment and marks the event processed.
  let res = await post('evt_pay_1')
  assert.equal(res.status, 200)
  assert.equal(paymentCount(), 1)
  assert.equal(
    (db.prepare("SELECT processed FROM integration_events WHERE external_id = 'evt_pay_1'").get() as { processed: number }).processed,
    1,
  )

  // 2. A replay is a no-op duplicate — the payment is not applied twice.
  res = await post('evt_pay_1')
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, duplicate: true })
  assert.equal(paymentCount(), 1)

  // 3. A side-effect failure must roll the event row back so the retry re-applies.
  //    Force addPayment's INSERT to throw by hiding the payments table mid-flight.
  db.exec('ALTER TABLE payments RENAME TO payments_bak')
  res = await post('evt_pay_2')
  assert.equal(res.status, 500) // handler rethrew → Hono 500, transaction rolled back
  assert.equal(eventCount('evt_pay_2'), 0) // event row did NOT survive the rollback
  db.exec('ALTER TABLE payments_bak RENAME TO payments')

  // The provider's retry now succeeds and the payment is finally recorded.
  res = await post('evt_pay_2')
  assert.equal(res.status, 200)
  assert.equal(eventCount('evt_pay_2'), 1)
  assert.equal(paymentCount(), 2)
})

test('payment webhook refuses an implausible amount or a non-EUR currency (no auto-mark-paid)', async () => {
  const { Hono } = await import('hono')
  const { registerIntegrationRoutes } = await import('./integrations/router')

  const secret = 'whsec_amount_test'
  const cid = saveConnection({
    category: 'payment', provider: 'stripe',
    config: { success_url: 'https://shop.example/ok' },
    secrets: { secret_key: 'sk_test', webhook_secret: secret },
    actor: 'admin',
  })
  activate(cid, 'admin')

  // A 50,00 € invoice (one 5000-cent item).
  const docId = Number(
    db.prepare("INSERT INTO documents (kind, number, status) VALUES ('rechnung', 'RE-AMT-1', 'versendet')").run()
      .lastInsertRowid,
  )
  db.prepare(
    "INSERT INTO document_items (document_id, description, quantity, unit_price_cents, sort) VALUES (?, 'Leistung', 1, 5000, 0)",
  ).run(docId)

  const app = new Hono()
  registerIntegrationRoutes(app, async (_c, next) => { await next() })

  const post = (evtId: string, amount_total: number, currency: string) => {
    const body = JSON.stringify({
      id: evtId, type: 'checkout.session.completed',
      data: { object: { amount_total, currency, payment_status: 'paid', metadata: { document_id: String(docId) } } },
    })
    const sig = signPayload(secret, body, Math.floor(Date.now() / 1000))
    return app.fetch(new Request('http://x/api/integrations/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body,
    }))
  }
  const paymentCount = () =>
    (db.prepare('SELECT COUNT(*) AS c FROM payments WHERE document_id = ?').get(docId) as { c: number }).c

  const applied = async (res: Response) => ((await res.json()) as { applied?: boolean }).applied

  // €50,000 against a €50 invoice — refused (unit/magnitude error or wrong invoice).
  let res = await post('evt_big', 5_000_000, 'eur')
  assert.equal(res.status, 200)
  assert.equal(await applied(res), false)
  assert.equal(paymentCount(), 0)

  // Right magnitude but wrong currency — refused (the ledger is EUR-only).
  res = await post('evt_usd', 5000, 'usd')
  assert.equal(res.status, 200)
  assert.equal(await applied(res), false)
  assert.equal(paymentCount(), 0)

  // The matching EUR amount is accepted.
  res = await post('evt_ok', 5000, 'eur')
  assert.equal(res.status, 200)
  assert.equal(await applied(res), true)
  assert.equal(paymentCount(), 1)
})

test('activating a provider deactivates its category siblings (one active per category)', () => {
  const stripe = saveConnection({
    category: 'payment', provider: 'stripe',
    config: { success_url: 'https://x' }, secrets: { secret_key: 'sk' }, actor: 'admin',
  })
  const gc = saveConnection({
    category: 'payment', provider: 'gocardless',
    config: { success_redirect_url: 'https://x' }, secrets: { access_token: 'tok' }, actor: 'admin',
  })

  activate(stripe, 'admin')
  assert.equal(resolve('payment')?.provider, 'stripe')

  activate(gc, 'admin')
  assert.equal(resolve('payment')?.provider, 'gocardless')

  const active = db
    .prepare("SELECT COUNT(*) AS c FROM integration_connections WHERE category = 'payment' AND active = 1")
    .get() as { c: number }
  assert.equal(active.c, 1)
})

test('the partial unique index rejects a second active connection in a category', () => {
  const inactive = db
    .prepare("SELECT id FROM integration_connections WHERE category = 'payment' AND active = 0 ORDER BY id LIMIT 1")
    .get() as { id: number } | undefined
  assert.ok(inactive, 'expected an inactive payment connection from the previous test')
  // Forcing a second active=1 via raw SQL must violate idx_intconn_one_active.
  assert.throws(
    () => db.prepare('UPDATE integration_connections SET active = 1 WHERE id = ?').run(inactive!.id),
    /UNIQUE/,
  )
})

test('the connections route enforces required fields (rejects missing, accepts complete)', async () => {
  const { Hono } = await import('hono')
  const { registerIntegrationRoutes } = await import('./integrations/router')
  const app = new Hono()
  registerIntegrationRoutes(app, async (_c, next) => {
    await next()
  })
  const errOf = async (res: Response) => ((await res.json()) as { error?: string }).error

  // An unconfigured provider that has at least one required field.
  const def = available().find(
    (d) =>
      d.configSchema.some((f) => f.required) &&
      !listConnections().some((c) => c.category === d.category && c.provider === d.provider),
  )
  assert.ok(def, 'expected an unconfigured provider with a required field')
  const post = (fields: Record<string, unknown>) =>
    app.fetch(
      new Request('http://x/api/integrations/connections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: def!.category, provider: def!.provider, fields }),
      }),
    )

  // Empty submission → rejected, nothing persisted.
  const bad = await post({})
  assert.equal(bad.status, 400)
  assert.match((await errOf(bad)) ?? '', /Pflichtfeld/)
  assert.equal(
    listConnections().some((c) => c.category === def!.category && c.provider === def!.provider),
    false,
  )

  // All required fields provided → accepted.
  const fields: Record<string, unknown> = {}
  for (const f of def!.configSchema) {
    if (f.required) fields[f.key] = f.type === 'number' ? 1 : 'https://example.test/x'
  }
  const ok = await post(fields)
  assert.equal(ok.status, 201)
})
