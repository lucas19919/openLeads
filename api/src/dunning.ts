import { db, type SettingsRow } from './db'
import { getDocument, getSettings, type FullDocument } from './documents'

// Mahnwesen (dunning) for overdue invoices, with §288 BGB Verzugszinsen.
//
// For B2B (this product's audience), the statutory default interest rate is the
// Basiszinssatz + 9 percentage points (§288 Abs. 2 BGB), and a €40 flat
// Verzugspauschale may be claimed (§288 Abs. 5 BGB). The Basiszinssatz changes
// twice a year, so it lives in settings (`verzug_base_rate`).

export const VERZUG_PAUSCHALE_CENTS = 4000 // €40, §288(5) BGB (B2B)

const DAY = 86_400_000

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso)
  const b = Date.parse(toIso)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.floor((b - a) / DAY)
}

/** Suggested escalation from how long an invoice has been overdue. */
export function suggestedLevel(daysOverdue: number): number {
  if (daysOverdue <= 0) return 0
  if (daysOverdue <= 10) return 0 // friendly Zahlungserinnerung
  if (daysOverdue <= 24) return 1 // 1. Mahnung
  if (daysOverdue <= 40) return 2 // 2. Mahnung
  return 3 // letzte Mahnung / Inkasso/Mahnbescheid
}

export const LEVEL_LABEL = ['Zahlungserinnerung', '1. Mahnung', '2. Mahnung', 'Letzte Mahnung']

export function levelLabel(level: number): string {
  return LEVEL_LABEL[level] ?? `${level}. Mahnung`
}

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

/**
 * Compute the dunning position for an invoice as of `today` (default now).
 * Interest accrues on the gross from the day after the due date. No interest or
 * pauschale at level 0 (a courtesy reminder), matching common practice.
 */
export function computeDunning(
  doc: FullDocument,
  s: SettingsRow,
  level?: number,
  today: string = new Date().toISOString().slice(0, 10),
): DunningComputation {
  const gross = doc.totals.gross_cents
  const daysOverdue = doc.due_date ? Math.max(0, daysBetween(doc.due_date, today)) : 0
  const lvl = level ?? suggestedLevel(daysOverdue)
  const ratePercent = s.verzug_base_rate + 9 // §288(2) BGB, B2B

  let interest = 0
  let pauschale = 0
  if (lvl >= 1 && daysOverdue > 0) {
    interest = Math.round((gross * ratePercent * daysOverdue) / (100 * 365))
    pauschale = VERZUG_PAUSCHALE_CENTS
  }
  return {
    document_id: doc.id,
    number: doc.number,
    client_name: doc.client_name,
    gross_cents: gross,
    issue_date: doc.issue_date,
    due_date: doc.due_date,
    days_overdue: daysOverdue,
    suggested_level: lvl,
    interest_rate_percent: ratePercent,
    interest_cents: interest,
    pauschale_cents: pauschale,
    total_claim_cents: gross + interest + pauschale,
  }
}

/** All invoices that are sent, unpaid, and past their due date. */
export function listOverdue(today: string = new Date().toISOString().slice(0, 10)): DunningComputation[] {
  const rows = db
    .prepare(
      `SELECT id FROM documents
        WHERE kind = 'rechnung' AND status = 'versendet'
          AND due_date IS NOT NULL AND due_date < ?
        ORDER BY due_date ASC`,
    )
    .all(today) as unknown as { id: number }[]
  const s = getSettings()
  return rows
    .map((r) => getDocument(r.id))
    .filter((d): d is FullDocument => d !== null)
    .map((d) => computeDunning(d, s, undefined, today))
}
