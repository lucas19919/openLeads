import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'

const DB_FILE = join(tmpdir(), `openleads-connections-${process.pid}.db`)
process.env.DB_PATH = DB_FILE

const { db } = await import('./db')
await import('./integrations') // registers all adapters
const { available } = await import('./integrations/registry')
const { verifyGcSignature, mapGcEvent, gocardlessDefinition } = await import('./integrations/adapters/gocardless')
const { mapDocToLexoffice, lexofficeDefinition, lexofficeIdempotencyKey } = await import('./integrations/adapters/lexoffice')
const { mapDocToSevdesk } = await import('./integrations/adapters/sevdesk')
const { normalizeE164, buildSipgateCallBody } = await import('./integrations/adapters/sipgate')
const { buildAuthorizeUrl, parseIdTokenEmail, scopesFor, GOOGLE_SPEC, MSGRAPH_SPEC, getAccessToken, isOAuthConnected, storeTokens } = await import('./integrations/oauth')
const { encryptSecret } = await import('./secrets')
const { buildGmailRaw, mapCalendarEvent } = await import('./integrations/adapters/google')
const { buildGraphSendMailBody, mapGraphEvent } = await import('./integrations/adapters/msgraph')
const { createHmac } = await import('node:crypto')
import type { FullDocument } from './documents'

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

function fixtureDoc(over: Partial<FullDocument> = {}): FullDocument {
  const items = [
    { id: 1, document_id: 1, description: 'Webseite', quantity: 1, unit: 'Pauschal', unit_price_cents: 100000, sort: 0 },
    { id: 2, document_id: 1, description: 'Wartung', quantity: 2, unit: 'Monat', unit_price_cents: 5000, sort: 1 },
  ]
  return {
    id: 1, kind: 'rechnung', number: 'RE-2026-0001', lead_id: null, client_name: 'Maler Müller',
    client_address: 'Dorfstr. 2', client_zip: '85435', client_city: 'Erding', client_email: 'k@x.de',
    title: 'Rechnung', intro: null, notes: null, status: 'versendet', issue_date: '2026-06-20', due_date: '2026-07-04',
    small_business: 0, vat_rate: 19, buyer_reference: null, client_type: 'geschaeft', client_vat_id: 'DE123456789',
    include_payment_link: 1, accounting_provider: null, accounting_external_id: null, accounting_pushed_at: null,
    created_at: '', updated_at: '', items, totals: { net_cents: 110000, vat_cents: 20900, gross_cents: 130900 }, paid_cents: 0,
    ...over,
  }
}

test('catalogue includes every shipped adapter', () => {
  const ids = available().map((d) => `${d.category}:${d.provider}`)
  for (const id of [
    'payment:stripe', 'payment:gocardless', 'accounting:vies', 'accounting:lexoffice', 'accounting:sevdesk',
    'mail:smtp', 'mail:google', 'mail:microsoft', 'calendar:google', 'calendar:microsoft', 'telephony:sipgate',
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`)
  }
})

test('GoCardless webhook signature: plain HMAC, fails closed', () => {
  const secret = 'gc_whsec'
  const body = JSON.stringify({ events: [{ id: 'EV1', resource_type: 'payments', action: 'confirmed', metadata: { document_id: '7' } }] })
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  assert.equal(verifyGcSignature(secret, body, sig), true)
  assert.equal(verifyGcSignature(secret, body + ' ', sig), false) // tamper
  assert.equal(verifyGcSignature('', body, sig), false) // unset secret
  assert.equal(verifyGcSignature(secret, body, null), false) // no header

  const parsed = mapGcEvent(JSON.parse(body))
  assert.equal(parsed.external_id, 'EV1')
  assert.equal(parsed.paid, true)
  assert.equal(parsed.document_id, 7)
})

// A helper to swap global.fetch for a test and always restore it.
async function withFetch<T>(impl: typeof globalThis.fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

function gcAdapter() {
  return gocardlessDefinition.build({
    id: 0, category: 'payment', provider: 'gocardless', label: null,
    config: {}, secrets: { access_token: 'tok', webhook_secret: 'whs' },
  })
}

test('GoCardless parseWebhook fetches the paid amount + currency (async enrichment)', async () => {
  const adapter = gcAdapter()
  const body = JSON.stringify({ events: [{ id: 'EV1', resource_type: 'payments', action: 'confirmed', links: { payment: 'PM123' }, metadata: { document_id: '7' } }] })
  let calledUrl = ''
  const parsed = await withFetch(
    (async (url: string | URL) => {
      calledUrl = String(url)
      return { ok: true, status: 200, json: async () => ({ payments: { amount: 11900, currency: 'EUR' } }) } as Response
    }) as unknown as typeof globalThis.fetch,
    () => Promise.resolve(adapter.parseWebhook(body)),
  )
  assert.match(calledUrl, /\/payments\/PM123$/)
  assert.equal(parsed.paid, true)
  assert.equal(parsed.document_id, 7)
  assert.equal(parsed.amount_cents, 11900) // GoCardless amount is already in cents
  assert.equal(parsed.currency, 'EUR')
})

test('GoCardless parseWebhook: a transient amount-fetch failure throws (provider retries)', async () => {
  const adapter = gcAdapter()
  const body = JSON.stringify({ events: [{ id: 'EV2', resource_type: 'payments', action: 'confirmed', links: { payment: 'PM9' }, metadata: { document_id: '3' } }] })
  await withFetch(
    (async () => { throw new Error('network') }) as unknown as typeof globalThis.fetch,
    () => assert.rejects(async () => { await adapter.parseWebhook(body) }, /nicht erreichbar/),
  )
})

test('GoCardless parseWebhook: a non-paid event never calls the API', async () => {
  const adapter = gcAdapter()
  const body = JSON.stringify({ events: [{ id: 'EV3', resource_type: 'payments', action: 'submitted', links: { payment: 'PM9' }, metadata: { document_id: '3' } }] })
  let called = false
  const parsed = await withFetch(
    (async () => { called = true; return { ok: true, json: async () => ({}) } as Response }) as unknown as typeof globalThis.fetch,
    () => Promise.resolve(adapter.parseWebhook(body)),
  )
  assert.equal(called, false)
  assert.equal(parsed.paid, false)
  assert.equal(parsed.amount_cents, undefined)
})

test('getAccessToken clears a revoked refresh token (invalid_grant) and flags reconnect', async () => {
  const credEnc = encryptSecret(JSON.stringify({ client_secret: 'csec' }))
  const info = db
    .prepare(
      `INSERT INTO integration_connections (category, provider, label, config, credentials_enc, active, status)
       VALUES ('mail', 'google', 'Gmail', ?, ?, 1, 'ok')`,
    )
    .run(JSON.stringify({ client_id: 'cid' }), credEnc)
  const connId = Number(info.lastInsertRowid)
  // Expired access token (expires_in negative) forces the refresh path.
  storeTokens(connId, { access_token: 'old', refresh_token: 'rt', expires_in: -100, account_email: 'me@firma.de' })
  assert.equal(isOAuthConnected(connId).connected, true)

  await withFetch(
    (async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }) }) as Response) as unknown as typeof globalThis.fetch,
    () => assert.rejects(() => getAccessToken(connId), /neu verbinden/),
  )

  // Dead token cleared → no longer "connected"; connection flagged for reconnect.
  assert.equal(isOAuthConnected(connId).connected, false)
  const row = db.prepare('SELECT status FROM integration_connections WHERE id = ?').get(connId) as { status: string }
  assert.equal(row.status, 'error')
})

test('getAccessToken keeps the token on a transient refresh failure', async () => {
  const credEnc = encryptSecret(JSON.stringify({ client_secret: 'csec' }))
  const info = db
    .prepare(
      `INSERT INTO integration_connections (category, provider, label, config, credentials_enc, active, status)
       VALUES ('mail', 'microsoft', 'Outlook', ?, ?, 0, 'ok')`,
    )
    .run(JSON.stringify({ client_id: 'cid' }), credEnc)
  const connId = Number(info.lastInsertRowid)
  storeTokens(connId, { access_token: 'old', refresh_token: 'rt', expires_in: -100 })

  await withFetch(
    (async () => { throw new Error('boom') }) as unknown as typeof globalThis.fetch,
    () => assert.rejects(() => getAccessToken(connId), /nicht erreichbar/),
  )
  // Transient failure must NOT nuke the token — still connected for the next try.
  assert.equal(isOAuthConnected(connId).connected, true)
})

test('lexoffice mapper: cents→EUR, §19 → vatfree + 0% + remark', () => {
  const std = mapDocToLexoffice(fixtureDoc())
  assert.equal(std.lineItems[0].unitPrice.netAmount, 1000) // 100000 cents → 1000.00 €
  assert.equal(std.lineItems[0].unitPrice.taxRatePercentage, 19)
  assert.equal(std.taxConditions.taxType, 'net')

  const klein = mapDocToLexoffice(fixtureDoc({ small_business: 1 }))
  assert.equal(klein.taxConditions.taxType, 'vatfree')
  assert.equal(klein.lineItems[0].unitPrice.taxRatePercentage, 0)
  assert.match(klein.remark ?? '', /§ ?19/)
})

test('lexoffice push sends a stable Idempotency-Key per invoice (dedups retries)', async () => {
  const adapter = lexofficeDefinition.build({
    id: 0, category: 'accounting', provider: 'lexoffice', label: null, config: {}, secrets: { api_key: 'lxk' },
  })
  const doc = fixtureDoc()
  const seen: (string | null)[] = []
  const impl = (async (_url: string | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('idempotency-key'))
    return { ok: true, status: 200, json: async () => ({ id: 'lxinv_1', resourceUri: 'https://api.lexware.io/v1/invoices/lxinv_1' }) } as Response
  }) as unknown as typeof globalThis.fetch

  const r1 = await withFetch(impl, () => adapter.pushInvoice!(doc, { actor: null }))
  await withFetch(impl, () => adapter.pushInvoice!(doc, { actor: null }))
  assert.equal(r1.external_id, 'lxinv_1')
  assert.ok(seen[0]) // a key was sent
  assert.equal(seen[0], seen[1]) // stable across retries → lexoffice dedups
  assert.equal(seen[0], lexofficeIdempotencyKey(doc.id))
})

test('sevDesk mapper: price in euros, taxRate 19 / 0', () => {
  const std = mapDocToSevdesk(fixtureDoc(), { contactId: '42' })
  assert.equal(std.invoice.contact.id, '42')
  assert.equal(std.invoicePosSave[0].price, 1000)
  assert.equal(std.invoicePosSave[0].taxRate, 19)
  const klein = mapDocToSevdesk(fixtureDoc({ small_business: 1 }), { contactId: '42' })
  assert.equal(klein.invoicePosSave[0].taxRate, 0)
})

test('sipgate E.164 normalisation + call body', () => {
  assert.equal(normalizeE164('0049 30 1234567'), '+49301234567')
  assert.equal(normalizeE164('030 1234567'), '+49301234567')
  assert.equal(normalizeE164('+44 20 7946 0958'), '+442079460958')
  assert.throws(() => normalizeE164('abc'), /Ungültige Zielrufnummer/)
  const body = buildSipgateCallBody({ to: '030 1234567' }, { deviceId: 'e0', callerId: '+493000' })
  assert.deepEqual(body, { deviceId: 'e0', caller: 'e0', callee: '+49301234567', callerId: '+493000' })
})

test('OAuth authorize URLs are well-formed (pure)', () => {
  const g = new URL(buildAuthorizeUrl(GOOGLE_SPEC, { clientId: 'cid', redirectUri: 'https://crm/cb', scope: scopesFor('google', 'mail'), state: 'st8' }))
  assert.equal(g.origin + g.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
  assert.equal(g.searchParams.get('response_type'), 'code')
  assert.equal(g.searchParams.get('access_type'), 'offline')
  assert.equal(g.searchParams.get('prompt'), 'consent')
  assert.equal(g.searchParams.get('redirect_uri'), 'https://crm/cb')
  assert.equal(g.searchParams.get('state'), 'st8')
  assert.match(g.searchParams.get('scope') ?? '', /gmail\.send/)

  const m = new URL(buildAuthorizeUrl(MSGRAPH_SPEC, { clientId: 'cid', redirectUri: 'https://crm/cb', scope: scopesFor('microsoft', 'calendar'), state: 's', tenant: 'mytenant' }))
  assert.ok(m.pathname.startsWith('/mytenant/'))
  assert.match(m.searchParams.get('scope') ?? '', /Calendars\.ReadWrite/)
  assert.match(m.searchParams.get('scope') ?? '', /offline_access/)
  // default tenant 'common'
  const m2 = new URL(buildAuthorizeUrl(MSGRAPH_SPEC, { clientId: 'c', redirectUri: 'r', scope: ['openid'], state: 's' }))
  assert.ok(m2.pathname.startsWith('/common/'))
})

test('parseIdTokenEmail decodes the JWT payload, null on garbage', () => {
  const payload = Buffer.from(JSON.stringify({ email: 'inhaber@firma.de' }), 'utf8').toString('base64url')
  assert.equal(parseIdTokenEmail(`h.${payload}.sig`), 'inhaber@firma.de')
  assert.equal(parseIdTokenEmail('not-a-jwt'), null)
  assert.equal(parseIdTokenEmail(null), null)
})

test('Gmail/Graph mail + calendar builders are well-formed (pure)', () => {
  const raw = buildGmailRaw({ to: 'k@x.de', from: 'me@firma.de', subject: 'Rechnung RE-1 — Grüße', text: 'Hallo' })
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  assert.match(decoded, /To: k@x\.de/)
  assert.match(decoded, /Subject: =\?UTF-8\?B\?/) // umlaut subject is RFC2047-encoded
  assert.match(decoded, /\r\n\r\nHallo$/)

  const gcal = mapCalendarEvent({ title: 'Rückruf', start: '2026-06-21T09:00:00Z', end: '2026-06-21T09:30:00Z', attendees: ['k@x.de'] })
  assert.equal(gcal.summary, 'Rückruf')
  assert.equal(gcal.start.dateTime, '2026-06-21T09:00:00Z')
  assert.deepEqual(gcal.attendees, [{ email: 'k@x.de' }])

  const gm = buildGraphSendMailBody({ to: 'k@x.de', subject: 'Hi', text: 'Body' })
  assert.equal(gm.message.toRecipients[0].emailAddress.address, 'k@x.de')
  assert.equal(gm.message.body.contentType, 'Text')

  // With an attachment: Gmail emits multipart/mixed with the base64 part; Graph
  // emits a fileAttachment carrying the base64 bytes.
  const pdf = Buffer.from('%PDF-1.4 hello')
  const rawA = Buffer.from(
    buildGmailRaw({ to: 'k@x.de', subject: 'Mit Anhang', text: 'Hallo', attachments: [{ filename: 'rechnung.pdf', content: pdf, contentType: 'application/pdf' }] }),
    'base64url',
  ).toString('utf8')
  assert.match(rawA, /Content-Type: multipart\/mixed; boundary=/)
  assert.match(rawA, /Content-Disposition: attachment; filename="rechnung\.pdf"/)
  assert.match(rawA, new RegExp(pdf.toString('base64').slice(0, 16)))

  const gmA = buildGraphSendMailBody({ to: 'k@x.de', subject: 'Mit Anhang', text: 'Hallo', attachments: [{ filename: 'rechnung.pdf', content: pdf, contentType: 'application/pdf' }] })
  const att = gmA.message.attachments
  assert.equal(att?.[0]['@odata.type'], '#microsoft.graph.fileAttachment')
  assert.equal(att?.[0].name, 'rechnung.pdf')
  assert.equal(att?.[0].contentBytes, pdf.toString('base64'))

  // CRLF in a header value must NOT inject an extra header (e.g. Bcc) into the raw MIME.
  const injected = buildGmailRaw({ to: 'k@x.de\r\nBcc: evil@x.de', subject: 'Hi\r\nX-Evil: 1', text: 'Body' })
  const injectedRaw = Buffer.from(injected, 'base64url').toString('utf8')
  // The CRLF is stripped, so Bcc/X-Evil never appear at the start of a header line.
  assert.doesNotMatch(injectedRaw, /(^|\r\n)Bcc:/)
  assert.doesNotMatch(injectedRaw, /(^|\r\n)X-Evil:/)
  assert.match(injectedRaw, /To: k@x\.de Bcc: evil@x\.de/) // folded into the To value, harmless

  const gev = mapGraphEvent({ title: 'Termin', start: '2026-06-21T09:00:00Z', end: '2026-06-21T10:00:00Z' })
  assert.equal(gev.start.timeZone, 'UTC')
  assert.equal(gev.start.dateTime, '2026-06-21T09:00:00') // no trailing Z, UTC tz
})
