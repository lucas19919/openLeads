import type { Hono, MiddlewareHandler } from 'hono'
import { createHash } from 'node:crypto'
import { db, type IntegrationConnectionRow } from '../db'
import { audit } from '../audit'
import { rateLimit } from '../ratelimit'
import { getDocument, tx } from '../documents'
import { addPayment, paidCents } from '../payments'
import { emit } from '../webhooks/bus'
import {
  available,
  listConnections,
  getConnection,
  saveConnection,
  activate,
  deleteConnection,
  adapterById,
  resolveActiveByProvider,
  setStatus,
} from './registry'
import type { IntegrationCategory, PaymentProvider } from './types'
import { createPendingAuthUrl, completeCallback, isOAuthConnected, disconnectOAuth } from './oauth'

// Minimal self-closing page shown after the OAuth redirect (sanitised message).
function oauthHtml(message: string): string {
  const safe = message.replace(/[<>&]/g, '')
  return `<!doctype html><meta charset="utf-8"><title>OpenLeads</title><body style="font-family:system-ui;padding:40px;text-align:center;color:#1c2733"><p>${safe}</p><script>setTimeout(function(){window.close()},2500)</script></body>`
}

// /api/integrations/* — management routes are admin-only; the inbound provider
// webhook receiver is intentionally UNAUTHENTICATED and gated SOLELY by the
// adapter's signature verification (an inbound webhook can't carry a session).

type App = Hono<any> // eslint-disable-line @typescript-eslint/no-explicit-any

const MAX_WEBHOOK_BODY = 1_000_000 // 1 MB cap on inbound bodies

// Ledger payment-method label per webhook provider (a SEPA settlement isn't "Stripe").
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  stripe: 'Stripe',
  gocardless: 'SEPA-Lastschrift (GoCardless)',
}

function actorOf(c: Parameters<MiddlewareHandler>[0]): string | null {
  return (c.get('user') as { username?: string } | undefined)?.username ?? null
}

function publicConnection(r: IntegrationConnectionRow) {
  let config: Record<string, unknown> = {}
  try {
    config = JSON.parse(r.config)
  } catch {
    /* keep {} */
  }
  const oauth = isOAuthConnected(r.id)
  return {
    id: r.id,
    category: r.category,
    provider: r.provider,
    label: r.label,
    active: r.active === 1,
    status: r.status,
    status_detail: r.status_detail,
    config, // only non-secret fields ever land here
    credentials_set: !!r.credentials_enc,
    oauth_connected: oauth.connected,
    account_email: oauth.account_email,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function registerIntegrationRoutes(app: App, requireAdmin: MiddlewareHandler): void {
  // --- catalogue: provider definitions + their config form schema -----------
  app.get('/api/integrations/providers', requireAdmin, (c) => {
    const providers = available().map((d) => ({
      category: d.category,
      provider: d.provider,
      label: d.label,
      configSchema: d.configSchema,
    }))
    return c.json({ providers })
  })

  // --- configured connections -----------------------------------------------
  app.get('/api/integrations/connections', requireAdmin, (c) => {
    return c.json({ connections: listConnections().map(publicConnection) })
  })

  app.post('/api/integrations/connections', requireAdmin, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const category = String(b.category ?? '') as IntegrationCategory
    const provider = String(b.provider ?? '')
    const def = available(category).find((d) => d.provider === provider)
    if (!def) return c.json({ error: 'Unbekannter Anbieter.' }, 400)

    // Split the submitted `fields` into non-secret config and encrypted secrets,
    // driven by the definition's schema. Empty values are ignored (so an update
    // that omits a secret keeps the stored one).
    const fields = (b.fields && typeof b.fields === 'object' ? b.fields : {}) as Record<string, unknown>
    const config: Record<string, unknown> = {}
    const secrets: Record<string, string> = {}
    for (const f of def.configSchema) {
      const v = fields[f.key]
      if (v === undefined || v === null || v === '') continue
      if (f.secret) secrets[f.key] = String(v)
      else config[f.key] = f.type === 'number' ? Number(v) : f.type === 'boolean' ? !!v : String(v)
    }
    try {
      const id = saveConnection({
        category,
        provider,
        label: (b.label as string) ?? null,
        config,
        secrets: Object.keys(secrets).length ? secrets : undefined,
        actor: actorOf(c),
      })
      return c.json({ connection: publicConnection(getConnection(id)!) }, 201)
    } catch (e) {
      // encryptSecret throws the German SETTINGS_KEY error in prod — surface it.
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  app.post('/api/integrations/connections/:id/activate', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    if (!activate(id, actorOf(c))) return c.json({ error: 'not found' }, 404)
    return c.json({ connection: publicConnection(getConnection(id)!) })
  })

  app.post('/api/integrations/connections/:id/probe', requireAdmin, async (c) => {
    const id = Number(c.req.param('id'))
    const adapter = adapterById(id)
    if (!adapter) return c.json({ error: 'not found' }, 404)
    const result = await adapter.probe()
    setStatus(id, result.ok ? 'ok' : 'error', result.detail ?? null)
    audit({ actor: actorOf(c), action: 'integration.probe', entity: 'integration', entityId: id, detail: { ok: result.ok } })
    return c.json({ probe: result, connection: publicConnection(getConnection(id)!) })
  })

  app.delete('/api/integrations/connections/:id', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteConnection(id, actorOf(c))) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })

  // --- OAuth connect flow (Google / Microsoft) ------------------------------
  // Mint a single-use state + return the provider authorize URL for the operator
  // to open. The connection's client_id/redirect_uri must already be saved.
  app.get('/api/integrations/oauth/:id/authorize', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    try {
      const url = createPendingAuthUrl(id)
      audit({ actor: actorOf(c), action: 'integration.oauth.authorize', entity: 'integration', entityId: id })
      return c.json({ url })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // The OAuth redirect target. UNAUTHENTICATED (a browser top-level redirect can
  // carry no session) — gated SOLELY by the single-use CSRF state.
  app.get('/api/integrations/oauth/callback', async (c) => {
    const code = c.req.query('code')
    const state = c.req.query('state')
    const oauthError = c.req.query('error')
    if (oauthError) return c.html(oauthHtml(`Verbindung abgebrochen: ${oauthError}`), 400)
    if (!code || !state) return c.html(oauthHtml('Fehlende Parameter.'), 400)
    try {
      const { connection_id, account_email } = await completeCallback(state, code)
      setStatus(connection_id, 'ok', account_email ? `Verbunden als ${account_email}` : 'Verbunden')
      audit({ actor: 'oauth', action: 'integration.oauth.connect', entity: 'integration', entityId: connection_id, detail: { account_email } })
      return c.html(oauthHtml(`Verbunden${account_email ? ' als ' + account_email : ''}. Du kannst dieses Fenster schließen.`))
    } catch (e) {
      return c.html(oauthHtml((e as Error).message), 400)
    }
  })

  app.post('/api/integrations/oauth/:id/disconnect', requireAdmin, (c) => {
    const id = Number(c.req.param('id'))
    disconnectOAuth(id)
    setStatus(id, 'unconfigured', null)
    audit({ actor: actorOf(c), action: 'integration.oauth.disconnect', entity: 'integration', entityId: id })
    return c.json({ ok: true })
  })

  // --- inbound provider webhook receiver (UNAUTHENTICATED, signature-gated) --
  app.post(
    '/api/integrations/webhooks/:provider',
    rateLimit({ windowMs: 60_000, max: 120 }),
    async (c) => {
      const provider = c.req.param('provider')
      const resolved = resolveActiveByProvider(provider)
      if (!resolved) return c.json({ error: 'Kein aktiver Anbieter.' }, 404)
      const { adapter, connection } = resolved
      if (adapter.category !== 'payment') {
        return c.json({ error: 'Webhook für diese Kategorie nicht unterstützt.' }, 400)
      }
      const pay = adapter as PaymentProvider

      // Read the RAW body BEFORE parsing — the signature is over these exact bytes.
      const rawBody = await c.req.text()
      if (rawBody.length > MAX_WEBHOOK_BODY) return c.json({ error: 'Body zu groß.' }, 413)
      const headers = c.req.header() as Record<string, string>

      // Fail closed: a bad/absent signature (incl. unset secret) is rejected.
      if (!pay.verifyWebhook(rawBody, headers)) {
        return c.json({ error: 'Signaturprüfung fehlgeschlagen.' }, 400)
      }

      // parseWebhook may be async + may hit the provider's API (e.g. GoCardless
      // fetches the paid amount). A transient failure there THROWS — return 502 so
      // nothing is persisted and the provider redelivers, rather than recording an
      // un-reconcilable event that dedup would then pin forever.
      let parsed: Awaited<ReturnType<PaymentProvider['parseWebhook']>>
      try {
        parsed = await pay.parseWebhook(rawBody)
      } catch {
        return c.json({ error: 'Webhook konnte nicht verarbeitet werden — bitte erneut zustellen.' }, 502)
      }
      // Idempotency key: the provider's event id, or a deterministic hash of the
      // raw body when it supplies none. SQLite treats NULL as DISTINCT in a UNIQUE
      // index, so a null id would silently bypass dedup and let a redelivered
      // partial-payment event double-apply — the hash fallback closes that.
      const externalId =
        parsed.external_id && parsed.external_id.trim()
          ? parsed.external_id
          : `sha256:${createHash('sha256').update(rawBody).digest('hex')}`

      // Idempotency: a replay (same provider + event id) is a no-op 200. Backed
      // by UNIQUE(provider, external_id); this fast pre-check skips the work and
      // the catch below still closes the concurrent-redelivery race.
      if (db.prepare('SELECT 1 FROM integration_events WHERE provider = ? AND external_id = ?').get(provider, externalId)) {
        return c.json({ ok: true, duplicate: true })
      }

      // Persist the event AND apply its side effect in ONE transaction. If the
      // side effect throws, the event row rolls back with it, so the provider's
      // retry re-runs cleanly. Otherwise a transient failure would leave a
      // processed=0 row that dedups every retry into a no-op 200 — permanently
      // losing a real paid-invoice event, since nothing reprocesses such rows.
      // Amounts are validated as positive integer cents, like the manual route.
      let outcome: { eventId: number; result: Record<string, unknown> }
      try {
        outcome = tx(() => {
          const ins = db
            .prepare(
              `INSERT INTO integration_events (category, provider, external_id, type, payload, signature_ok)
               VALUES (?, ?, ?, ?, ?, 1)`,
            )
            .run(connection.category, provider, externalId, parsed.type, rawBody)
          const eventId = Number(ins.lastInsertRowid)

          let result: Record<string, unknown> = { applied: false }
          if (parsed.paid && parsed.document_id) {
            const doc = getDocument(parsed.document_id)
            const amount = Math.round(Number(parsed.amount_cents))
            // The ledger is EUR-only (amounts are stored as bare EUR cents). Refuse
            // to record a payment reported in another currency at face value, which
            // would silently mis-state the books.
            const currencyOk = !parsed.currency || parsed.currency.toLowerCase() === 'eur'
            if (
              doc &&
              doc.kind === 'rechnung' &&
              doc.number &&
              doc.status !== 'bezahlt' &&
              doc.status !== 'storniert' &&
              currencyOk &&
              Number.isFinite(amount) &&
              amount > 0
            ) {
              const payment = addPayment(doc.id, {
                amount_cents: amount,
                paid_on: null,
                // Record which provider settled it (not always Stripe).
                method: PAYMENT_METHOD_LABEL[provider] ?? provider,
                note: `${provider} ${parsed.external_id ?? ''}`.trim(),
              })
              emit('payment.recorded', {
                document_id: doc.id,
                amount_cents: amount,
                paid_total_cents: paidCents(doc.id),
                source: provider,
              })
              result = { applied: true, payment_id: payment.id, document_id: doc.id }
            } else {
              result = { applied: false, reason: 'Rechnung nicht zahlbar, Währung ≠ EUR oder Betrag ungültig.' }
            }
          }
          db.prepare('UPDATE integration_events SET processed = 1, result = ? WHERE id = ?').run(
            JSON.stringify(result),
            eventId,
          )
          return { eventId, result }
        })
      } catch (e) {
        // A concurrent redelivery that slipped past the pre-check trips the UNIQUE
        // index — benign duplicate. Anything else is a genuine failure: let it 500
        // (the event row rolled back) so the provider retries and re-applies.
        if (/UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e))) {
          return c.json({ ok: true, duplicate: true })
        }
        throw e
      }

      audit({ actor: provider, action: 'integration.webhook', entity: 'integration_event', entityId: outcome.eventId, detail: { provider, type: parsed.type, external_id: externalId, ...outcome.result } })
      return c.json({ ok: true, ...outcome.result })
    },
  )
}
