import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Doc, Lead } from '../../types'
import { DocumentEditor } from './DocumentEditor'

const KIND_LABEL: Record<string, string> = { angebot: 'Angebot', rechnung: 'Rechnung' }

export function InvoicesView({
  config,
  prefillLead,
  onPrefillHandled,
}: {
  config: Config
  prefillLead: Lead | null
  onPrefillHandled: () => void
}) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [filter, setFilter] = useState<'all' | 'angebot' | 'rechnung'>('all')
  const [openId, setOpenId] = useState<number | null>(null)
  const [draftText, setDraftText] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { documents } = await api.listDocuments()
    setDocs(documents)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // A lead was sent over from the CRM → spin up a draft Angebot and open it.
  useEffect(() => {
    if (!prefillLead) return
    let active = true
    api
      .createDocument({
        kind: 'angebot',
        lead_id: prefillLead.id,
        client_name: prefillLead.company,
        client_city: prefillLead.city,
        client_email: prefillLead.email,
      })
      .then(({ document }) => {
        if (!active) return
        refresh()
        setOpenId(document.id)
      })
      .finally(() => onPrefillHandled())
    return () => {
      active = false
    }
  }, [prefillLead, refresh, onPrefillHandled])

  async function createNew(kind: 'angebot' | 'rechnung') {
    const { document } = await api.createDocument({ kind })
    await refresh()
    setOpenId(document.id)
  }

  async function generateDraft() {
    const text = draftText.trim()
    if (!text) return
    setDrafting(true)
    setDraftError(null)
    try {
      const { document } = await api.draftInvoice(text, { create: true })
      if (!document) {
        setDraftError('Es wurde kein Entwurf erstellt. Bitte Beschreibung präzisieren.')
        return
      }
      setDraftText('')
      await refresh()
      setOpenId(document.id)
    } catch (e) {
      setDraftError(e instanceof Error ? e.message : 'Entwurf konnte nicht erzeugt werden.')
    } finally {
      setDrafting(false)
    }
  }

  async function remove(id: number) {
    if (!confirm('Entwurf löschen?')) return
    try {
      await api.deleteDocument(id)
      refresh()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.')
    }
  }

  if (openId !== null) {
    return (
      <div className="content">
        <DocumentEditor
          id={openId}
          config={config}
          onClose={() => {
            setOpenId(null)
            refresh()
          }}
          onChanged={refresh}
        />
      </div>
    )
  }

  const visible = docs.filter((d) => filter === 'all' || d.kind === filter)

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Rechnungen &amp; Angebote</span>
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            Alle
          </button>
          <button className={filter === 'angebot' ? 'active' : ''} onClick={() => setFilter('angebot')}>
            Angebote
          </button>
          <button className={filter === 'rechnung' ? 'active' : ''} onClick={() => setFilter('rechnung')}>
            Rechnungen
          </button>
        </div>
        <span className="user-chip">{visible.length} Dokumente</span>
        <div className="spacer" />
        <button onClick={() => createNew('angebot')}>+ Angebot</button>
        <button className="primary" onClick={() => createNew('rechnung')}>
          + Rechnung
        </button>
      </div>

      <div className="content">
        <div className="ai-draft-box">
          <label className="ai-draft-label">KI-Rechnung aus Text</label>
          <textarea
            className="ai-draft-text"
            rows={3}
            value={draftText}
            disabled={drafting}
            placeholder="Beschreibe den Auftrag, z. B.: Rechnung an Müller GmbH, Berlin, für 8 Stunden Beratung à 95 € und Anfahrt pauschal 40 €."
            onChange={(e) => setDraftText(e.target.value)}
          />
          <div className="ai-draft-actions">
            <span className="ai-draft-hint">
              Beträge werden als Netto-Cent interpretiert — bitte vor dem Festschreiben prüfen.
            </span>
            <div className="spacer" />
            <button
              className="primary"
              onClick={generateDraft}
              disabled={drafting || !draftText.trim()}
            >
              {drafting ? '…' : 'Entwurf erzeugen'}
            </button>
          </div>
          {draftError && <div className="section-error">{draftError}</div>}
        </div>

        {visible.length === 0 ? (
          <div className="center-muted">
            Noch keine Dokumente. Lege ein Angebot oder eine Rechnung an — oder starte aus einem Lead
            heraus („Angebot / Rechnung erstellen").
          </div>
        ) : (
          <div className="table-wrap">
          <table className="leads">
            <thead>
              <tr>
                <th>Typ</th>
                <th>Nummer</th>
                <th>Empfänger</th>
                <th>Datum</th>
                <th>Fällig</th>
                <th>Status</th>
                <th className="num">Betrag</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => (
                <tr key={d.id} onClick={() => setOpenId(d.id)}>
                  <td>{KIND_LABEL[d.kind] ?? d.kind}</td>
                  <td className="no-x">{d.number ?? <em style={{ color: 'var(--muted)' }}>Entwurf</em>}</td>
                  <td>{d.client_name ?? '—'}</td>
                  <td>{fmtDate((d.issue_date ?? d.created_at).slice(0, 10))}</td>
                  <td>{d.due_date ? fmtDate(d.due_date) : '—'}</td>
                  <td>
                    <span className={`doc-status doc-status-${d.status}`}>{d.status}</span>
                  </td>
                  <td className="num">{euro(d.totals.gross_cents)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {!d.number && (
                      <button className="ghost" onClick={() => remove(d.id)} title="Entwurf löschen">
                        Löschen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </>
  )
}
