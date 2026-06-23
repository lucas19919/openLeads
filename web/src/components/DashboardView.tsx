import { useEffect, useState } from 'react'
import { api } from '../api'
import { euro } from '../money'
import type { Config, Dashboard } from '../types'
import type { Module } from './SuiteNav'

const MONTH_LABEL = (m: string) => {
  const [y, mm] = m.split('-')
  return `${mm}/${y.slice(2)}`
}

export function DashboardView({
  config,
  onNavigate,
}: {
  config: Config
  onNavigate: (m: Module) => void
}) {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .dashboard()
      .then(({ dashboard }) => setData(dashboard))
      .catch((e) => setError(e instanceof Error ? e.message : 'Laden fehlgeschlagen.'))
  }, [])

  if (error) return <div className="content section-error">{error}</div>
  if (!data) return <div className="content center-muted">Lädt…</div>

  const maxRevenue = Math.max(1, ...data.revenue_by_month.map((m) => m.gross_cents))
  const stageOrder = config.stages
  const stageCounts = new Map(data.leads.by_stage.map((s) => [s.stage, s.n]))
  const maxStage = Math.max(1, ...data.leads.by_stage.map((s) => s.n))

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Übersicht</span>
        <div className="spacer" />
        <span className="user-chip">Live aus deinen Daten</span>
      </div>

      <div className="content">
        <div className="dash-cards">
          <button className="dash-card dash-clickable" onClick={() => onNavigate('mahnungen')}>
            <span className="dash-card-label">Offene Forderungen</span>
            <span className="dash-card-value">{euro(data.invoices.open_total_cents)}</span>
            <span className="dash-card-sub">{data.invoices.issued} ausgestellte Rechnungen</span>
          </button>

          <button className="dash-card dash-clickable" onClick={() => onNavigate('mahnungen')}>
            <span className="dash-card-label">Überfällig</span>
            <span className="dash-card-value" style={{ color: data.invoices.overdue_count ? 'var(--danger)' : 'var(--text)' }}>
              {euro(data.invoices.overdue_total_cents)}
            </span>
            <span className="dash-card-sub">{data.invoices.overdue_count} Rechnung(en) über Frist</span>
          </button>

          <div className="dash-card">
            <span className="dash-card-label">Umsatz ausgestellt</span>
            <span className="dash-card-value">{euro(data.invoices.gross_total_cents)}</span>
            <span className="dash-card-sub">davon {euro(data.invoices.paid_total_cents)} bezahlt</span>
          </div>

          <button className="dash-card dash-clickable" onClick={() => onNavigate('expenses')}>
            <span className="dash-card-label">Ausgaben</span>
            <span className="dash-card-value">{euro(data.expenses.gross_total_cents)}</span>
            <span className="dash-card-sub">
              {euro(data.expenses.ytd_gross_cents)} im Jahr · {data.expenses.count} Belege
            </span>
          </button>

          <div className="dash-card">
            <span className="dash-card-label">Ergebnis (Netto)</span>
            <span
              className="dash-card-value"
              style={{ color: data.result.net_cents < 0 ? 'var(--danger)' : 'var(--ok)' }}
            >
              {euro(data.result.net_cents)}
            </span>
            <span className="dash-card-sub">Umsatz netto − Ausgaben netto</span>
          </div>

          <button className="dash-card dash-clickable" onClick={() => onNavigate('leads')}>
            <span className="dash-card-label">Offene Leads</span>
            <span className="dash-card-value">{data.leads.open}</span>
            <span className="dash-card-sub">{data.leads.total} insgesamt</span>
          </button>

          <div className="dash-card">
            <span className="dash-card-label">Conversion</span>
            <span className="dash-card-value">{data.leads.conversion_pct}%</span>
            <span className="dash-card-sub">
              {data.leads.won} gewonnen · {data.leads.lost} verloren
            </span>
          </div>

          <button className="dash-card dash-clickable" onClick={() => onNavigate('documents')}>
            <span className="dash-card-label">Entwürfe</span>
            <span className="dash-card-value">{data.invoices.drafts}</span>
            <span className="dash-card-sub">offene Rechnungsentwürfe</span>
          </button>
        </div>

        <div className="dash-row2">
          <fieldset className="doc-block">
            <legend>Umsatz (12 Monate)</legend>
            {data.revenue_by_month.every((m) => m.gross_cents === 0) ? (
              <div className="center-muted" style={{ padding: 16 }}>Noch kein ausgestellter Umsatz.</div>
            ) : (
              <div className="dash-bars">
                {data.revenue_by_month.map((m) => (
                  <div className="dash-bar-row" key={m.month}>
                    <span className="dash-bar-label">{MONTH_LABEL(m.month)}</span>
                    <div className="dash-bar-track">
                      <div
                        className="dash-bar-fill"
                        style={{ width: `${Math.round((m.gross_cents / maxRevenue) * 100)}%` }}
                      />
                    </div>
                    <span className="dash-bar-value">{m.gross_cents ? euro(m.gross_cents) : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="doc-block">
            <legend>Pipeline</legend>
            <div className="dash-bars">
              {stageOrder.map((stage) => {
                const n = stageCounts.get(stage) ?? 0
                return (
                  <div className="dash-bar-row" key={stage}>
                    <span className="dash-bar-label dash-bar-label-stage">{stage}</span>
                    <div className="dash-bar-track">
                      <div
                        className="dash-bar-fill dash-bar-stage"
                        style={{ width: `${Math.round((n / maxStage) * 100)}%` }}
                      />
                    </div>
                    <span className="dash-bar-value">{n}</span>
                  </div>
                )
              })}
            </div>
          </fieldset>
        </div>
      </div>
    </>
  )
}
