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

// sevDesk accounting adapter — fetch only, no SDK (dependency-light). The base
// host is HARDCODED to my.sevdesk.de: the api_token must never be sent to an
// operator-supplied host (credential-exfiltration guard), so unlike the AI
// base_url this is not configurable.
//
// sevDesk authenticates with the RAW token in the Authorization header — NOT
// `Bearer <token>` (their auto-generated OpenAPI/PHP clients show "Bearer", but
// the official sevDesk docs and live API expect the bare token). VAT-id
// validation is deliberately unsupported here: sevDesk has no VIES proxy, so we
// throw a German hint pointing the operator at the VIES adapter.
//
// mapDocToSevdesk is PURE (no network) so the cents->euro conversion and the
// §19 (Kleinunternehmer) tax-rate logic are unit-tested offline with no fetch.

const SEVDESK_BASE = 'https://my.sevdesk.de/api/v1'
const TIMEOUT_MS = 12_000

const CONFIG_SCHEMA: ConfigFieldSchema[] = [
  { key: 'api_token', label: 'sevDesk API-Token', type: 'string', secret: true, required: true, placeholder: '32-stelliger Token' },
  // NOTE: a single contact for ALL pushed invoices. Per-client contact mapping
  // would need the sevDesk Contact API (create/lookup) — a roadmap item; until
  // then the label makes the limitation explicit rather than silently misfiling.
  { key: 'contact_id', label: 'sevDesk Kontakt-ID — Sammelkontakt für ALLE Übergaben', type: 'string', required: true, placeholder: 'z. B. 1000001' },
  { key: 'default_unity_id', label: 'Standard-Einheit-ID (Unity, optional)', type: 'string', placeholder: 'Standard: 1 (Stück)' },
]

/** Options the pure mapper needs from the resolved connection config. */
export interface SevdeskMapOptions {
  contactId: string
  defaultUnityId?: string | number
}

/** The sevDesk saveInvoice request body shape (only the fields we set). */
export interface SevdeskInvoicePayload {
  invoice: {
    contact: { id: string | number; objectName: 'Contact' }
    invoiceDate: string
    header: string
    status: number
  }
  invoicePosSave: {
    quantity: number
    price: number
    name: string
    taxRate: number
    unity: { id: string | number; objectName: 'Unity' }
  }[]
}

/**
 * PURE mapper: a FLAT FullDocument -> the sevDesk saveInvoice payload.
 *
 * - price is EUROS, not cents: unit_price_cents / 100 (sevDesk expects decimal).
 * - taxRate is doc.vat_rate (e.g. 19), or 0 for Kleinunternehmer (§19 UStG).
 * - unity defaults to 1 (Stück) when no default_unity_id is configured.
 *
 * Offline-testable: assert price === cents / 100 and taxRate 19 / 0.
 */
export function mapDocToSevdesk(doc: FullDocument, opts: SevdeskMapOptions): SevdeskInvoicePayload {
  const smallBusiness = !!doc.small_business
  const taxRate = smallBusiness ? 0 : doc.vat_rate
  const unityId = opts.defaultUnityId != null && opts.defaultUnityId !== '' ? opts.defaultUnityId : 1
  return {
    invoice: {
      contact: { id: opts.contactId, objectName: 'Contact' },
      invoiceDate: doc.issue_date ?? new Date().toISOString().slice(0, 10),
      header: doc.title ?? doc.number ?? 'Rechnung',
      status: 100,
    },
    invoicePosSave: doc.items.map((it) => ({
      quantity: it.quantity,
      price: it.unit_price_cents / 100,
      name: it.description ?? '',
      taxRate,
      unity: { id: unityId, objectName: 'Unity' },
    })),
  }
}

class SevdeskAdapter implements AccountingProvider {
  readonly category = 'accounting' as const
  readonly provider = 'sevdesk'
  private readonly apiToken: string
  private readonly contactId: string
  private readonly defaultUnityId: string

  constructor(conn: ResolvedConnection) {
    this.apiToken = conn.secrets.api_token ?? ''
    this.contactId = String(conn.config.contact_id ?? '')
    this.defaultUnityId = String(conn.config.default_unity_id ?? '')
  }

  private async call(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    if (!this.apiToken) throw new Error('sevDesk: API-Token nicht konfiguriert.')
    let res: Response
    try {
      res = await fetch(`${SEVDESK_BASE}${path}`, {
        method,
        headers: {
          // RAW token — NOT `Bearer <token>` (sevDesk-specific auth scheme).
          authorization: this.apiToken,
          accept: 'application/json',
          ...(body != null ? { 'content-type': 'application/json' } : {}),
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('sevDesk ist nicht erreichbar.')
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string }
      message?: string
    }
    if (!res.ok) {
      const detail = json?.error?.message ?? json?.message ?? res.status
      throw new Error(`sevDesk-Fehler: ${detail}`)
    }
    return json
  }

  async probe(): Promise<ProbeResult> {
    if (!this.apiToken) return { ok: false, detail: 'API-Token nicht konfiguriert.' }
    try {
      // /SevUser returns the current user (200) — a cheap auth check.
      await this.call('/SevUser', 'GET')
      return { ok: true }
    } catch (e) {
      return { ok: false, detail: (e as Error).message }
    }
  }

  // sevDesk has no VIES proxy; VAT-id checks go through the dedicated VIES adapter.
  async validateVatId(
    _countryCode: string,
    _vatNumber: string,
    _ctx: IntegrationContext,
  ): Promise<VatValidation> {
    throw new Error('USt-IdNr.-Prüfung über sevDesk nicht verfügbar — bitte VIES aktivieren.')
  }

  async pushInvoice(
    doc: FullDocument,
    _ctx: IntegrationContext,
  ): Promise<{ external_id: string; url?: string }> {
    if (!this.contactId) throw new Error('sevDesk: Kontakt-ID (contact_id) nicht konfiguriert.')
    const payload = mapDocToSevdesk(doc, {
      contactId: this.contactId,
      defaultUnityId: this.defaultUnityId,
    })
    const json = (await this.call('/Invoice/Factory/saveInvoice', 'POST', payload)) as {
      objects?: { invoice?: { id?: string | number } }
    }
    const id = json?.objects?.invoice?.id
    if (id == null) throw new Error('sevDesk: Rechnung konnte nicht angelegt werden.')
    return { external_id: String(id) }
  }
}

export const sevdeskDefinition: ProviderDefinition<AccountingProvider> = {
  category: 'accounting',
  provider: 'sevdesk',
  label: 'sevDesk (Buchhaltung)',
  configSchema: CONFIG_SCHEMA,
  build: (conn) => new SevdeskAdapter(conn),
}
