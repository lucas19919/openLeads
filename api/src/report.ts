import { db, EXPENSE_CATEGORIES } from './db'
import { finalisedInvoices } from './export'
import { getSettings } from './documents'

// In-app financial report: an Einnahmenüberschussrechnung-style (EÜR) view for a
// date range, derived from the existing finalised invoices (revenue) and expenses
// (costs) — no new state. Revenue is recognised by issue date; expenses by
// Belegdatum. It also surfaces the VAT position (USt eingenommen − Vorsteuer =
// Zahllast), the figure behind the UStVA. Not tax advice — the Steuerberater
// verifies; this mirrors the DATEV/CSV exports as a human-readable overview.

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
  result_net_cents: number // revenue net − expenses net (the EÜR result)
  vat: { collected_cents: number; input_cents: number; payable_cents: number }
  small_business: boolean
}

export function buildEuer(from?: string, to?: string): EuerReport {
  // Revenue: finalised invoices in range. Cancelled originals AND their
  // Stornorechnungen are both excluded so a storno pair nets to zero.
  const invoices = finalisedInvoices(from, to).filter(
    (d) => d.status !== 'storniert' && d.corrects_document_id == null,
  )
  let rNet = 0
  let rVat = 0
  let rGross = 0
  for (const d of invoices) {
    rNet += d.totals.net_cents
    rVat += d.totals.vat_cents
    rGross += d.totals.gross_cents
  }

  // Expenses by category in range (Belegdatum).
  const clauses: string[] = []
  const params: string[] = []
  if (from) {
    clauses.push('expense_date >= ?')
    params.push(from)
  }
  if (to) {
    clauses.push('expense_date <= ?')
    params.push(to)
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db
    .prepare(
      `SELECT category,
              COUNT(*) AS n,
              COALESCE(SUM(net_cents), 0) AS net,
              COALESCE(SUM(vat_cents), 0) AS vat,
              COALESCE(SUM(gross_cents), 0) AS gross
         FROM expenses ${where}
        GROUP BY category`,
    )
    .all(...params) as unknown as { category: string; n: number; net: number; vat: number; gross: number }[]

  let eNet = 0
  let eVat = 0
  let eGross = 0
  let eCount = 0
  const by_category: EuerCategoryLine[] = rows
    .map((r) => {
      const def = EXPENSE_CATEGORIES.find((c) => c.id === r.category)
      eNet += r.net
      eVat += r.vat
      eGross += r.gross
      eCount += r.n
      return {
        category: r.category,
        label: def?.label ?? r.category,
        skr03: def?.skr03 ?? '',
        count: r.n,
        net_cents: r.net,
        vat_cents: r.vat,
        gross_cents: r.gross,
      }
    })
    .sort((a, b) => b.net_cents - a.net_cents)

  return {
    from: from ?? null,
    to: to ?? null,
    revenue: { net_cents: rNet, vat_cents: rVat, gross_cents: rGross, count: invoices.length },
    expenses: { net_cents: eNet, vat_cents: eVat, gross_cents: eGross, count: eCount, by_category },
    result_net_cents: rNet - eNet,
    vat: { collected_cents: rVat, input_cents: eVat, payable_cents: rVat - eVat },
    small_business: !!getSettings().small_business,
  }
}
