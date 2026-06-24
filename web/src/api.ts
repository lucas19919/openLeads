import type {
  AiStatus,
  AiThread,
  ChatResponse,
  BankApplyItem,
  BankApplyResult,
  BankPreview,
  CatalogItem,
  Config,
  Contract,
  Customer,
  CustomerOverview,
  Dashboard,
  EuerReport,
  Digest,
  ApiKey,
  Doc,
  DocItem,
  TimeEntry,
  TimeSummary,
  CalendarEvent,
  DunningComputation,
  Expense,
  ExpenseSummary,
  IntegrationConnection,
  IntegrationProvider,
  InvoiceDraft,
  Mahnung,
  Lead,
  PaymentLink,
  VatValidation,
  LeadAnalysis,
  LeadEvent,
  NewLead,
  Outreach,
  Payment,
  PaymentSummary,
  PublicUser,
  RecurringInvoice,
  ScraperConfig,
  SemanticHit,
  ScraperStatus,
  Settings,
  ThreadMessage,
  User,
  ValidationResult,
  WebhookEndpoint,
  WebhookDelivery,
} from './types'

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = await res.json()
      if (body?.error) msg = body.error
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  me: () => req<{ user: User }>('/me'),
  login: (username: string, password: string) =>
    req<{ user: User }>('/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => req<{ ok: true }>('/logout', { method: 'POST' }),
  config: () => req<Config>('/config'),
  listLeads: (params: { stage?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.stage) qs.set('stage', params.stage)
    if (params.q) qs.set('q', params.q)
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ leads: Lead[] }>(`/leads${suffix}`)
  },
  getLead: (id: number) => req<{ lead: Lead; events: LeadEvent[] }>(`/leads/${id}`),
  createLead: (lead: NewLead) =>
    req<{ id: number } | { deduped: true; id: number }>('/leads', {
      method: 'POST',
      body: JSON.stringify(lead),
    }),
  createCalendarEvent: (
    leadId: number,
    body: { title: string; start: string; end: string; description?: string },
  ) =>
    req<{ event: CalendarEvent }>(`/leads/${leadId}/calendar-event`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  startCall: (leadId: number) =>
    req<{ call_id: string }>(`/leads/${leadId}/call`, { method: 'POST' }),
  updateLead: (id: number, patch: Partial<Lead>) =>
    req<{ lead: Lead }>(`/leads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  importLeads: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    // No Content-Type header — the browser sets the multipart boundary.
    const res = await fetch('/api/leads/import', {
      method: 'POST',
      credentials: 'include',
      body: fd,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const b = await res.json()
        if (b?.error) msg = b.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg)
    }
    return res.json() as Promise<{
      imported: number
      deduped: number
      total: number
      fields: string[]
    }>
  },

  // --- settings (business profile) ---
  getSettings: () => req<{ settings: Settings }>('/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    req<{ settings: Settings }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  // --- documents (Angebote + Rechnungen) ---
  listDocuments: (kind?: string) =>
    req<{ documents: Doc[] }>(`/documents${kind ? `?kind=${kind}` : ''}`),
  getDocument: (id: number) => req<{ document: Doc }>(`/documents/${id}`),
  createDocument: (body: {
    kind: string
    lead_id?: number | null
    customer_id?: number | null
    client_name?: string | null
    client_city?: string | null
    client_email?: string | null
    items?: DocItem[]
  }) =>
    req<{ document: Doc }>('/documents', { method: 'POST', body: JSON.stringify(body) }),
  updateDocument: (id: number, patch: Partial<Doc> & { items?: DocItem[] }) =>
    req<{ document: Doc }>(`/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  finalizeDocument: (id: number) =>
    req<{ document: Doc }>(`/documents/${id}/finalize`, { method: 'POST' }),
  convertDocument: (id: number) =>
    req<{ document: Doc }>(`/documents/${id}/convert`, { method: 'POST' }),
  documentToContract: (id: number) =>
    req<{ contract: Contract }>(`/documents/${id}/to-contract`, { method: 'POST' }),
  deleteDocument: (id: number) =>
    req<{ ok: true }>(`/documents/${id}`, { method: 'DELETE' }),
  pdfUrl: (id: number) => `/api/documents/${id}/pdf`,
  validateDocument: (id: number) =>
    req<{ validation: ValidationResult }>(`/documents/${id}/validate`),
  documentPaymentLink: (id: number) =>
    req<{ payment_link: PaymentLink }>(`/documents/${id}/payment-link`, { method: 'POST' }),
  sendDocument: (id: number, include_payment_link = false) =>
    req<{ ok: true; messageId: string; to: string }>(`/documents/${id}/send`, {
      method: 'POST',
      body: JSON.stringify({ include_payment_link }),
    }),
  validateVat: (id: number) =>
    req<{ validation: VatValidation }>(`/documents/${id}/validate-vat`, { method: 'POST' }),
  pushAccounting: (id: number) =>
    req<{ result: { external_id: string; url?: string; provider?: string | null; pushed_at?: string | null; already_pushed?: boolean } }>(
      `/documents/${id}/push-accounting`,
      { method: 'POST' },
    ),

  // --- Zahlungen (payments) ---
  listPayments: (id: number) => req<PaymentSummary>(`/documents/${id}/payments`),
  addPayment: (
    id: number,
    body: { amount_cents: number; paid_on?: string; method?: string; note?: string },
  ) =>
    req<{ payment: Payment; document: Doc }>(`/documents/${id}/payments`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deletePayment: (paymentId: number) =>
    req<{ document: Doc }>(`/payments/${paymentId}`, { method: 'DELETE' }),

  // --- Ausgaben (expenses / Belege) ---
  listExpenses: (params: { from?: string; to?: string; category?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.from) qs.set('from', params.from)
    if (params.to) qs.set('to', params.to)
    if (params.category) qs.set('category', params.category)
    if (params.q) qs.set('q', params.q)
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ expenses: Expense[]; summary: ExpenseSummary }>(`/expenses${suffix}`)
  },
  getExpense: (id: number) => req<{ expense: Expense }>(`/expenses/${id}`),
  createExpense: (body: Partial<Expense>) =>
    req<{ expense: Expense }>('/expenses', { method: 'POST', body: JSON.stringify(body) }),
  updateExpense: (id: number, patch: Partial<Expense>) =>
    req<{ expense: Expense }>(`/expenses/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteExpense: (id: number) => req<{ ok: true }>(`/expenses/${id}`, { method: 'DELETE' }),
  uploadReceipt: async (id: number, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    // No Content-Type header — the browser sets the multipart boundary.
    const res = await fetch(`/api/expenses/${id}/receipt`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const b = await res.json()
        if (b?.error) msg = b.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg)
    }
    return res.json() as Promise<{ expense: Expense }>
  },
  deleteReceipt: (id: number) =>
    req<{ expense: Expense }>(`/expenses/${id}/receipt`, { method: 'DELETE' }),
  receiptUrl: (id: number) => `/api/expenses/${id}/receipt`,
  exportExpensesUrl: (from?: string, to?: string) => {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return `/api/export/expenses.csv${qs.toString() ? `?${qs}` : ''}`
  },
  exportExpensesDatevUrl: (from?: string, to?: string) => {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return `/api/export/expenses-datev.csv${qs.toString() ? `?${qs}` : ''}`
  },

  // --- Serienrechnungen (recurring invoices) ---
  listRecurring: () => req<{ recurring: RecurringInvoice[] }>('/recurring'),
  createRecurring: (body: Omit<Partial<RecurringInvoice>, 'items'> & { items?: DocItem[] }) =>
    req<{ recurring: RecurringInvoice }>('/recurring', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateRecurring: (
    id: number,
    patch: Omit<Partial<RecurringInvoice>, 'items'> & { items?: DocItem[] },
  ) =>
    req<{ recurring: RecurringInvoice }>(`/recurring/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteRecurring: (id: number) => req<{ ok: true }>(`/recurring/${id}`, { method: 'DELETE' }),
  runRecurring: (id: number) =>
    req<{ document: Doc }>(`/recurring/${id}/run`, { method: 'POST' }),
  runDueRecurring: () =>
    req<{ generated: number; document_ids: number[] }>('/recurring/run-due', { method: 'POST' }),

  // --- Leistungskatalog (reusable services/products) ---
  listCatalog: (activeOnly = false) =>
    req<{ items: CatalogItem[] }>(`/catalog${activeOnly ? '?active=1' : ''}`),
  createCatalogItem: (body: Partial<CatalogItem>) =>
    req<{ item: CatalogItem }>('/catalog', { method: 'POST', body: JSON.stringify(body) }),
  updateCatalogItem: (id: number, patch: Partial<CatalogItem>) =>
    req<{ item: CatalogItem }>(`/catalog/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteCatalogItem: (id: number) => req<{ ok: true }>(`/catalog/${id}`, { method: 'DELETE' }),

  // --- Zeiterfassung (time tracking) ---
  listTime: (params: { from?: string; to?: string; lead_id?: number; billable?: '0' | '1'; invoiced?: '0' | '1' } = {}) => {
    const qs = new URLSearchParams()
    if (params.from) qs.set('from', params.from)
    if (params.to) qs.set('to', params.to)
    if (params.lead_id != null) qs.set('lead_id', String(params.lead_id))
    if (params.billable) qs.set('billable', params.billable)
    if (params.invoiced) qs.set('invoiced', params.invoiced)
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ entries: TimeEntry[]; summary: TimeSummary }>(`/time${suffix}`)
  },
  createTimeEntry: (body: Partial<TimeEntry>) =>
    req<{ entry: TimeEntry }>('/time', { method: 'POST', body: JSON.stringify(body) }),
  updateTimeEntry: (id: number, patch: Partial<TimeEntry>) =>
    req<{ entry: TimeEntry }>(`/time/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTimeEntry: (id: number) => req<{ ok: true }>(`/time/${id}`, { method: 'DELETE' }),
  invoiceTime: (entry_ids: number[]) =>
    req<{ document: Doc }>('/time/invoice', { method: 'POST', body: JSON.stringify({ entry_ids }) }),

  // --- Kunden (customers) ---
  listCustomers: (activeOnly = false) =>
    req<{ customers: Customer[] }>(`/customers${activeOnly ? '?active=1' : ''}`),
  getCustomer: (id: number) => req<{ customer: Customer }>(`/customers/${id}`),
  customerOverview: (id: number) => req<{ overview: CustomerOverview }>(`/customers/${id}/overview`),
  createCustomer: (body: Partial<Customer>) =>
    req<{ customer: Customer }>('/customers', { method: 'POST', body: JSON.stringify(body) }),
  updateCustomer: (id: number, patch: Partial<Customer>) =>
    req<{ customer: Customer }>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteCustomer: (id: number) => req<{ ok: true }>(`/customers/${id}`, { method: 'DELETE' }),

  // --- Bankabgleich (CAMT.053) ---
  bankPreview: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/bank/preview', { method: 'POST', credentials: 'include', body: fd })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const b = await res.json()
        if (b?.error) msg = b.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg)
    }
    return (await res.json()) as { preview: BankPreview }
  },
  bankApply: (items: BankApplyItem[]) =>
    req<{ result: BankApplyResult }>('/bank/apply', { method: 'POST', body: JSON.stringify({ items }) }),

  // --- Verträge (contracts / AGB) ---
  listContracts: () => req<{ contracts: Contract[] }>('/contracts'),
  getContract: (id: number) => req<{ contract: Contract }>(`/contracts/${id}`),
  createContract: (body: Partial<Contract>) =>
    req<{ contract: Contract }>('/contracts', { method: 'POST', body: JSON.stringify(body) }),
  updateContract: (id: number, patch: Partial<Contract>) =>
    req<{ contract: Contract }>(`/contracts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  finalizeContract: (id: number) =>
    req<{ contract: Contract }>(`/contracts/${id}/finalize`, { method: 'POST' }),
  signContract: (id: number, body: { signed_by?: string; signed_at?: string; note?: string }) =>
    req<{ contract: Contract }>(`/contracts/${id}/sign`, { method: 'POST', body: JSON.stringify(body) }),
  sendContract: (id: number) =>
    req<{ ok: true; messageId: string; to: string }>(`/contracts/${id}/send`, { method: 'POST' }),
  deleteContract: (id: number) => req<{ ok: true }>(`/contracts/${id}`, { method: 'DELETE' }),
  contractPdfUrl: (id: number) => `/api/contracts/${id}/pdf`,
  signedContractUrl: (id: number) => `/api/contracts/${id}/signed-document`,
  uploadSignedContract: async (id: number, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/contracts/${id}/signed-document`, { method: 'POST', credentials: 'include', body: fd })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const b = await res.json()
        if (b?.error) msg = b.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg)
    }
    return (await res.json()) as { contract: Contract }
  },
  deleteSignedContract: (id: number) =>
    req<{ contract: Contract }>(`/contracts/${id}/signed-document`, { method: 'DELETE' }),

  // --- dashboard ---
  dashboard: () => req<{ dashboard: Dashboard }>('/dashboard'),

  // --- EÜR / financial report ---
  euerReport: (from?: string, to?: string) => {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return req<{ report: EuerReport }>(`/report/euer${qs.toString() ? `?${qs}` : ''}`)
  },

  // --- users (multi-user) ---
  listUsers: () => req<{ users: PublicUser[] }>('/users'),
  createUser: (body: { username: string; password: string; role: string }) =>
    req<{ user: PublicUser }>('/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: number, patch: { role?: string; password?: string }) =>
    req<{ user: PublicUser }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteUser: (id: number) => req<{ ok: true }>(`/users/${id}`, { method: 'DELETE' }),

  // --- Mahnwesen (dunning) ---
  overdueInvoices: () => req<{ overdue: DunningComputation[] }>('/invoices/overdue'),
  previewDunning: (id: number, level?: number) =>
    req<{ preview: DunningComputation; history: Mahnung[] }>(
      `/documents/${id}/dunning${level != null ? `?level=${level}` : ''}`,
    ),
  raiseDunning: (id: number, body: { level?: number; note?: string } = {}) =>
    req<{ mahnung: Mahnung; computation: DunningComputation; label: string }>(
      `/documents/${id}/dunning`,
      { method: 'POST', body: JSON.stringify(body) },
    ),

  // --- exports ---
  exportLeadsUrl: (params: { stage?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.stage) qs.set('stage', params.stage)
    if (params.q) qs.set('q', params.q)
    return `/api/export/leads.csv${qs.toString() ? `?${qs}` : ''}`
  },
  exportInvoicesUrl: (from?: string, to?: string) => {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return `/api/export/invoices.csv${qs.toString() ? `?${qs}` : ''}`
  },
  exportDatevUrl: (from?: string, to?: string) => {
    const qs = new URLSearchParams()
    if (from) qs.set('from', from)
    if (to) qs.set('to', to)
    return `/api/export/datev.csv${qs.toString() ? `?${qs}` : ''}`
  },

  // --- admin ---
  backupUrl: () => '/api/admin/backup',
  restoreBackup: async (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/admin/restore', { method: 'POST', credentials: 'include', body: fd })
    if (!res.ok) {
      let msg = res.statusText
      try {
        const b = await res.json()
        if (b?.error) msg = b.error
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, msg)
    }
    return res.json() as Promise<{ ok: true; tables: number; rows: number }>
  },

  // --- scraper ---
  scraperConfig: () => req<ScraperConfig>('/scraper/config'),
  scraperStatus: () => req<ScraperStatus>('/scraper/status'),
  runScraper: (dry = false) =>
    req<{ started: true }>('/scraper/run', { method: 'POST', body: JSON.stringify({ dry }) }),

  // --- AI core ---
  aiStatus: () => req<AiStatus>('/ai/status'),
  aiDigest: () => req<{ digest: Digest }>('/ai/digest'),
  semanticSearch: (q: string) =>
    req<{ mode: 'semantic' | 'fallback'; hits: SemanticHit[] }>(
      `/ai/leads/search?q=${encodeURIComponent(q)}`,
    ),
  reindexLeads: () => req<{ indexed: number; model: string }>('/ai/leads/reindex', { method: 'POST' }),
  aiChat: (message: string, thread_id?: number) =>
    req<ChatResponse>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ message, thread_id }),
    }),
  aiThreads: () => req<{ threads: AiThread[] }>('/ai/threads'),
  aiThread: (id: number) =>
    req<{ thread: AiThread; messages: ThreadMessage[] }>(`/ai/threads/${id}`),
  analyzeLead: (id: number) =>
    req<{ analysis: LeadAnalysis }>(`/ai/leads/${id}/analyze`, { method: 'POST' }),
  draftOutreach: (id: number, channel: 'email' | 'letter' | 'call_script' = 'email') =>
    req<{ outreach: Outreach }>(`/ai/leads/${id}/outreach`, {
      method: 'POST',
      body: JSON.stringify({ channel }),
    }),
  listOutreach: (id: number) =>
    req<{ outreach: Outreach[] }>(`/ai/leads/${id}/outreach`),
  updateOutreach: (id: number, patch: Partial<Pick<Outreach, 'status' | 'subject' | 'body'>>) =>
    req<{ outreach: Outreach }>(`/ai/outreach/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  sendOutreach: (id: number) =>
    req<{ ok: true; messageId: string; to: string }>(`/ai/outreach/${id}/send`, { method: 'POST' }),
  draftInvoice: (text: string, opts: { create?: boolean; lead_id?: number } = {}) =>
    req<{ draft: InvoiceDraft; document?: Doc }>('/ai/invoice/draft', {
      method: 'POST',
      body: JSON.stringify({ text, ...opts }),
    }),

  // --- integrations (adapters / connections) ---
  integrationProviders: () =>
    req<{ providers: IntegrationProvider[] }>('/integrations/providers'),
  integrationConnections: () =>
    req<{ connections: IntegrationConnection[] }>('/integrations/connections'),
  saveIntegration: (body: {
    category: string
    provider: string
    label?: string | null
    fields: Record<string, unknown>
  }) =>
    req<{ connection: IntegrationConnection }>('/integrations/connections', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  activateIntegration: (id: number) =>
    req<{ connection: IntegrationConnection }>(`/integrations/connections/${id}/activate`, {
      method: 'POST',
    }),
  probeIntegration: (id: number) =>
    req<{ probe: { ok: boolean; detail?: string }; connection: IntegrationConnection }>(
      `/integrations/connections/${id}/probe`,
      { method: 'POST' },
    ),
  deleteIntegration: (id: number) =>
    req<{ ok: true }>(`/integrations/connections/${id}`, { method: 'DELETE' }),
  startOAuth: (id: number) => req<{ url: string }>(`/integrations/oauth/${id}/authorize`),
  disconnectOAuth: (id: number) =>
    req<{ ok: true }>(`/integrations/oauth/${id}/disconnect`, { method: 'POST' }),

  // --- public API keys (admin) ---
  listApiKeys: () => req<{ keys: ApiKey[] }>('/admin/api-keys'),
  createApiKey: (body: { name?: string; scopes: string[] }) =>
    req<{ key: { id: number; name: string | null; prefix: string; scopes: string[] }; token: string }>(
      '/admin/api-keys',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  revokeApiKey: (id: number) => req<{ ok: true }>(`/admin/api-keys/${id}`, { method: 'DELETE' }),

  // --- outbound webhooks (admin) ---
  listWebhooks: () => req<{ endpoints: WebhookEndpoint[] }>('/admin/webhooks'),
  webhookEvents: () => req<{ events: string[] }>('/admin/webhooks/events'),
  createWebhook: (body: { url: string; events?: string; description?: string }) =>
    req<{ endpoint: WebhookEndpoint; secret: string }>('/admin/webhooks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateWebhook: (
    id: number,
    patch: { url?: string; events?: string; active?: boolean; description?: string },
  ) =>
    req<{ endpoint: WebhookEndpoint }>(`/admin/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteWebhook: (id: number) => req<{ ok: true }>(`/admin/webhooks/${id}`, { method: 'DELETE' }),
  webhookDeliveries: (id: number) =>
    req<{ deliveries: WebhookDelivery[] }>(`/admin/webhooks/${id}/deliveries`),
  redeliverWebhook: (deliveryId: number) =>
    req<{ ok: true }>(`/admin/webhooks/deliveries/${deliveryId}/redeliver`, { method: 'POST' }),
  rotateWebhookSecret: (id: number) =>
    req<{ secret: string }>(`/admin/webhooks/${id}/rotate-secret`, { method: 'POST' }),

  // --- DSGVO ---
  dsgvoExportUrl: (leadId: number) => `/api/dsgvo/lead/${leadId}/export`,
  dsgvoErase: (leadId: number, reason?: string) =>
    req<{ ok: true; erased: number; retained_documents: number }>(
      `/dsgvo/lead/${leadId}/erase`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  dsgvoAudit: (entity?: string, entityId?: number) => {
    const qs = new URLSearchParams()
    if (entity) qs.set('entity', entity)
    if (entityId) qs.set('entity_id', String(entityId))
    const s = qs.toString() ? `?${qs}` : ''
    return req<{ audit: Record<string, unknown>[] }>(`/dsgvo/audit${s}`)
  },
}

export { ApiError }
