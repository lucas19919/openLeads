import { db } from '../db'
import { listOverdue } from '../dunning'
import { chatJSON, AI } from './provider'
import { COMPLIANCE_GUARDRAILS } from './prompts'

// The "morning briefing": gather what needs attention across the pipeline and
// the ledger deterministically, then let the model turn it into a short,
// prioritised action list. Facts are always returned; the AI narrative is
// best-effort so the digest still works when the model is offline.

export interface DigestFacts {
  new_leads: number
  hot_leads: { id: number; company: string | null; fit_score: number | null; next_action: string | null }[]
  stale_leads: { id: number; company: string | null; stage: string; updated_at: string }[]
  overdue: { count: number; total_claim_cents: number; worst_days: number }
}

const today = () => new Date().toISOString().slice(0, 10)

export function gatherFacts(): DigestFacts {
  const t = today()
  const new_leads = (db.prepare("SELECT COUNT(*) AS n FROM leads WHERE stage = 'neu'").get() as { n: number }).n

  const hot_leads = db
    .prepare(
      `SELECT l.id, l.company, a.fit_score, a.next_action
         FROM lead_ai a JOIN leads l ON l.id = a.lead_id
        WHERE a.qualification = 'hot' AND l.stage NOT IN ('gewonnen','verloren')
        ORDER BY a.fit_score DESC LIMIT 15`,
    )
    .all() as unknown as DigestFacts['hot_leads']

  // "Stale": actively-worked leads untouched for 7+ days.
  const stale_leads = db
    .prepare(
      `SELECT id, company, stage, updated_at FROM leads
        WHERE stage IN ('kontaktiert','interessiert','angebot')
          AND julianday(?) - julianday(updated_at) >= 7
        ORDER BY updated_at ASC LIMIT 15`,
    )
    .all(t) as unknown as DigestFacts['stale_leads']

  const overdueList = listOverdue(t)
  const overdue = {
    count: overdueList.length,
    total_claim_cents: overdueList.reduce((s, o) => s + o.total_claim_cents, 0),
    worst_days: overdueList.reduce((m, o) => Math.max(m, o.days_overdue), 0),
  }

  return { new_leads, hot_leads, stale_leads, overdue }
}

export interface DigestPriority {
  title: string
  why: string
  action: string
}

export interface Digest {
  facts: DigestFacts
  headline: string
  priorities: DigestPriority[]
  ai: boolean
}

const DIGEST_SYSTEM = `
Du bist Vertriebs-Coach für OpenLeads. Du bekommst Kennzahlen des Tages und
erstellst ein kurzes Tages-Briefing. Antworte AUSSCHLIESSLICH mit JSON:
{ "headline": string, "priorities": [ { "title": string, "why": string, "action": string } ] }
Maximal 5 Prioritäten, die wichtigste zuerst. Konkret, auf Deutsch, ableitbar
aus den Zahlen (überfällige Rechnungen zuerst).
${COMPLIANCE_GUARDRAILS}
`.trim()

/** Deterministic fallback so the digest is useful even without a model. */
function fallbackPriorities(f: DigestFacts): DigestPriority[] {
  const p: DigestPriority[] = []
  if (f.overdue.count > 0)
    p.push({
      title: `${f.overdue.count} überfällige Rechnung(en)`,
      why: `Bis zu ${f.overdue.worst_days} Tage überfällig.`,
      action: 'Mahnungen prüfen und erstellen.',
    })
  if (f.hot_leads.length > 0)
    p.push({
      title: `${f.hot_leads.length} heiße Leads`,
      why: 'Von der KI als „hot" qualifiziert.',
      action: 'Empfohlene nächste Schritte umsetzen.',
    })
  if (f.stale_leads.length > 0)
    p.push({
      title: `${f.stale_leads.length} liegengebliebene Leads`,
      why: 'Seit 7+ Tagen ohne Bewegung.',
      action: 'Status aktualisieren oder nachfassen.',
    })
  if (f.new_leads > 0)
    p.push({ title: `${f.new_leads} neue Leads`, why: 'Noch nicht qualifiziert.', action: 'Qualifizieren und einsortieren.' })
  return p.slice(0, 5)
}

export async function buildDigest(): Promise<Digest> {
  const facts = gatherFacts()
  try {
    const r = await chatJSON<{ headline: string; priorities: DigestPriority[] }>(
      DIGEST_SYSTEM,
      `Kennzahlen heute (${today()}):\n${JSON.stringify(facts, null, 2)}`,
      { temperature: 0.3, maxTokens: 700 },
    )
    const priorities = Array.isArray(r.priorities) && r.priorities.length ? r.priorities.slice(0, 5) : fallbackPriorities(facts)
    return { facts, headline: r.headline || 'Tages-Briefing', priorities, ai: true }
  } catch {
    return {
      facts,
      headline: `Tages-Briefing — ${facts.overdue.count} überfällig`,
      priorities: fallbackPriorities(facts),
      ai: false,
    }
  }
}
