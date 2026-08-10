import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { euro } from '../money'
import { fmtDate } from '../util'
import type { Approval } from '../types'

// Freigaben — the inbox for everything an agent is not allowed to do alone.
//
// An assistant (the copilot, the MCP server, a suite agent) can draft an invoice
// down to the last cent, but Festschreiben spends a gapless number and freezes
// the document under GoBD, and Versenden puts it in a client's inbox. Neither
// happens until someone reads what is actually on the paper and clicks here.
//
// So the card shows the paper, not the request: recipient, every position, the
// gross total, and what exactly will happen. Approving from a summary that hides
// the numbers would be a rubber stamp with extra steps.

function actionLabel(a: Approval): string {
  return a.summary?.label ?? a.action
}

export function ApprovalsPanel({ onOpen }: { onOpen?: (a: Approval) => void }) {
  const [pending, setPending] = useState<Approval[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<Record<number, string>>({})

  const load = useCallback(() => {
    api
      .listApprovals({ status: 'offen' })
      .then(({ approvals }) => setPending(approvals))
      .catch((e) => setError(e instanceof Error ? e.message : 'Freigaben nicht ladbar.'))
  }, [])

  useEffect(load, [load])

  async function decide(a: Approval, approve: boolean) {
    setBusy(a.id)
    setError(null)
    try {
      if (approve) await api.approveApproval(a.id, note[a.id])
      else await api.rejectApproval(a.id, note[a.id])
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Entscheidung fehlgeschlagen.')
    } finally {
      setBusy(null)
    }
  }

  // Quiet when there is nothing to decide: this must never become furniture the
  // operator learns to scroll past.
  if (!pending || (pending.length === 0 && !error)) return null

  return (
    <div className="panel approvals-panel">
      <h2 className="panel-title">
        Freigaben
        <span className="approvals-count">{pending.length} offen</span>
      </h2>

      {error && <div className="section-error">{error}</div>}

      <p className="settings-hint">
        Ein Assistent hat das vorbereitet und wartet auf dich. Festschreiben vergibt eine
        fortlaufende Nummer und friert den Inhalt ein (GoBD); Versenden geht direkt an den Kunden.
        Beides lässt sich nicht zurücknehmen.
      </p>

      <ul className="approvals-list">
        {pending.map((a) => (
          <li key={a.id} className="approval-item">
            <div className="approval-head">
              <button
                className="approval-title"
                onClick={() => onOpen?.(a)}
                disabled={!onOpen}
                title={onOpen ? 'Dokument öffnen' : undefined}
              >
                {a.summary.title}
              </button>
              <span className="approval-amount">{euro(a.summary.gross_cents)}</span>
            </div>

            <div className="approval-meta">
              {actionLabel(a)} · beantragt von {a.requested_by} am{' '}
              {fmtDate(a.requested_at.slice(0, 10))} · gültig bis {fmtDate(a.expires_at.slice(0, 10))}
            </div>

            {a.summary.recipient && (
              <div className="approval-meta">
                An: {a.summary.recipient}
                {a.summary.recipient_email ? ` <${a.summary.recipient_email}>` : ''}
              </div>
            )}

            {a.reason && <div className="approval-reason">„{a.reason}"</div>}

            {a.summary.lines.length > 0 && (
              <ul className="approval-lines">
                {a.summary.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}

            {a.summary.warnings.map((w, i) => (
              <div key={i} className="approval-warn">
                {w}
              </div>
            ))}

            {a.content_unchanged === false && (
              <div className="section-error">
                Der Inhalt hat sich seit der Anfrage geändert. Bitte ablehnen — der Assistent kann
                mit dem neuen Stand erneut anfragen.
              </div>
            )}

            <div className="approval-actions">
              <input
                type="text"
                placeholder="Anmerkung (optional)"
                value={note[a.id] ?? ''}
                onChange={(e) => setNote((n) => ({ ...n, [a.id]: e.target.value }))}
              />
              <div className="spacer" />
              <button className="ghost" onClick={() => decide(a, false)} disabled={busy === a.id}>
                Ablehnen
              </button>
              <button
                className="primary"
                onClick={() => decide(a, true)}
                disabled={busy === a.id || a.content_unchanged === false}
              >
                {busy === a.id ? 'Moment…' : 'Freigeben'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
