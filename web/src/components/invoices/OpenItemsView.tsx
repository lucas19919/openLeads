import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { DunningComputation } from '../../types'

/** Mahnstufen-Bezeichnung nach Eskalationsstufe. */
const MAHNSTUFE_LABEL = [
  'Zahlungserinnerung',
  '1. Mahnung',
  '2. Mahnung',
  'Letzte Mahnung',
] as const

function mahnstufeLabel(level: number): string {
  return MAHNSTUFE_LABEL[level] ?? `Stufe ${level}`
}

type RowState = {
  busy?: boolean
  done?: { label: string; total_claim_cents: number; historyCount: number }
  error?: string
}

export function OpenItemsView() {
  const [overdue, setOverdue] = useState<DunningComputation[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<number, RowState>>({})

  const load = useCallback(async () => {
    setLoadError(null)
    setOverdue(null)
    try {
      const { overdue } = await api.overdueInvoices()
      setOverdue(overdue)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Offene Posten konnten nicht geladen werden.')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function raise(c: DunningComputation) {
    setRows((r) => ({ ...r, [c.document_id]: { busy: true } }))
    try {
      const { mahnung, computation, label } = await api.raiseDunning(c.document_id)
      // Verlauf für die History-Anzeige nachladen (best effort).
      let historyCount = 1
      try {
        const { history } = await api.previewDunning(c.document_id)
        historyCount = history.length
      } catch {
        historyCount = mahnung.level + 1
      }
      setRows((r) => ({
        ...r,
        [c.document_id]: {
          done: {
            label,
            total_claim_cents: computation.total_claim_cents,
            historyCount,
          },
        },
      }))
    } catch (e) {
      setRows((r) => ({
        ...r,
        [c.document_id]: {
          error: e instanceof Error ? e.message : 'Mahnung konnte nicht erstellt werden.',
        },
      }))
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Offene Posten</span>
        {overdue && (
          <span className="user-chip">
            {overdue.length} {overdue.length === 1 ? 'überfällige Rechnung' : 'überfällige Rechnungen'}
          </span>
        )}
        <div className="spacer" />
        <button onClick={load}>Aktualisieren</button>
      </div>

      <div className="content">
        <div className="dunning-legend">
          Verzugszinsen nach <strong>§ 288 BGB</strong> (Basiszinssatz + 9 Prozentpunkte bei B2B-Geschäften)
          zzgl. <strong>40 € Pauschale</strong> je überfälliger Forderung. Beträge sind Richtwerte —
          bitte vor dem Versand prüfen.
        </div>

        {loadError ? (
          <div className="section-error">
            {loadError}{' '}
            <button className="ghost" onClick={load}>
              Erneut versuchen
            </button>
          </div>
        ) : overdue === null ? (
          <div className="center-muted">Lädt…</div>
        ) : overdue.length === 0 ? (
          <div className="center-muted">Keine offenen Posten — alles bezahlt 🎉</div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Nr.</th>
                  <th>Kunde</th>
                  <th>fällig seit</th>
                  <th className="num">Tage überfällig</th>
                  <th className="num">Betrag</th>
                  <th className="num">Verzugszins</th>
                  <th className="num">+ Pauschale</th>
                  <th className="num">Gesamtforderung</th>
                  <th>Mahnstufe</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {overdue.map((c) => {
                  const state = rows[c.document_id] ?? {}
                  return (
                    <tr key={c.document_id}>
                      <td className="no-x">{c.number ?? <em style={{ color: 'var(--muted)' }}>—</em>}</td>
                      <td>{c.client_name ?? '—'}</td>
                      <td>{c.due_date ? fmtDate(c.due_date) : '—'}</td>
                      <td className="num">{c.days_overdue}</td>
                      <td className="num">{euro(c.gross_cents)}</td>
                      <td className="num">
                        {euro(c.interest_cents)}
                        <span className="dunning-rate"> ({c.interest_rate_percent.toLocaleString('de-DE')} %)</span>
                      </td>
                      <td className="num">{euro(c.pauschale_cents)}</td>
                      <td className="num">
                        <strong>{euro(c.total_claim_cents)}</strong>
                      </td>
                      <td>
                        <span className="doc-status">{mahnstufeLabel(c.suggested_level)}</span>
                      </td>
                      <td className="dunning-actions">
                        <a
                          className="ghost-link"
                          href={api.pdfUrl(c.document_id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          PDF
                        </a>
                        {state.done ? (
                          <span className="dunning-done" title={`${state.done.historyCount} Mahnung(en) im Verlauf`}>
                            ✓ {state.done.label} erstellt — Gesamtforderung {euro(state.done.total_claim_cents)}
                            {' · '}
                            {state.done.historyCount} im Verlauf
                          </span>
                        ) : (
                          <button
                            className="primary"
                            disabled={state.busy}
                            onClick={() => raise(c)}
                          >
                            {state.busy ? '…' : 'Mahnung erstellen'}
                          </button>
                        )}
                        {state.error && <span className="dunning-error">{state.error}</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
