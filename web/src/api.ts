import type {
  AiStatus,
  AiThread,
  ChatResponse,
  Config,
  Digest,
  Doc,
  DocItem,
  DunningComputation,
  InvoiceDraft,
  Mahnung,
  Lead,
  LeadAnalysis,
  LeadEvent,
  NewLead,
  Outreach,
  ScraperConfig,
  SemanticHit,
  ScraperStatus,
  Settings,
  User,
  ValidationResult,
  WorkflowRun,
  WorkflowSummary,
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
  deleteDocument: (id: number) =>
    req<{ ok: true }>(`/documents/${id}`, { method: 'DELETE' }),
  pdfUrl: (id: number) => `/api/documents/${id}/pdf`,
  validateDocument: (id: number) =>
    req<{ validation: ValidationResult }>(`/documents/${id}/validate`),

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

  // --- exports (Steuerberater) ---
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

  // --- scraper ---
  scraperConfig: () => req<ScraperConfig>('/scraper/config'),
  scraperStatus: () => req<ScraperStatus>('/scraper/status'),

  // --- workflows ---
  listWorkflows: () => req<{ workflows: WorkflowSummary[] }>('/workflows'),
  runWorkflow: (key: string, limit?: number) =>
    req<{ run: WorkflowRun }>(`/workflows/${key}/run`, {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  workflowRuns: (key: string) =>
    req<{ runs: WorkflowRun[] }>(`/workflows/runs?key=${encodeURIComponent(key)}`),

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
  dsgvoAudit: (entity?: string, entityId?: number) => {
    const qs = new URLSearchParams()
    if (entity) qs.set('entity', entity)
    if (entityId) qs.set('entity_id', String(entityId))
    const s = qs.toString() ? `?${qs}` : ''
    return req<{ audit: Record<string, unknown>[] }>(`/dsgvo/audit${s}`)
  },
}

export { ApiError }
