// The slice of the API's response shapes the CLI actually renders. Kept
// deliberately partial: the CLI prints columns and passes whole objects through
// in --json mode, so it does not need to mirror every server field — only the
// ones it formats.

export interface Lead {
  id: number
  company: string | null
  trade: string | null
  city: string | null
  website: string | null
  phone: string | null
  email: string | null
  score: number
  priority: string
  stage: string
  why_lead: string | null
  notes: string | null
  tags: string | null
  assigned_to: string | null
  source: string
  created_at: string
  updated_at: string
}

export interface LeadEvent {
  id: number
  at: string
  actor: string | null
  type: string
  from_stage: string | null
  to_stage: string | null
  body: string | null
}

export interface DocItem {
  description: string | null
  quantity: number
  unit: string | null
  unit_price_cents: number
}

export interface Doc {
  id: number
  kind: string
  number: string | null
  client_name: string | null
  client_email: string | null
  title: string | null
  status: string
  issue_date: string | null
  due_date: string | null
  created_at: string
  items: DocItem[]
  totals: { net_cents: number; vat_cents: number; gross_cents: number }
  paid_cents: number
}

export interface Payment {
  id: number
  amount_cents: number
  paid_on: string
  method: string | null
  note: string | null
}

export interface PaymentSummary {
  payments: Payment[]
  gross_cents: number
  paid_cents: number
  outstanding_cents: number
}

export interface Customer {
  id: number
  name: string
  contact_name: string | null
  city: string | null
  email: string | null
  phone: string | null
  client_type: string
  active: number
}

export interface Contract {
  id: number
  number: string | null
  type: string
  client_name: string | null
  title: string | null
  status: string
  value_cents: number
  start_date: string | null
  end_date: string | null
  signed_at: string | null
  totals: { net_cents: number; vat_cents: number; gross_cents: number }
}

export interface Expense {
  id: number
  vendor: string | null
  category: string
  description: string | null
  expense_date: string
  gross_cents: number
  net_cents: number
  vat_cents: number
  has_receipt: boolean
}

export interface ExpenseSummary {
  count: number
  gross_cents: number
  net_cents: number
  vat_cents: number
}

export interface Subscription {
  id: number
  vendor: string
  category: string
  amount_cents: number
  cadence: string
  next_renewal: string | null
  active: number
  monthly_cents: number
  yearly_cents: number
}

export interface RecurringInvoice {
  id: number
  client_name: string | null
  title: string | null
  cadence: string
  next_run: string
  last_run: string | null
  active: number
}

export interface CatalogItem {
  id: number
  name: string
  unit: string | null
  unit_price_cents: number
  category: string | null
  active: number
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
    open_total_cents: number
    overdue_count: number
    overdue_total_cents: number
  }
  expenses: { count: number; gross_total_cents: number; net_total_cents: number }
  contracts: {
    active: number
    drafts: number
    active_value_cents: number
    expiring_soon: {
      id: number
      number: string | null
      title: string | null
      client_name: string | null
      end_date: string | null
    }[]
  }
  result: { net_cents: number }
  revenue_by_month: { month: string; net_cents: number; gross_cents: number; count: number }[]
}

export interface Digest {
  headline: string
  ai: boolean
  priorities: { title: string; why: string; action: string }[]
  facts: {
    new_leads: number
    hot_leads: { id: number; company: string | null; fit_score: number | null; next_action: string | null }[]
    stale_leads: { id: number; company: string | null; stage: string; updated_at: string }[]
    overdue: { count: number; total_claim_cents: number; worst_days: number }
  }
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
    by_category: { category: string; label: string; skr03: string; count: number; net_cents: number }[]
  }
  result_net_cents: number
  vat: { collected_cents: number; input_cents: number; payable_cents: number }
  small_business: boolean
}

export interface ValidationResult {
  valid: boolean
  profile: string
  errors: { rule: string; message: string }[]
  warnings: { rule: string; message: string }[]
}

/** A human's yes (or no) to a one-way door — see api/src/approvals.ts. */
export interface Approval {
  id: number
  action: 'document.finalize' | 'document.send' | 'contract.finalize' | 'contract.send'
  entity: string
  entity_id: number
  status: 'offen' | 'genehmigt' | 'abgelehnt' | 'verbraucht' | 'zurueckgezogen' | 'abgelaufen'
  reason: string | null
  requested_by: string
  requested_at: string
  expires_at: string
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  used_at: string | null
  summary: {
    label: string
    title: string
    recipient: string | null
    recipient_email: string | null
    gross_cents: number
    number: string | null
    lines: string[]
    warnings: string[]
  }
  /** False when the paper changed after the decision — the yes no longer holds. */
  content_unchanged?: boolean
}

export interface ApiToken {
  id: number
  name: string
  prefix: string
  scope: 'read' | 'write'
  created_at: string
  last_used_at: string | null
  expires_at: string | null
}

export interface SessionUser {
  id: number
  username: string
  role: string
}

export interface Config {
  stages: string[]
  priorities: string[]
  docKinds: string[]
  docStatuses: Record<string, string[]>
  cadences: string[]
  expenseCategories: { id: string; label: string; skr03: string }[]
  paymentMethods: string[]
  contractTypes: { id: string; label: string }[]
  contractStatuses: string[]
  roles: string[]
  clientTypes: string[]
}
