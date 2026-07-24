import type {
  AiStatus,
  AiThread,
  ChatResponse,
  CatalogItem,
  Config,
  Contract,
  Customer,
  CustomerOverview,
  Dashboard,
  EuerReport,
  Digest,
  Doc,
  DocItem,
  Expense,
  ExpenseSummary,
  InvoiceDraft,
  Lead,
  LeadAnalysis,
  LeadEvent,
  NewLead,
  Outreach,
  Payment,
  PaymentSummary,
  PublicUser,
  RecurringInvoice,
  Settings,
  Subscription,
  SubscriptionSummary,
  ThreadMessage,
  User,
  ValidationResult,
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
  logout: () => req<{ ok: true; logoutUrl?: string | null }>('/logout', { method: 'POST' }),
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
  listDocuments: (kind?: string, customerId?: number) => {
    const qs = new URLSearchParams()
    if (kind) qs.set('kind', kind)
    if (customerId != null) qs.set('customer_id', String(customerId))
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ documents: Doc[] }>(`/documents${suffix}`)
  },
  getDocument: (id: number) => req<{ document: Doc }>(`/documents/${id}`),
  stornoDocument: (id: number) =>
    req<{ document: Doc }>(`/documents/${id}/storno`, { method: 'POST' }),
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
  signedDocumentUrl: (id: number) => `/api/documents/${id}/signed-document`,
  uploadSignedDocument: async (id: number, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`/api/documents/${id}/signed-document`, { method: 'POST', credentials: 'include', body: fd })
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
    return (await res.json()) as { document: Doc }
  },
  deleteSignedDocument: (id: number) =>
    req<{ document: Doc }>(`/documents/${id}/signed-document`, { method: 'DELETE' }),
  validateDocument: (id: number) =>
    req<{ validation: ValidationResult }>(`/documents/${id}/validate`),
  sendDocument: (id: number) =>
    req<{ ok: true; messageId: string; to: string }>(`/documents/${id}/send`, {
      method: 'POST',
    }),

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

  // --- Abonnements (recurring outgoing subscriptions) ---
  listSubscriptions: (activeOnly = false) =>
    req<{ subscriptions: Subscription[]; summary: SubscriptionSummary }>(
      `/subscriptions${activeOnly ? '?active=1' : ''}`,
    ),
  createSubscription: (body: Partial<Subscription>) =>
    req<{ subscription: Subscription }>('/subscriptions', { method: 'POST', body: JSON.stringify(body) }),
  updateSubscription: (id: number, patch: Partial<Subscription>) =>
    req<{ subscription: Subscription }>(`/subscriptions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSubscription: (id: number) =>
    req<{ ok: true }>(`/subscriptions/${id}`, { method: 'DELETE' }),
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

  // --- Kunden (customer registry) ---
  listCustomers: (activeOnly = false, leadId?: number) => {
    const qs = new URLSearchParams()
    if (activeOnly) qs.set('active', '1')
    if (leadId != null) qs.set('lead_id', String(leadId))
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ customers: Customer[] }>(`/customers${suffix}`)
  },
  getCustomer: (id: number) => req<{ customer: Customer }>(`/customers/${id}`),
  createCustomer: (body: Partial<Customer>) =>
    req<{ customer: Customer }>('/customers', { method: 'POST', body: JSON.stringify(body) }),
  updateCustomer: (id: number, patch: Partial<Customer>) =>
    req<{ customer: Customer }>(`/customers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteCustomer: (id: number) => req<{ ok: true }>(`/customers/${id}`, { method: 'DELETE' }),
  customerOverview: (id: number) => req<{ overview: CustomerOverview }>(`/customers/${id}/overview`),

  // --- Serienrechnungen (recurring invoices) ---
  listRecurring: (params: { customer_id?: number; contract_id?: number; active?: boolean } = {}) => {
    const qs = new URLSearchParams()
    if (params.customer_id != null) qs.set('customer_id', String(params.customer_id))
    if (params.contract_id != null) qs.set('contract_id', String(params.contract_id))
    if (params.active === true) qs.set('active', '1')
    if (params.active === false) qs.set('active', '0')
    const suffix = qs.toString() ? `?${qs}` : ''
    return req<{ recurring: RecurringInvoice[] }>(`/recurring${suffix}`)
  },
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
  createRecurringFromContract: (
    contractId: number,
    body: Omit<Partial<RecurringInvoice>, 'items'> & { items?: DocItem[] } = {},
  ) =>
    req<{ recurring: RecurringInvoice }>(`/contracts/${contractId}/recurring`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // --- Leistungskatalog (reusable services/products) ---
  listCatalog: (activeOnly = false) =>
    req<{ items: CatalogItem[] }>(`/catalog${activeOnly ? '?active=1' : ''}`),
  createCatalogItem: (body: Partial<CatalogItem>) =>
    req<{ item: CatalogItem }>('/catalog', { method: 'POST', body: JSON.stringify(body) }),
  updateCatalogItem: (id: number, patch: Partial<CatalogItem>) =>
    req<{ item: CatalogItem }>(`/catalog/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteCatalogItem: (id: number) => req<{ ok: true }>(`/catalog/${id}`, { method: 'DELETE' }),

  // --- Verträge (contracts / AGB) ---
  listContracts: (customerId?: number) =>
    req<{ contracts: Contract[] }>(
      `/contracts${customerId != null ? `?customer_id=${customerId}` : ''}`,
    ),
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


  // --- AI core ---
  aiStatus: () => req<AiStatus>('/ai/status'),
  aiDigest: () => req<{ digest: Digest }>('/ai/digest'),
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

  // --- DSGVO ---
  dsgvoExportUrl: (leadId: number) => `/api/dsgvo/lead/${leadId}/export`,
  dsgvoErase: (leadId: number, reason?: string) =>
    req<{ ok: true; erased: number; retained_documents: number }>(
      `/dsgvo/lead/${leadId}/erase`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
}

export { ApiError }
