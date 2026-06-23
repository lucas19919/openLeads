import { createHash } from 'node:crypto'
import type {
  AccountingProvider,
  ConfigFieldSchema,
  IntegrationContext,
  ProbeResult,
  ProviderDefinition,
  ResolvedConnection,
  VatValidation,
} from '../types'
import type { FullDocument } from '../../documents'

/** A stable, UUID-shaped idempotency key for an invoice push (derived from the
 *  document id, so retries reuse it). lexoffice recommends a v4 UUID; this is
 *  UUID-shaped and deterministic, which is what idempotent retries need. Exported
 *  for the unit test. */
export function lexofficeIdempotencyKey(documentId: number): string {
  const h = createHash('sha1').update(`openleads-invoice-${documentId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// lexoffice (Lexware Office) accounting adapter — fetch only, no SDK
// (dependency-light). The base host is HARDCODED to api.lexoffice.io: the API
// key must never be sent to an operator-supplied host (credential-exfiltration
// guard), so unlike the AI base_url this is not configurable.
//
// This provider does NOT validate VAT ids — lexoffice exposes no USt-IdNr.
// checking endpoint, so validateVatId() throws a German hint pointing the
// operator at the VIES adapter instead. Its real value is pushInvoice(), which
// maps a (flat) FullDocument into lexoffice's invoice JSON.
//
// mapDocToLexoffice() is PURE (no network): it is unit-tested offline by feeding
// a canned FullDocument and asserting netAmount === cents/100 and the
// taxRatePercentage / taxType (19% standard vs 0% + §19 Kleinunternehmer).
//
// HOST: the API gateway moved to https://api.lexware.io on 2025-05-26, and the
// legacy api.lexoffice.io host was sunset at the end of 2025 — so we target the
// current host. Same Public API: identical /v1/... paths and Bearer-token auth,
// only the hostname changed. HARDCODED (never operator-supplied): the API key
// must never be sent to an arbitrary host (credential-exfiltration guard).

const LEXOFFICE_BASE = 'https://api.lexware.io'
const TIMEOUT_MS = 12_000

const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  {
    key: 'api_key',
    label: 'lexoffice API-Schlüssel',
    type: 'string',
    secret: true,
    required: true,
    placeholder: 'lxo_...',
  },
]

// --- lexoffice request shapes (subset we send) ------------------------------
interface LexUnitPrice {
  currency: 'EUR'
  netAmount: number // EUR (decimal), NOT cents
  taxRatePercentage: number
}
interface LexLineItem {
  type: 'custom'
  name: string
  quantity: number
  unitName: string
  unitPrice: LexUnitPrice
}
export interface LexInvoiceRequest {
  voucherDate: string
  address: {
    name: string
    street?: string
    zip?: string
    city?: string
    countryCode: string
  }
  lineItems: LexLineItem[]
  totalPrice: { currency: 'EUR' }
  taxConditions: { taxType: 'net' | 'vatfree' }
  remark?: string
}

/** Cents → EUR decimal (e.g. 1999 → 19.99), rounded to 2 dp to avoid float drift. */
function centsToEur(cents: number): number {
  return Math.round(cents) / 100
}

/**
 * Pure mapper: a (FLAT) FullDocument → lexoffice POST /v1/invoices body.
 *
 * - voucherDate    = doc.issue_date (falls back to today if a draft has none)
 * - address.name   = doc.client_name (+ street/zip/city, countryCode 'DE')
 * - lineItems      = doc.items, unitPrice.netAmount in EUR (cents / 100)
 * - Kleinunternehmer (§19, doc.small_business): taxType 'vatfree', 0% per line,
 *   and a §19 remark. Otherwise taxType 'net' with doc.vat_rate (e.g. 19).
 *
 * No network — unit-testable offline.
 */
export function mapDocToLexoffice(doc: FullDocument): LexInvoiceRequest {
  const smallBusiness = !!doc.small_business
  const taxRate = smallBusiness ? 0 : doc.vat_rate
  const voucherDate = doc.issue_date ?? new Date().toISOString().slice(0, 10)

  const lineItems: LexLineItem[] = doc.items.map((it) => ({
    type: 'custom',
    name: it.description ?? '',
    quantity: it.quantity,
    unitName: it.unit ?? 'Stück',
    unitPrice: {
      currency: 'EUR',
      netAmount: centsToEur(it.unit_price_cents),
      taxRatePercentage: taxRate,
    },
  }))

  const req: LexInvoiceRequest = {
    voucherDate,
    address: {
      name: doc.client_name ?? '',
      ...(doc.client_address ? { street: doc.client_address } : {}),
      ...(doc.client_zip ? { zip: doc.client_zip } : {}),
      ...(doc.client_city ? { city: doc.client_city } : {}),
      countryCode: 'DE',
    },
    lineItems,
    totalPrice: { currency: 'EUR' },
    // ASSUMPTION: lexoffice uses taxType 'vatfree' for tax-exempt invoices; we
    // map Kleinunternehmer (§19 UStG) onto it and add the mandatory §19 note.
    taxConditions: { taxType: smallBusiness ? 'vatfree' : 'net' },
  }
  if (smallBusiness) {
    req.remark =
      'Gemäß § 19 UStG (Kleinunternehmer) wird keine Umsatzsteuer berechnet.'
  }
  return req
}

interface PushResult {
  external_id: string
  url: string
}

class LexofficeAdapter implements AccountingProvider {
  readonly category = 'accounting' as const
  readonly provider = 'lexoffice'
  private readonly apiKey: string

  constructor(conn: ResolvedConnection) {
    this.apiKey = conn.secrets.api_key ?? ''
  }

  private async call(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    if (!this.apiKey) throw new Error('lexoffice: API-Schlüssel nicht konfiguriert.')
    let res: Response
    try {
      res = await fetch(`${LEXOFFICE_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          // lexoffice dedups POSTs carrying the same Idempotency-Key (~24h window),
          // so a retried push after a timeout returns the SAME invoice instead of
          // creating a duplicate.
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('lexoffice ist nicht erreichbar.')
    }
    const json = (await res.json().catch(() => ({}))) as {
      message?: string
      error_description?: string
      IssueList?: { i18nKey?: string; source?: string }[]
    }
    if (!res.ok) {
      const detail =
        json?.message ??
        json?.error_description ??
        json?.IssueList?.[0]?.i18nKey ??
        String(res.status)
      throw new Error(`lexoffice-Fehler: ${detail}`)
    }
    return json
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiKey) return { ok: false, detail: 'API-Schlüssel nicht konfiguriert.' }
    try {
      await this.call('/v1/profile', 'GET')
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  // lexoffice has no USt-IdNr. validation endpoint — fail with a German hint.
  async validateVatId(
    _countryCode: string,
    _vatNumber: string,
    _ctx: IntegrationContext,
  ): Promise<VatValidation> {
    throw new Error(
      'USt-IdNr.-Prüfung über lexoffice nicht verfügbar — bitte VIES aktivieren.',
    )
  }

  /** Push a finalised invoice document to lexoffice. Returns its id + viewer URL. */
  async pushInvoice(doc: FullDocument, _ctx: IntegrationContext): Promise<PushResult> {
    if (!doc.client_name) throw new Error('lexoffice: Empfängername (client_name) fehlt.')
    if (!doc.items.length) throw new Error('lexoffice: Rechnung enthält keine Positionen.')
    const body = mapDocToLexoffice(doc)
    // Stable per-invoice idempotency key (UUID-shaped, derived from the document
    // id) so a retried push dedups at lexoffice instead of double-booking.
    const res = (await this.call('/v1/invoices?finalize=true', 'POST', body, lexofficeIdempotencyKey(doc.id))) as {
      id?: string
      resourceUri?: string
    }
    if (!res.id) throw new Error('lexoffice: Antwort ohne Rechnungs-ID.')
    return {
      external_id: res.id,
      // resourceUri is the API location; the operator-facing viewer lives under
      // the lexoffice app at /permalink/invoices/view/<id>.
      url: res.resourceUri ?? `https://app.lexoffice.de/permalink/invoices/view/${res.id}`,
    }
  }
}

export const lexofficeDefinition: ProviderDefinition<AccountingProvider> = {
  category: 'accounting',
  provider: 'lexoffice',
  label: 'lexoffice (Buchhaltung)',
  configSchema: CONFIG_SCHEMA,
  build: (conn) => new LexofficeAdapter(conn),
}
