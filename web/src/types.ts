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
  recontact_at: string | null
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

export interface Config {
  stages: string[]
  priorities: string[]
  docKinds: string[]
  docStatuses: Record<string, string[]>
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
  scraper_min_score: number | null
  scraper_max_pairs: number | null
  scraper_per_pair: number | null
  verzug_base_rate?: number
  datev_revenue_account?: string | null
  datev_debitor_account?: string | null
}

export interface ScraperConfig {
  trades: string[]
  towns: string[]
  min_score: number
  max_pairs: number
  per_pair: number
  using_defaults: { trades: boolean; towns: boolean }
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
  created_at: string
  updated_at: string
  items: DocItem[]
  totals: DocTotals
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
    recontact_due: unknown[]
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
