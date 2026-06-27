import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Subscription, SubscriptionSummary } from '../../types'
import { SubscriptionModal } from './SubscriptionModal'
import { ExpensesTabs, type ExpTab } from './ExpensesModule'

type Editing = 'new' | Subscription | null

const CADENCE_LABEL: Record<string, string> = {
  monatlich: 'monatlich',
  quartalsweise: 'quartalsweise',
  jährlich: 'jährlich',
}

export function SubscriptionsView({
  config,
  tab,
  onTab,
}: {
  config: Config
  tab: ExpTab
  onTab: (t: ExpTab) => void
}) {
  const [rows, setRows] = useState<Subscription[]>([])
  const [summary, setSummary] = useState<SubscriptionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)

  const catLabel = useMemo(() => {
    const m = new Map(config.expenseCategories.map((c) => [c.id, c.label]))
    return (id: string) => m.get(id) ?? id
  }, [config.expenseCategories])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { subscriptions, summary } = await api.listSubscriptions()
      setRows(subscriptions)
      setSummary(summary)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Abos konnten nicht geladen werden.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function remove(s: Subscription) {
    if (!confirm(`Abo „${s.vendor}" (${euro(s.amount_cents)}/${CADENCE_LABEL[s.cadence] ?? s.cadence}) löschen?`)) return
    try {
      await api.deleteSubscription(s.id)
      load()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
    }
  }

  async function toggleActive(s: Subscription) {
    try {
      await api.updateSubscription(s.id, { active: s.active ? 0 : 1 })
      load()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Aktualisieren fehlgeschlagen.')
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Ausgaben</span>
        <ExpensesTabs tab={tab} onTab={onTab} />
        {summary && <span className="user-chip">{summary.active_count} aktiv</span>}
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>
          + Abo
        </button>
      </div>

      <div className="content">
        {summary && (
          <div className="dash-cards">
            <div className="dash-card">
              <span className="dash-card-label">Pro Monat</span>
              <span className="dash-card-value">{euro(summary.monthly_cents)}</span>
              <span className="dash-card-sub">laufende Kosten (aktiv)</span>
            </div>
            <div className="dash-card">
              <span className="dash-card-label">Pro Jahr</span>
              <span className="dash-card-value">{euro(summary.yearly_cents)}</span>
              <span className="dash-card-sub">Hochrechnung</span>
            </div>
            <div className="dash-card">
              <span className="dash-card-label">Aktive Abos</span>
              <span className="dash-card-value">{summary.active_count}</span>
              <span className="dash-card-sub">{summary.count} insgesamt</span>
            </div>
            <div className="dash-card">
              <span className="dash-card-label">Größte Kategorie</span>
              <span className="dash-card-value" style={{ fontSize: 18 }}>
                {summary.by_category[0] ? catLabel(summary.by_category[0].category) : '—'}
              </span>
              <span className="dash-card-sub">
                {summary.by_category[0]
                  ? `${euro(summary.by_category[0].monthly_cents)} / Monat`
                  : 'noch nichts erfasst'}
              </span>
            </div>
          </div>
        )}

        {summary && summary.upcoming.length > 0 && (
          <div className="section-info">
            Demnächst fällig:{' '}
            {summary.upcoming
              .slice(0, 5)
              .map((u) => `${u.vendor} (${fmtDate(u.next_renewal)}, ${euro(u.amount_cents)})`)
              .join(' · ')}
          </div>
        )}

        {error ? (
          <div className="section-error">
            {error} <button className="ghost" onClick={load}>Erneut versuchen</button>
          </div>
        ) : loading ? (
          <div className="center-muted">Lädt…</div>
        ) : rows.length === 0 ? (
          <div className="center-muted">
            Noch keine Abos erfasst. Lege deine laufenden Abonnements an (z. B. Claude, Hosting,
            Versicherung), um den monatlichen Fixkostenblock im Blick zu behalten.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Anbieter</th>
                  <th>Kategorie</th>
                  <th>Turnus</th>
                  <th className="num">Betrag</th>
                  <th className="num">/ Monat</th>
                  <th>Nächste Verl.</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} onClick={() => setEditing(s)} style={{ opacity: s.active ? 1 : 0.55 }}>
                    <td data-label="Anbieter" className="no-x cell-primary">
                      {s.vendor}
                      {s.description && <div className="expense-desc">{s.description}</div>}
                    </td>
                    <td data-label="Kategorie">
                      <span className="doc-status">{catLabel(s.category)}</span>
                    </td>
                    <td data-label="Turnus">{CADENCE_LABEL[s.cadence] ?? s.cadence}</td>
                    <td data-label="Betrag" className="num"><strong>{euro(s.amount_cents)}</strong></td>
                    <td data-label="/ Monat" className="num">{euro(s.monthly_cents)}</td>
                    <td data-label="Nächste Verl.">{s.next_renewal ? fmtDate(s.next_renewal) : '—'}</td>
                    <td data-label="Status" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        className="ghost"
                        onClick={() => toggleActive(s)}
                        title={s.active ? 'Auf inaktiv setzen' : 'Auf aktiv setzen'}
                      >
                        {s.active ? 'aktiv' : 'inaktiv'}
                      </button>
                    </td>
                    <td data-label="" onClick={(ev) => ev.stopPropagation()}>
                      <button className="ghost" onClick={() => remove(s)} title="Abo löschen">
                        Löschen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="expense-disclaimer">
          Abos sind eine vorausschauende Kostenübersicht — keine Buchung. Wenn ein Abo tatsächlich
          abgebucht wird, erfasse den Beleg unter „Belege", damit er im Journal/DATEV-Export erscheint.
        </div>
      </div>

      {editing !== null && (
        <SubscriptionModal
          config={config}
          subscription={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            load()
          }}
        />
      )}
    </>
  )
}
