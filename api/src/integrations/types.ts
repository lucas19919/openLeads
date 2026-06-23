import type { FullDocument } from '../documents'

// Per-CATEGORY adapter interfaces for the integrations module.
//
// The contract mirrors the codebase's idioms: small methods, German user-facing
// error strings thrown as Error, money in integer cents, and third-party
// credentials handled only as decrypted-at-call-time values (never persisted
// plaintext). Every adapter is built from a ResolvedConnection by its
// ProviderDefinition.build(). Network calls use global fetch with an
// AbortSignal timeout — no SDKs (dependency-light rule).
//
// To add an integration: implement a ProviderDefinition, declare its
// configSchema, and register() it in integrations/index.ts. Secret fields
// (secret: true) are stored encrypted; the rest land in the plaintext config.

export type IntegrationCategory =
  | 'payment'
  | 'accounting'
  | 'mail'
  | 'enrichment'
  | 'calendar'
  | 'telephony'

// A single config/credential field the registry advertises so the UI can render
// a form. `secret: true` fields go to credentials_enc and are never returned.
export interface ConfigFieldSchema {
  key: string
  label: string // German label for the Settings UI
  type: 'string' | 'number' | 'boolean' | 'select'
  secret?: boolean // true => credentials_enc, never returned
  required?: boolean
  options?: { value: string; label: string }[] // for type 'select'
  placeholder?: string
}

// What a configured connection resolves to at call time. `config` is the parsed
// plaintext JSON; `secrets` is the parsed decrypted credential JSON (or {}).
export interface ResolvedConnection {
  id: number
  category: IntegrationCategory
  provider: string
  label: string | null
  config: Record<string, unknown>
  secrets: Record<string, string>
}

// Per-call context so adapters can identify the actor for audit() without
// importing the request layer. `actor` matches audit()'s convention.
export interface IntegrationContext {
  actor: string | null
  ip?: string | null
}

// Uniform result for a connection self-test (drives the status badge).
export interface ProbeResult {
  ok: boolean
  detail?: string // German message
}

// Base: every adapter can self-test.
export interface IntegrationAdapter {
  readonly category: IntegrationCategory
  readonly provider: string
  /** Cheap reachability/credential check for the status badge. */
  probe(): Promise<ProbeResult>
}

// --- payment ----------------------------------------------------------------
// Money in integer cents (matches documents/payments). Currency ISO-4217.
export interface PaymentLink {
  id: string // provider's object id
  url: string // hosted checkout/payment URL to hand the customer
  amount_cents: number
  currency: string
  status: string
}

/** A normalised inbound payment event, parsed from a verified provider webhook. */
export interface ParsedPaymentEvent {
  external_id: string | null // provider event id (idempotency)
  type: string
  amount_cents?: number
  currency?: string
  document_id?: number | null
  paid?: boolean
}

export interface PaymentProvider extends IntegrationAdapter {
  readonly category: 'payment'
  /** Create a hosted payment/checkout for an invoice amount. */
  createPaymentLink(
    input: {
      amount_cents: number
      currency: string
      description?: string
      document_id?: number // OpenLeads documents.id for reconciliation
      customer_email?: string | null
    },
    ctx: IntegrationContext,
  ): Promise<PaymentLink>
  /** Verify an inbound webhook signature against the RAW body bytes. */
  verifyWebhook(rawBody: string, headers: Record<string, string>): boolean
  /**
   * Parse a (verified) webhook into a normalised event for the receiver. May be
   * async: some providers (e.g. GoCardless) don't inline the paid amount in the
   * webhook and must fetch it from their API before the event can be reconciled.
   * Such a fetch should THROW on a transient failure so the receiver lets the
   * provider retry rather than persisting an un-reconcilable event.
   */
  parseWebhook(rawBody: string): ParsedPaymentEvent | Promise<ParsedPaymentEvent>
}

// --- accounting / tax-id ----------------------------------------------------
export interface VatValidation {
  valid: boolean
  country_code: string
  vat_number: string
  name?: string | null
  address?: string | null
}

export interface AccountingProvider extends IntegrationAdapter {
  readonly category: 'accounting'
  /** Validate an EU VAT id (e.g. via VIES). Throws Error (German) on transport failure. */
  validateVatId(
    countryCode: string,
    vatNumber: string,
    ctx: IntegrationContext,
  ): Promise<VatValidation>
  /**
   * Push a finalised invoice to the accounting system (lexoffice/sevDesk).
   * Optional — VIES doesn't implement it. Returns the provider's record id/url.
   * `FullDocument` is a type-only import (erased at build → no runtime cycle).
   */
  pushInvoice?(doc: FullDocument, ctx: IntegrationContext): Promise<{ external_id: string; url?: string }>
}

// --- mail -------------------------------------------------------------------
// The existing SMTP mailer is wrapped to satisfy this so it unifies under the
// interface without changing its call sites or its UWG §7 / Art. 21 gates.
export interface MailProvider extends IntegrationAdapter {
  readonly category: 'mail'
  send(
    msg: { to: string; from: string; subject: string; text: string },
    ctx: IntegrationContext,
  ): Promise<{ messageId: string }>
}

// --- enrichment -------------------------------------------------------------
export interface EnrichmentResult {
  company?: string | null
  website?: string | null
  phone?: string | null
  email?: string | null
  extra?: Record<string, unknown>
}

export interface EnrichmentProvider extends IntegrationAdapter {
  readonly category: 'enrichment'
  enrichByDomain(domain: string, ctx: IntegrationContext): Promise<EnrichmentResult>
}

// --- calendar ---------------------------------------------------------------
export interface CalendarEvent {
  id: string
  title: string
  start: string // ISO 8601
  end: string // ISO 8601
  url?: string | null
}

export interface CalendarProvider extends IntegrationAdapter {
  readonly category: 'calendar'
  createEvent(
    input: { title: string; start: string; end: string; description?: string; attendees?: string[] },
    ctx: IntegrationContext,
  ): Promise<CalendarEvent>
}

// --- telephony --------------------------------------------------------------
export interface TelephonyProvider extends IntegrationAdapter {
  readonly category: 'telephony'
  /** Initiate a click-to-call. Returns the provider's call id. */
  startCall(input: { to: string; from?: string }, ctx: IntegrationContext): Promise<{ call_id: string }>
}

export type AnyAdapter =
  | PaymentProvider
  | AccountingProvider
  | MailProvider
  | EnrichmentProvider
  | CalendarProvider
  | TelephonyProvider

// A provider definition the registry advertises + can build from a connection.
export interface ProviderDefinition<A extends AnyAdapter = AnyAdapter> {
  category: IntegrationCategory
  provider: string // registry id, unique within category
  label: string // German display name
  configSchema: ConfigFieldSchema[]
  /** Construct the live adapter from a decrypted connection. */
  build(conn: ResolvedConnection): A
}
