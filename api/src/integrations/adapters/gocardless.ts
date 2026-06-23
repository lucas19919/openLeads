import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type {
  ConfigFieldSchema,
  IntegrationContext,
  ParsedPaymentEvent,
  PaymentLink,
  PaymentProvider,
  ProbeResult,
  ProviderDefinition,
  ResolvedConnection,
} from '../types'

// GoCardless SEPA payment adapter — fetch only, no SDK (dependency-light). The
// base hosts are HARDCODED literals: the access token must never be sent to an
// operator-supplied host, so config may only SELECT between the two known hosts
// (live/sandbox), never override them (credential-exfiltration guard).
//
// We use the Billing Request + Billing Request Flow flow: a billing request
// carries the payment intent (amount in cents, EUR, document metadata) and a
// billing request flow yields the hosted `authorisation_url` we hand the payer.
//
// verifyWebhook/parseWebhook are PURE (no network). GoCardless signs webhooks
// with a plain HMAC-SHA256 hex digest of the RAW body keyed by the endpoint
// secret in the `Webhook-Signature` header (no timestamp scheme). verifyGcSignature
// and mapGcEvent are exported so they are unit-tested offline with no network.

// HARDCODED hosts — config.environment only SELECTS one of these, never overrides.
const GC_LIVE = 'https://api.gocardless.com'
const GC_SANDBOX = 'https://api-sandbox.gocardless.com'
const GC_VERSION = '2015-07-06'
const TIMEOUT_MS = 12_000

const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  { key: 'access_token', label: 'GoCardless Access Token', type: 'string', secret: true, required: true, placeholder: 'live_... / sandbox_...' },
  { key: 'webhook_secret', label: 'Webhook Signing Secret', type: 'string', secret: true },
  {
    key: 'environment',
    label: 'Umgebung',
    type: 'select',
    options: [
      { value: 'live', label: 'Live (Produktiv)' },
      { value: 'sandbox', label: 'Sandbox (Test)' },
    ],
    placeholder: 'live',
  },
  { key: 'success_redirect_url', label: 'Erfolgs-URL (nach Zahlung)', type: 'string', required: true, placeholder: 'https://...' },
  { key: 'exit_redirect_url', label: 'Abbruch-URL', type: 'string', placeholder: 'https://...' },
]

/**
 * Verify a GoCardless `Webhook-Signature` header against the RAW body bytes.
 * GoCardless computes HMAC-SHA256(webhook_secret, rawBody) as a lowercase hex
 * digest with NO timestamp component. Fails closed: an unset secret, a missing
 * header, a length mismatch, or a non-matching HMAC all return false. The
 * comparison is constant-time over equal-length buffers (node:crypto).
 */
export function verifyGcSignature(
  secret: string | null | undefined,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  if (!secret || !header) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const a = Buffer.from(header.trim(), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

interface GcEvent {
  id?: string
  resource_type?: string
  action?: string
  links?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

/**
 * Pure mapper from a GoCardless webhook body to our normalised payment event.
 * The body is `{ events: [{ id, resource_type, action, links, metadata }] }`.
 * We map the FIRST event. A payment counts as paid when a `payments` resource
 * transitions to the `confirmed` action.
 */
export function mapGcEvent(body: unknown): ParsedPaymentEvent {
  const events = (body as { events?: unknown })?.events
  const event: GcEvent = Array.isArray(events) && events.length > 0 ? (events[0] as GcEvent) : {}
  const resourceType = event.resource_type ?? 'unknown'
  const action = event.action ?? 'unknown'
  const docRaw = event.metadata?.document_id
  const docId = docRaw != null ? Number(docRaw) : NaN
  return {
    external_id: event.id ?? null,
    type: `${resourceType}.${action}`,
    paid: resourceType === 'payments' && action === 'confirmed',
    document_id: Number.isFinite(docId) ? docId : null,
  }
}

class GoCardlessAdapter implements PaymentProvider {
  readonly category = 'payment' as const
  readonly provider = 'gocardless'
  private readonly accessToken: string
  private readonly webhookSecret: string
  private readonly base: string
  private readonly successRedirectUrl: string
  private readonly exitRedirectUrl: string

  constructor(conn: ResolvedConnection) {
    this.accessToken = conn.secrets.access_token ?? ''
    this.webhookSecret = conn.secrets.webhook_secret ?? ''
    // environment ONLY selects between the two hardcoded hosts (default: live).
    this.base = String(conn.config.environment ?? 'live') === 'sandbox' ? GC_SANDBOX : GC_LIVE
    this.successRedirectUrl = String(conn.config.success_redirect_url ?? '')
    this.exitRedirectUrl = String(conn.config.exit_redirect_url ?? this.successRedirectUrl)
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!this.accessToken) throw new Error('GoCardless: Access Token nicht konfiguriert.')
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.accessToken}`,
      'GoCardless-Version': GC_VERSION,
    }
    if (method === 'POST') {
      headers['content-type'] = 'application/json'
      // Idempotency-Key guards against duplicate object creation on retries.
      headers['Idempotency-Key'] = randomBytes(16).toString('hex')
    }
    let res: Response
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('GoCardless ist nicht erreichbar.')
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
    }
    if (!res.ok) throw new Error(`GoCardless-Fehler: ${json?.error?.message ?? res.status}`)
    return json
  }

  async probe(): Promise<ProbeResult> {
    if (!this.accessToken) return { ok: false, detail: 'Access Token nicht konfiguriert.' }
    try {
      await this.call('GET', '/creditors')
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  async createPaymentLink(
    input: {
      amount_cents: number
      currency: string
      description?: string
      document_id?: number
      customer_email?: string | null
    },
    _ctx: IntegrationContext,
  ): Promise<PaymentLink> {
    if (!this.successRedirectUrl) {
      throw new Error('GoCardless: Erfolgs-URL (success_redirect_url) nicht konfiguriert.')
    }
    if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) {
      throw new Error('Betrag (Cent) muss eine positive Ganzzahl sein.')
    }
    const currency = (input.currency || 'EUR').toUpperCase()

    // 1) Create the billing request carrying the payment intent.
    const metadata: Record<string, string> = {}
    if (input.document_id != null) metadata.document_id = String(input.document_id)
    const br = (await this.call('POST', '/billing_requests', {
      billing_requests: {
        payment_request: {
          description: input.description || 'Rechnung',
          amount: input.amount_cents,
          currency,
          ...(input.document_id != null ? { metadata } : {}),
        },
      },
    })) as { billing_requests?: { id?: string; status?: string } }
    const brId = br.billing_requests?.id
    if (!brId) throw new Error('GoCardless: Billing Request konnte nicht erstellt werden.')

    // 2) Create the hosted flow and return its authorisation_url to the payer.
    const flow = (await this.call('POST', '/billing_request_flows', {
      billing_request_flows: {
        redirect_uri: this.successRedirectUrl,
        exit_uri: this.exitRedirectUrl || this.successRedirectUrl,
        links: { billing_request: brId },
      },
    })) as { billing_request_flows?: { authorisation_url?: string } }
    const url = flow.billing_request_flows?.authorisation_url
    if (!url) throw new Error('GoCardless: Zahlungslink (authorisation_url) fehlt in der Antwort.')

    return {
      id: brId,
      url,
      amount_cents: input.amount_cents,
      currency,
      status: br.billing_requests?.status ?? 'pending',
    }
  }

  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean {
    const header = headers['webhook-signature'] ?? headers['Webhook-Signature']
    return verifyGcSignature(this.webhookSecret, rawBody, header)
  }

  async parseWebhook(rawBody: string): Promise<ParsedPaymentEvent> {
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return { external_id: null, type: 'unparseable' }
    }
    const parsed = mapGcEvent(body)

    // GoCardless webhooks reference the payment by link id but do NOT inline the
    // amount, so a confirmed payment can't be reconciled from the body alone. Fetch
    // the payment to fill amount_cents + currency. `call()` throws on a transient
    // failure, which propagates so the receiver lets GoCardless retry rather than
    // recording an un-reconcilable (NaN-amount) event that dedup would then pin.
    if (parsed.paid && parsed.document_id != null) {
      const paymentId = gcPaymentId(body)
      if (paymentId) {
        const r = (await this.call('GET', `/payments/${encodeURIComponent(paymentId)}`)) as {
          payments?: { amount?: number; currency?: string }
        }
        const amount = Number(r.payments?.amount)
        // GoCardless `amount` is already in the minor unit (cents for EUR).
        if (Number.isFinite(amount) && amount > 0) parsed.amount_cents = amount
        if (typeof r.payments?.currency === 'string') parsed.currency = r.payments.currency
      }
    }
    return parsed
  }
}

/** The `links.payment` id of a webhook's first event, if any. Pure. */
function gcPaymentId(body: unknown): string | null {
  const events = (body as { events?: GcEvent[] })?.events
  const link = Array.isArray(events) && events.length > 0 ? events[0]?.links?.payment : undefined
  return typeof link === 'string' && link ? link : null
}

export const gocardlessDefinition: ProviderDefinition<PaymentProvider> = {
  category: 'payment',
  provider: 'gocardless',
  label: 'GoCardless (SEPA-Lastschrift)',
  configSchema: CONFIG_SCHEMA,
  build: (conn) => new GoCardlessAdapter(conn),
}
