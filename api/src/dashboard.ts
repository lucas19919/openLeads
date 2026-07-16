import { db } from './db'
import { finalisedInvoices } from './export'
import { expenseSummary } from './expenses'

// Read-only KPIs for the Übersicht (dashboard). Everything is derived from the
// existing tables — no new state — so it always reflects the live data.

export interface MonthRevenue {
  month: string // YYYY-MM
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
    conversion_pct: number // won / (won + lost)
  }
  invoices: {
    issued: number
    drafts: number
    gross_total_cents: number
    paid_total_cents: number
    net_total_cents: number // issued, not storniert (basis for the result figure)
    open_total_cents: number // issued, not storniert, still owed
    overdue_count: number
    overdue_total_cents: number
  }
  expenses: {
    count: number
    gross_total_cents: number
    net_total_cents: number
    vat_total_cents: number // total Vorsteuer
    ytd_gross_cents: number // current calendar year
  }
  contracts: {
    active: number
    drafts: number
    active_value_cents: number // sum of net Auftragswert of active contracts
    expiring_soon: ExpiringContract[] // active/sent contracts ending within 60 days
  }
  // Rough operating result: net revenue (issued, not storniert) − net expenses.
  // Net so VAT/Vorsteuer (a pass-through) doesn't distort it; clearly a guideline,
  // not a P&L (no depreciation, accruals, private shares, …).
  result: { net_cents: number }
  revenue_by_month: MonthRevenue[] // last 12 calendar months, oldest first
}

export interface ExpiringContract {
  id: number
  number: string | null
  title: string | null
  client_name: string | null
  end_date: string | null
  notice_period: string | null
}

const TERMINAL = new Set(['gewonnen', 'verloren'])

function lastMonths(today: string, n: number): string[] {
  const [y, m] = today.split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

export function buildDashboard(today: string = new Date().toISOString().slice(0, 10)): Dashboard {
  // --- leads ---
  const byStage = db
    .prepare('SELECT stage, COUNT(*) AS n FROM leads GROUP BY stage')
    .all() as unknown as { stage: string; n: number }[]
  const total = byStage.reduce((s, r) => s + r.n, 0)
  const won = byStage.find((r) => r.stage === 'gewonnen')?.n ?? 0
  const lost = byStage.find((r) => r.stage === 'verloren')?.n ?? 0
  const open = byStage.filter((r) => !TERMINAL.has(r.stage)).reduce((s, r) => s + r.n, 0)
  const conversion = won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0

  // --- invoices (issued = has a number) ---
  const issued = finalisedInvoices()
  const drafts = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind = 'rechnung' AND number IS NULL").get() as { n: number }).n,
  )
  let grossTotal = 0
  let paidTotal = 0
  let netTotal = 0
  let openTotal = 0
  let overdueCount = 0
  let overdueTotal = 0
  const months = new Map<string, MonthRevenue>()
  for (const m of lastMonths(today, 12)) months.set(m, { month: m, net_cents: 0, gross_cents: 0, count: 0 })

  for (const inv of issued) {
    const gross = inv.totals.gross_cents
    const outstanding = Math.max(0, gross - inv.paid_cents)
    grossTotal += gross
    paidTotal += inv.paid_cents
    // Neither cancelled originals nor their Stornorechnungen are receivables or
    // net revenue — the pair must cancel out, not count −X once.
    if (inv.status !== 'storniert' && inv.corrects_document_id == null) {
      openTotal += outstanding
      netTotal += inv.totals.net_cents
    }
    if (inv.status === 'versendet' && outstanding > 0 && inv.due_date && inv.due_date < today) {
      overdueCount++
      overdueTotal += outstanding
    }
    const bucket = inv.issue_date ? months.get(inv.issue_date.slice(0, 7)) : undefined
    if (bucket) {
      bucket.net_cents += inv.totals.net_cents
      bucket.gross_cents += gross
      bucket.count++
    }
  }

  // --- expenses (Ausgaben) ---
  const exAll = expenseSummary()
  const exYtd = expenseSummary({ from: `${today.slice(0, 4)}-01-01`, to: today })

  // --- contracts ---
  const active = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE status = 'aktiv'").get() as { n: number }).n,
  )
  const contractDrafts = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM contracts WHERE status = 'entwurf'").get() as { n: number }).n,
  )
  const activeValue = Number(
    (db.prepare("SELECT COALESCE(SUM(value_cents), 0) AS v FROM contracts WHERE status = 'aktiv'").get() as { v: number }).v,
  )
  // Contracts ending within 60 days (a renewal/notice nudge). Both still-running
  // statuses count; soonest first.
  const cutoff = new Date(Date.parse(today) + 60 * 86_400_000).toISOString().slice(0, 10)
  const expiring = db
    .prepare(
      `SELECT id, number, title, client_name, end_date, notice_period
         FROM contracts
        WHERE status IN ('aktiv','versendet') AND end_date IS NOT NULL
          AND end_date >= ? AND end_date <= ?
        ORDER BY end_date ASC, id ASC
        LIMIT 8`,
    )
    .all(today, cutoff) as unknown as ExpiringContract[]

  return {
    leads: { total, open, won, lost, by_stage: byStage, conversion_pct: conversion },
    invoices: {
      issued: issued.length,
      drafts,
      gross_total_cents: grossTotal,
      paid_total_cents: paidTotal,
      net_total_cents: netTotal,
      open_total_cents: openTotal,
      overdue_count: overdueCount,
      overdue_total_cents: overdueTotal,
    },
    expenses: {
      count: exAll.count,
      gross_total_cents: exAll.gross_cents,
      net_total_cents: exAll.net_cents,
      vat_total_cents: exAll.vat_cents,
      ytd_gross_cents: exYtd.gross_cents,
    },
    contracts: {
      active,
      drafts: contractDrafts,
      active_value_cents: activeValue,
      expiring_soon: expiring,
    },
    result: { net_cents: netTotal - exAll.net_cents },
    revenue_by_month: [...months.values()],
  }
}
