import { db, type LeadRow, type LeadAiRow, type OutreachRow } from '../db'
import { getSettings } from '../documents'
import { audit } from '../audit'
import { chatJSON, AI } from './provider'
import { LEAD_ANALYST_SYSTEM, OUTREACH_SYSTEM, INVOICE_DRAFTER_SYSTEM } from './prompts'

function leadFacts(lead: LeadRow): string {
  const f: Record<string, unknown> = {
    firma: lead.company,
    gewerk: lead.trade,
    ort: lead.city,
    website: lead.website,
    telefon: lead.phone,
    email: lead.email,
    mobilfaehig: lead.mobile_friendly === null ? 'unbekannt' : !!lead.mobile_friendly,
    technik: lead.tech,
    veraltungs_signal: lead.staleness_signal,
    veraltungs_score: lead.score,
    bisherige_einschaetzung: lead.why_lead,
    stage: lead.stage,
    notizen: lead.notes,
  }
  return JSON.stringify(f, null, 2)
}

export interface LeadAnalysis {
  summary: string
  qualification: 'hot' | 'warm' | 'cold' | 'disqualified'
  fit_score: number
  next_action: string
  talking_points: string[]
  risk_flags: string[]
}

/** Run (or re-run) the AI assessment for a lead and cache it. */
export async function analyzeLead(lead: LeadRow, actor: string): Promise<LeadAiRow> {
  const a = await chatJSON<LeadAnalysis>(
    LEAD_ANALYST_SYSTEM,
    `Bewerte diesen Lead:\n\n${leadFacts(lead)}`,
    { temperature: 0.2, maxTokens: 700 },
  )
  const tp = Array.isArray(a.talking_points) ? a.talking_points : []
  const rf = Array.isArray(a.risk_flags) ? a.risk_flags : []
  db.prepare(
    `INSERT INTO lead_ai (lead_id, summary, qualification, fit_score, next_action,
                          talking_points, risk_flags, model, created_at)
     VALUES (@lead_id, @summary, @qualification, @fit_score, @next_action,
             @talking_points, @risk_flags, @model, datetime('now'))
     ON CONFLICT(lead_id) DO UPDATE SET
       summary=@summary, qualification=@qualification, fit_score=@fit_score,
       next_action=@next_action, talking_points=@talking_points,
       risk_flags=@risk_flags, model=@model, created_at=datetime('now')`,
  ).run({
    lead_id: lead.id,
    summary: a.summary ?? null,
    qualification: a.qualification ?? null,
    fit_score: Number.isFinite(a.fit_score) ? Math.round(a.fit_score) : null,
    next_action: a.next_action ?? null,
    talking_points: JSON.stringify(tp),
    risk_flags: JSON.stringify(rf),
    model: AI.model,
  })
  audit({ actor, action: 'ai.analyze_lead', entity: 'lead', entityId: lead.id, detail: { model: AI.model, qualification: a.qualification } })
  return db.prepare('SELECT * FROM lead_ai WHERE lead_id = ?').get(lead.id) as unknown as LeadAiRow
}

export interface OutreachDraft {
  subject: string
  body: string
  legal_basis: string
}

/** Draft (never send) a first-touch message for a lead and persist it. */
export async function draftOutreach(
  lead: LeadRow,
  actor: string,
  channel: 'email' | 'letter' | 'call_script' = 'email',
): Promise<OutreachRow> {
  const s = getSettings()
  const sender = {
    absender_firma: s.business_name,
    absender_name: s.owner,
    absender_ort: s.city,
    angebot: 'Modernisierung/Neubau der Website, lokale Sichtbarkeit',
  }
  const d = await chatJSON<OutreachDraft>(
    OUTREACH_SYSTEM,
    `Kanal: ${channel}\n\nLead:\n${leadFacts(lead)}\n\nAbsender-Kontext (nur zur Tonalität, Platzhalter im Text verwenden):\n${JSON.stringify(sender, null, 2)}`,
    { temperature: 0.5, maxTokens: 600 },
  )
  const info = db.prepare(
    `INSERT INTO outreach (lead_id, channel, subject, body, language, legal_basis, status, model)
     VALUES (?, ?, ?, ?, 'de', ?, 'entwurf', ?)`,
  ).run(lead.id, channel, d.subject ?? null, d.body ?? '', d.legal_basis ?? null, AI.model)
  audit({ actor, action: 'ai.draft_outreach', entity: 'lead', entityId: lead.id, detail: { channel, model: AI.model } })
  return db.prepare('SELECT * FROM outreach WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as OutreachRow
}

export interface InvoiceDraft {
  kind: 'rechnung' | 'angebot'
  title: string
  intro: string
  client_name: string | null
  items: { description: string; quantity: number; unit: string; unit_price_cents: number }[]
  notes: string
}

/** Turn a free-text description into a structured (not yet saved) document draft. */
export async function draftInvoiceFromText(text: string): Promise<InvoiceDraft> {
  const d = await chatJSON<InvoiceDraft>(INVOICE_DRAFTER_SYSTEM, text, { temperature: 0.2, maxTokens: 900 })
  d.kind = d.kind === 'angebot' ? 'angebot' : 'rechnung'
  d.items = Array.isArray(d.items)
    ? d.items.map((it) => ({
        description: String(it.description ?? ''),
        quantity: Number(it.quantity ?? 1),
        unit: String(it.unit ?? 'Stk'),
        unit_price_cents: Math.round(Number(it.unit_price_cents ?? 0)),
      }))
    : []
  return d
}
