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
  ai_api_key_set?: boolean
  smtp_pass_set?: boolean
  settings_key_configured?: boolean
  // Verträge / AGB
  agb_text?: string | null
  contract_prefix?: string
  contract_next?: number
  agb_attach_documents?: number
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
  has_signed_doc?: boolean
  signed_doc_name?: string | null
  signed_doc_size?: number | null
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

/** Kundenstamm — once maintained, reused on documents/contracts/series. */
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

export interface CustomerOverviewKpis {
  invoices_count: number
  invoiced_gross_cents: number
  paid_cents: number
  open_cents: number
  quotes_count: number
  contracts_active: number
  contracts_total: number
  series_active: number
}

export interface CustomerOverview {
  customer: Customer
  kpis: CustomerOverviewKpis
  documents: {
    id: number
    kind: string
    number: string | null
    status: string
    title: string | null
    issue_date: string | null
    gross_cents: number
    paid_cents: number
    open_cents: number
    has_signed_doc: boolean
  }[]
  contracts: {
    id: number
    number: string | null
    type: string
    status: string
    title: string | null
    value_cents: number
    start_date: string | null
    end_date: string | null
    has_signed_doc: boolean
    signed_doc_name?: string | null
  }[]
  recurring: {
    id: number
    title: string | null
    cadence: string
    next_run: string
    active: number
    contract_id?: number | null
    contract_number?: string | null
  }[]
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
  contract_id?: number | null
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

// Abonnements: recurring outgoing subscriptions the business pays.
export interface Subscription {
  id: number
  vendor: string
  description: string | null
  category: string
  amount_cents: number
  vat_rate: number
  cadence: string
  next_renewal: string | null
  payment_method: string | null
  active: number
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  monthly_cents: number
  yearly_cents: number
}

export interface SubscriptionSummary {
  count: number
  active_count: number
  monthly_cents: number
  yearly_cents: number
  by_category: { category: string; count: number; monthly_cents: number }[]
  upcoming: { id: number; vendor: string; next_renewal: string; amount_cents: number }[]
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
