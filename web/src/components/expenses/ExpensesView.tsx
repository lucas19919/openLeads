import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Expense, ExpenseSummary } from '../../types'
import { ExpenseModal } from './ExpenseModal'
import { ExpensesTabs, type ExpTab } from './ExpensesModule'

type Editing = 'new' | Expense | null

export function ExpensesView({
  config,
  tab,
  onTab,
}: {
  config: Config
  tab: ExpTab
  onTab: (t: ExpTab) => void
}) {
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [summary, setSummary] = useState<ExpenseSummary | null>(null)
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)

  // Category id → label, for the table + breakdown.
  const catLabel = useMemo(() => {
    const m = new Map(config.expenseCategories.map((c) => [c.id, c.label]))
    return (id: string) => m.get(id) ?? id
  }, [config.expenseCategories])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { expenses, summary } = await api.listExpenses({
        category: category || undefined,
        q: q.trim() || undefined,
        from: from || undefined,
        to: to || undefined,
      })
      setExpenses(expenses)
      setSummary(summary)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ausgaben konnten nicht geladen werden.')
    } finally {
      setLoading(false)
    }
  }, [category, q, from, to])

  useEffect(() => {
    load()
  }, [load])

  async function remove(e: Expense) {
    if (!confirm(`Ausgabe „${e.vendor ?? catLabel(e.category)}" (${euro(e.gross_cents)}) löschen?`)) return
    try {
      await api.deleteExpense(e.id)
      load()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Löschen fehlgeschlagen.')
    }
  }

  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">Ausgaben</h1>
        <ExpensesTabs tab={tab} onTab={onTab} />
        <input
          className="search"
          placeholder="Suche Lieferant / Beschreibung…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Alle Kategorien</option>
          {config.expenseCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        {summary && <span className="user-chip">{summary.count} Belege</span>}
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing('new')}>
          + Ausgabe
        </button>
      </div>

      <div className="content">
        {summary && (
          <div className="dash-cards">
            <div className="dash-card">
              <span className="dash-card-label">Ausgaben (brutto)</span>
              <span className="dash-card-value">{euro(summary.gross_cents)}</span>
              <span className="dash-card-sub">{summary.count} Belege</span>
            </div>
            <div className="dash-card">
              <span className="dash-card-label">Netto</span>
              <span className="dash-card-value">{euro(summary.net_cents)}</span>
              <span className="dash-card-sub">ohne Umsatzsteuer</span>
            </div>
            <div className="dash-card">
              <span className="dash-card-label">Vorsteuer</span>
              <span className="dash-card-value">{euro(summary.vat_cents)}</span>
              <span className="dash-card-sub">abziehbare USt</span>
            </div>
            <div className="dash-card">
              <span className="dash-card-label">Größte Kategorie</span>
              <span className="dash-card-value" style={{ fontSize: 18 }}>
                {summary.by_category[0] ? catLabel(summary.by_category[0].category) : '—'}
              </span>
              <span className="dash-card-sub">
                {summary.by_category[0] ? euro(summary.by_category[0].gross_cents) : 'noch nichts erfasst'}
              </span>
            </div>
          </div>
        )}

        <div className="expense-filterbar">
          <label>
            Zeitraum
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            <span>–</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {(from || to) && (
            <button
              className="ghost"
              onClick={() => {
                setFrom('')
                setTo('')
              }}
            >
              Zurücksetzen
            </button>
          )}
          <div className="spacer" />
          <a className="chip" href={api.exportExpensesUrl(from || undefined, to || undefined)}>
            Journal (CSV)
          </a>
          <a className="chip" href={api.exportExpensesDatevUrl(from || undefined, to || undefined)}>
            DATEV (CSV)
          </a>
        </div>

        {error ? (
          <div className="section-error">
            {error} <button className="ghost" onClick={load}>Erneut versuchen</button>
          </div>
        ) : loading ? (
          <div className="center-muted">Lädt…</div>
        ) : expenses.length === 0 ? (
          <div className="center-muted">
            Noch keine Ausgaben erfasst. Lade einen Beleg hoch und trage Betrag, Datum und Kategorie ein.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Datum</th>
                  <th>Lieferant</th>
                  <th>Kategorie</th>
                  <th className="num">Netto</th>
                  <th className="num">USt</th>
                  <th className="num">Brutto</th>
                  <th>Beleg</th>
                  <th>Bezahlt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {expenses.map((e) => (
                  <tr key={e.id} onClick={() => setEditing(e)}>
                    <td data-label="Datum" className="no-x cell-primary">{fmtDate(e.expense_date)}</td>
                    <td data-label="Lieferant">
                      {e.vendor ?? <em style={{ color: 'var(--muted)' }}>—</em>}
                      {e.description && <div className="expense-desc">{e.description}</div>}
                    </td>
                    <td data-label="Kategorie">
                      <span className="doc-status">{catLabel(e.category)}</span>
                    </td>
                    <td data-label="Netto" className="num">{euro(e.net_cents)}</td>
                    <td data-label="USt" className="num">
                      {e.vat_cents ? euro(e.vat_cents) : '—'}
                      {e.vat_cents > 0 && <span className="dunning-rate"> ({e.vat_rate}%)</span>}
                    </td>
                    <td data-label="Brutto" className="num"><strong>{euro(e.gross_cents)}</strong></td>
                    <td data-label="Beleg" onClick={(ev) => ev.stopPropagation()}>
                      {e.has_receipt ? (
                        <a className="ghost-link" href={api.receiptUrl(e.id)} target="_blank" rel="noreferrer">
                          📎 ansehen
                        </a>
                      ) : (
                        <span style={{ color: 'var(--muted)' }}>—</span>
                      )}
                    </td>
                    <td data-label="Bezahlt">
                      {e.paid_on ? (
                        fmtDate(e.paid_on)
                      ) : (
                        <span className="doc-status doc-status-offen" title="Noch nicht als bezahlt markiert">offen</span>
                      )}
                    </td>
                    <td data-label="" onClick={(ev) => ev.stopPropagation()}>
                      <button className="ghost" onClick={() => remove(e)} title="Ausgabe löschen">
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
          Beträge sind Brutto erfasst; Netto und Vorsteuer werden aus dem USt-Satz herausgerechnet.
          Die Kategorie bestimmt das SKR03-Aufwandskonto im DATEV-Export — bitte mit dem Steuerberater
          abstimmen. Dies ist keine Steuerberatung.
        </div>
      </div>

      {editing !== null && (
        <ExpenseModal
          config={config}
          expense={editing === 'new' ? null : editing}
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
