export interface Lead {
  id: number
  domain: string | null
  company: string | null
  trade: string | null
  city: string | null
  website: string | null
  phone: string | null
  email: string | null
  mobile_friendly: number | null
  tech: string | null
  staleness_signal: string | null
  score: number
  priority: string
  why_lead: string | null
  stage: string
  notes: string | null
  assigned_to: string | null
  tags: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface LeadEvent {
  id: number
  lead_id: number
  at: string
  actor: string | null
  type: string
  from_stage: string | null
  to_stage: string | null
  body: string | null
}

export interface ExpenseCategoryDef {
  id: string
  label: string
  skr03: string
}

export interface ContractTypeDef {
  id: string
  label: string
}

export interface Config {
  stages: string[]
  priorities: string[]
  docKinds: string[]
  docStatuses: Record<string, string[]>
  clientTypes: string[]
  roles: string[]
  cadences: string[]
  expenseCategories: ExpenseCategoryDef[]
  paymentMethods: string[]
  contractTypes: ContractTypeDef[]
  contractStatuses: string[]
}

export interface Settings {
  id: number
  business_name: string | null
  owner: string | null
  address: string | null
  zip: string | null
  city: string | null
  email: string | null
  phone: string | null
  website: string | null
  tax_id: string | null
  iban: string | null
  bic: string | null
  bank: string | null
  small_business: number
  vat_rate: number
  payment_terms: number
  rechnung_prefix: string
  rechnung_next: number
  angebot_prefix: string
  angebot_next: number
  scraper_trades: string | null
  scraper_towns: string | null
  scraper_region: string | null
  scraper_min_score: number | null
  scraper_max_pairs: number | null
  scraper_per_pair: number | null
  verzug_base_rate?: number
  datev_revenue_account?: string | null
  datev_debitor_account?: string | null
  datev_bank_account?: string | null
  // Connection config (overrides .env). Secrets are write-only: the API never
  // returns the key/password, only whether one is stored.
  ai_base_url?: string | null
  ai_model?: string | null
  ai_label?: string | null
  smtp_host?: string | null
  smtp_port?: number | null
  smtp_user?: string | null
  smtp_secure?: number | null
  smtp_from?: string | null
  scraper_model?: string | null
  ai_api_key_set?: boolean
  smtp_pass_set?: boolean
  scraper_ai_api_key_set?: boolean
  settings_key_configured?: boolean
  // Verträge / AGB
  agb_text?: string | null
  contract_prefix?: string
  contract_next?: number
  agb_attach_documents?: number
  // Zeiterfassung
  default_hourly_rate_cents?: number
}

export interface ScraperConfig {
  trades: string[]
  towns: string[]
  region: string
  min_score: number
  max_pairs: number
  per_pair: number
  using_defaults: { trades: boolean; towns: boolean; region: boolean }
}

export interface ScrapeResult {
  ok: boolean
  detail: string
  posted?: number
  deduped?: number
  skipped?: number
  dry: boolean
}

export interface ScrapeRun {
  running: boolean
  dry: boolean
  started_at: string | null
  finished_at: string | null
  last: ScrapeResult | null
}

export interface ScraperStatus {
  total: number
  scraped: number
  last: string | null
  today: number
  byStage: { stage: string; n: number }[]
  recent: {
    id: number
    company: string | null
    trade: string | null
    city: string | null
    score: number
    priority: string
    created_at: string
  }[]
  run: ScrapeRun
  reachable: boolean
  service_token_configured: boolean
}

export interface DocItem {
  id?: number
  document_id?: number
  description: string | null
  quantity: number
  unit: string | null
  unit_price_cents: number
  sort?: number
}

export interface DocTotals {
  net_cents: number
  vat_cents: number
  gross_cents: number
}

export interface Doc {
  id: number
  kind: string
  number: string | null
  lead_id: number | null
  customer_id?: number | null
  client_name: string | null
  client_address: string | null
  client_zip: string | null
  client_city: string | null
  client_email: string | null
  title: string | null
  intro: string | null
  notes: string | null
  status: string
  issue_date: string | null
  due_date: string | null
  small_business: number
  vat_rate: number
  buyer_reference?: string | null
  client_type: string
  client_vat_id?: string | null
  include_payment_link?: number
  accounting_provider?: string | null
  accounting_external_id?: string | null
  accounting_pushed_at?: string | null
  created_at: string
  updated_at: string
  items: DocItem[]
  totals: DocTotals
  paid_cents: number
}

export interface Payment {
  id: number
  document_id: number
  amount_cents: number
  paid_on: string
  method: string | null
  note: string | null
  created_at: string
}

export interface PaymentSummary {
  payments: Payment[]
  gross_cents: number
  paid_cents: number
  outstanding_cents: number
}

export interface RecurringInvoice {
  id: number
  client_name: string | null
  client_address: string | null
  client_zip: string | null
  client_city: string | null
  client_email: string | null
  client_type: string
  lead_id: number | null
  customer_id?: number | null
  title: string | null
  intro: string | null
  notes: string | null
  items: string // JSON of DocItem-shaped objects
  small_business: number
  vat_rate: number
  cadence: string
  next_run: string
  active: number
  include_payment_link: number
  last_run: string | null
  created_at: string
  updated_at: string
}

export interface Customer {
  id: number
  name: string
  contact_name: string | null
  address: string | null
  zip: string | null
  city: string | null
  email: string | null
  phone: string | null
  vat_id: string | null
  client_type: string
  payment_terms: number | null
  lead_id: number | null
  notes: string | null
  active: number
  created_at: string
  updated_at: string
}

export interface EuerCategoryLine {
  category: string
  label: string
  skr03: string
  count: number
  net_cents: number
  vat_cents: number
  gross_cents: number
}

export interface EuerReport {
  from: string | null
  to: string | null
  revenue: { net_cents: number; vat_cents: number; gross_cents: number; count: number }
  expenses: {
    net_cents: number
    vat_cents: number
    gross_cents: number
    count: number
    by_category: EuerCategoryLine[]
  }
  result_net_cents: number
  vat: { collected_cents: number; input_cents: number; payable_cents: number }
  small_business: boolean
}

export interface CustomerDocLine {
  id: number
  kind: string
  number: string | null
  status: string
  issue_date: string | null
  gross_cents: number
  paid_cents: number
  open_cents: number
}

export interface CustomerContractLine {
  id: number
  number: string | null
  type: string
  status: string
  value_cents: number
  end_date: string | null
}

export interface CustomerRecurringLine {
  id: number
  title: string | null
  cadence: string
  next_run: string
  active: number
}

export interface CustomerOverview {
  customer: Customer
  documents: CustomerDocLine[]
  contracts: CustomerContractLine[]
  recurring: CustomerRecurringLine[]
  totals: {
    invoiced_gross_cents: number
    paid_cents: number
    open_cents: number
    quotes: number
    contracts_active: number
  }
}

export interface CatalogItem {
  id: number
  name: string
  description: string | null
  unit: string | null
  unit_price_cents: number
  vat_rate: number
  sku: string | null
  category: string | null
  active: number
  sort: number
  notes: string | null
  created_at: string
  updated_at: string
}

export interface TimeEntry {
  id: number
  lead_id: number | null
  catalog_item_id: number | null
  document_id: number | null
  entry_date: string
  description: string | null
  minutes: number
  rate_cents: number
  billable: number
  invoiced_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  amount_cents: number
}

export interface TimeSummary {
  count: number
  minutes: number
  billable_minutes: number
  amount_cents: number
  uninvoiced_amount_cents: number
}

export interface ContractTotals {
  net_cents: number
  vat_cents: number
  gross_cents: number
}

export interface Contract {
  id: number
  number: string | null
  type: string
  lead_id: number | null
  customer_id?: number | null
  document_id: number | null
  client_name: string | null
  client_address: string | null
  client_zip: string | null
  client_city: string | null
  client_email: string | null
  client_type: string
  title: string | null
  intro: string | null
  body: string | null
  agb_text: string | null
  value_cents: number
  small_business: number
  vat_rate: number
  payment_terms: string | null
  start_date: string | null
  end_date: string | null
  notice_period: string | null
  status: string
  issue_date: string | null
  signed_at: string | null
  signed_by: string | null
  signed_note: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  totals: ContractTotals
  has_signed_doc?: boolean
  signed_doc_name?: string | null
  signed_doc_mime?: string | null
  signed_doc_size?: number | null
}

export interface Expense {
  id: number
  vendor: string | null
  category: string
  description: string | null
  expense_date: string
  paid_on: string | null
  gross_cents: number
  vat_rate: number
  net_cents: number
  vat_cents: number
  payment_method: string | null
  note: string | null
  has_receipt: boolean
  receipt_name: string | null
  receipt_mime: string | null
  receipt_size: number | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ExpenseSummary {
  count: number
  gross_cents: number
  net_cents: number
  vat_cents: number
  by_category: { category: string; count: number; gross_cents: number; net_cents: number }[]
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  url?: string | null
}

export interface PublicUser {
  id: number
  username: string
  role: string
  created_at: string
}

export interface MonthRevenue {
  month: string
  net_cents: number
  gross_cents: number
  count: number
}

export interface Dashboard {
  leads: {
    total: number
    open: number
    won: number
    lost: number
    by_stage: { stage: string; n: number }[]
    conversion_pct: number
  }
  invoices: {
    issued: number
    drafts: number
    gross_total_cents: number
    paid_total_cents: number
    net_total_cents: number
    open_total_cents: number
    overdue_count: number
    overdue_total_cents: number
  }
  expenses: {
    count: number
    gross_total_cents: number
    net_total_cents: number
    vat_total_cents: number
    ytd_gross_cents: number
  }
  time: {
    uninvoiced_count: number
    uninvoiced_minutes: number
    uninvoiced_amount_cents: number
  }
  contracts: {
    active: number
    drafts: number
    active_value_cents: number
    expiring_soon: ExpiringContract[]
  }
  result: { net_cents: number }
  revenue_by_month: MonthRevenue[]
}

export interface ExpiringContract {
  id: number
  number: string | null
  title: string | null
  client_name: string | null
  end_date: string | null
  notice_period: string | null
}

// --- Bankabgleich (CAMT.053) ---
export interface BankMatchSuggestion {
  document_id: number
  number: string | null
  client_name: string | null
  outstanding_cents: number
  reason: 'number' | 'amount'
  amount_ok: boolean
}

export interface BankPreviewEntry {
  ext_ref: string
  booked_on: string | null
  amount_cents: number
  direction: 'credit' | 'debit'
  remittance: string
  counterparty: string | null
  already_seen: boolean
  suggestion: BankMatchSuggestion | null
}

export interface BankOpenInvoice {
  id: number
  number: string | null
  client_name: string | null
  outstanding_cents: number
}

export interface BankPreview {
  entries: BankPreviewEntry[]
  open_invoices: BankOpenInvoice[]
  total: number
  credits: number
  new_count: number
}

export interface BankApplyItem {
  ext_ref: string
  booked_on?: string | null
  amount_cents: number
  direction?: string
  remittance?: string | null
  counterparty?: string | null
  document_id?: number | null
  ignore?: boolean
}

export interface BankApplyResult {
  applied: number
  matched: number
  ignored: number
  skipped: number
  payments: { ext_ref: string; document_id: number; payment_id: number }[]
}

export interface User {
  id: number
  username: string
  role: string
}

// --- e-invoice validation ---------------------------------------------------

export interface ValidationFinding {
  rule: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  profile: string
  checked_at: string
  errors: ValidationFinding[]
  warnings: ValidationFinding[]
  notes?: ValidationFinding[]
}

// --- Mahnwesen (dunning) ----------------------------------------------------

export interface DunningComputation {
  document_id: number
  number: string | null
  client_name: string | null
  gross_cents: number
  issue_date: string | null
  due_date: string | null
  days_overdue: number
  suggested_level: number
  interest_rate_percent: number
  interest_cents: number
  pauschale_cents: number
  total_claim_cents: number
}

export interface Mahnung {
  id: number
  document_id: number
  level: number
  days_overdue: number
  interest_cents: number
  pauschale_cents: number
  total_claim_cents: number
  note: string | null
  created_at: string
}

// --- AI core ---------------------------------------------------------------

export interface AiStatus {
  ok: boolean
  model: string
  label: string
  local: boolean
  local_inference: boolean
  base_url: string
  detail?: string
}

export interface LeadAnalysis {
  lead_id: number
  summary: string | null
  qualification: string | null
  fit_score: number | null
  next_action: string | null
  talking_points: string | null // JSON string[]
  risk_flags: string | null // JSON string[]
  model: string | null
  created_at: string
}

export interface Outreach {
  id: number
  lead_id: number
  channel: string
  subject: string | null
  body: string
  language: string
  legal_basis: string | null
  status: string
  model: string | null
  created_at: string
  updated_at: string
}

export interface SemanticHit {
  lead: Lead
  score: number
}

export interface AgentStep {
  tool: string
  args: Record<string, unknown>
  result: unknown
}

export interface ChatResponse {
  thread_id: number
  reply: string
  steps: AgentStep[]
}

export interface AiThread {
  id: number
  title: string | null
  created_at: string
  updated_at: string
}

export interface ThreadMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  tool_calls: string | null // JSON: { tool, args }[]
  created_at: string
}

export interface DigestPriority {
  title: string
  why: string
  action: string
}

export interface Digest {
  headline: string
  priorities: DigestPriority[]
  ai: boolean
  facts: {
    new_leads: number
    hot_leads: unknown[]
    stale_leads: unknown[]
    overdue: { count: number; total_claim_cents: number; worst_days: number }
  }
}

export interface InvoiceDraft {
  kind: 'rechnung' | 'angebot'
  title: string
  intro: string
  client_name: string | null
  items: { description: string; quantity: number; unit: string; unit_price_cents: number }[]
  notes: string
}

// --- integrations / public API / webhooks -----------------------------------

export interface IntegrationConfigField {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  secret?: boolean
  required?: boolean
  options?: { value: string; label: string }[]
  placeholder?: string
}

export interface IntegrationProvider {
  category: string
  provider: string
  label: string
  configSchema: IntegrationConfigField[]
  // True when the app actually consumes this category's active adapter today.
  // False = registered/configurable but not yet wired to any action.
  wired: boolean
}

export interface IntegrationConnection {
  id: number
  category: string
  provider: string
  label: string | null
  active: boolean
  status: string // unconfigured | ok | error
  status_detail: string | null
  config: Record<string, unknown>
  credentials_set: boolean
  oauth_connected?: boolean
  account_email?: string | null
  created_at: string
  updated_at: string
}

export interface ApiKey {
  id: number
  name: string | null
  prefix: string
  scopes: string // CSV
  created_by: string | null
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

export interface WebhookEndpoint {
  id: number
  url: string
  events: string // CSV or '*'
  active: boolean
  description: string | null
  secret_set: boolean
  created_at: string
  updated_at: string
}

export interface WebhookDelivery {
  id: number
  endpoint_id: number
  event: string
  attempts: number
  status: string // pending | delivered | failed
  next_attempt_at: string
  response_code: number | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface VatValidation {
  valid: boolean
  country_code: string
  vat_number: string
  name?: string | null
  address?: string | null
}

export interface PaymentLink {
  id: string
  url: string
  amount_cents: number
  currency: string
  status: string
}

export type NewLead = Partial<
  Pick<
    Lead,
    | 'company'
    | 'trade'
    | 'city'
    | 'website'
    | 'phone'
    | 'email'
    | 'tech'
    | 'staleness_signal'
    | 'why_lead'
    | 'priority'
    | 'score'
  >
>
