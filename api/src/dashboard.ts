import { db } from './db'
import { finalisedInvoices } from './export'

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
    open_total_cents: number // issued, not storniert, still owed
    overdue_count: number
    overdue_total_cents: number
  }
  revenue_by_month: MonthRevenue[] // last 12 calendar months, oldest first
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
    if (inv.status !== 'storniert') openTotal += outstanding
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

  return {
    leads: { total, open, won, lost, by_stage: byStage, conversion_pct: conversion },
    invoices: {
      issued: issued.length,
      drafts,
      gross_total_cents: grossTotal,
      paid_total_cents: paidTotal,
      open_total_cents: openTotal,
      overdue_count: overdueCount,
      overdue_total_cents: overdueTotal,
    },
    revenue_by_month: [...months.values()],
  }
}
