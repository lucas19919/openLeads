import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { getActiveCustomers } from '../../customersCache'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Doc } from '../../types'
import type { ModuleIntent } from '../SuiteNav'
import { DocumentEditor } from './DocumentEditor'

const KIND_LABEL: Record<string, string> = { angebot: 'Angebot', rechnung: 'Rechnung' }

type DocIntent = Extract<NonNullable<ModuleIntent>, { module: 'documents' }>

export function InvoicesView({
  config,
  intent,
  onIntentConsumed,
  onIntent,
}: {
  config: Config
  intent: DocIntent | null
  onIntentConsumed: () => void
  onIntent: (intent: ModuleIntent) => void
}) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [loaded, setLoaded] = useState(false)
  const [filter, setFilter] = useState<'all' | 'angebot' | 'rechnung'>('all')
  const [filterCustomerId, setFilterCustomerId] = useState<number | ''>('')
  const [customers, setCustomers] = useState<{ id: number; name: string }[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [draftText, setDraftText] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { documents } = await api.listDocuments(
      undefined,
      filterCustomerId === '' ? undefined : filterCustomerId,
    )
    setDocs(documents)
  }, [filterCustomerId])

  useEffect(() => {
    refresh().finally(() => setLoaded(true))
  }, [refresh])

  useEffect(() => {
    getActiveCustomers().then(setCustomers).catch(() => {})
  }, [])

  // Handle open / create intents once. The ref is the ONLY guard: it prevents a
  // StrictMode double-create, while the async commit runs to completion even
  // through StrictMode's mount→cleanup→remount (an `active`-flag would cancel
  // the commit on cleanup and the ref would block the second run — the intent
  // would silently no-op, leaving an orphan draft). Late setState after a real
  // unmount is a benign no-op in React 18.
  const intentKey = intent
    ? intent.type === 'open'
      ? `open-${intent.openId}`
      : `create-${intent.kind}-${intent.customer_id ?? ''}-${intent.lead_id ?? ''}`
    : null
  const handledIntent = useRef<string | null>(null)
  useEffect(() => {
    if (!intent || !intentKey) {
      // Allow the same openId/create to fire again after the parent clears intent.
      if (!intent) handledIntent.current = null
      return
    }
    if (handledIntent.current === intentKey) return
    handledIntent.current = intentKey
    ;(async () => {
      try {
        if (intent.type === 'open') {
          setOpenId(intent.openId)
          return
        }
        const body: {
          kind: string
          customer_id?: number
          lead_id?: number
          client_name?: string | null
          client_city?: string | null
          client_email?: string | null
        } = { kind: intent.kind }
        if (intent.customer_id != null) body.customer_id = intent.customer_id
        if (intent.lead_id != null) {
          body.lead_id = intent.lead_id
          try {
            const { lead } = await api.getLead(intent.lead_id)
            body.client_name = lead.company
            body.client_city = lead.city
            body.client_email = lead.email
          } catch {
            /* prefill optional */
          }
        }
        const { document } = await api.createDocument(body)
        await refresh()
        setOpenId(document.id)
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.')
      } finally {
        onIntentConsumed()
      }
    })()
  }, [intent, intentKey, refresh, onIntentConsumed])

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
      await refresh()
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
          onOpenDocument={(nextId) => {
            refresh()
            setOpenId(nextId)
          }}
          onIntent={onIntent}
        />
      </div>
    )
  }

  const visible = docs.filter((d) => filter === 'all' || d.kind === filter)

  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">Rechnungen &amp; Angebote</h1>
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
        <select
          value={filterCustomerId === '' ? '' : String(filterCustomerId)}
          onChange={(e) => setFilterCustomerId(e.target.value ? Number(e.target.value) : '')}
          style={{ maxWidth: 200 }}
          title="Nach Kunde filtern"
        >
          <option value="">Alle Kunden</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
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

        {!loaded ? (
          <div className="center-muted">Lädt…</div>
        ) : visible.length === 0 ? (
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
                  <td data-label="Typ">{KIND_LABEL[d.kind] ?? d.kind}</td>
                  <td data-label="Nummer" className="no-x cell-primary">{d.number ?? <em style={{ color: 'var(--muted)' }}>Entwurf</em>}</td>
                  <td data-label="Empfänger">{d.client_name ?? '—'}</td>
                  <td data-label="Datum">{fmtDate((d.issue_date ?? d.created_at).slice(0, 10))}</td>
                  <td data-label="Fällig">{d.due_date ? fmtDate(d.due_date) : '—'}</td>
                  <td data-label="Status">
                    <span className={`doc-status doc-status-${d.status}`}>{d.status}</span>
                  </td>
                  <td data-label="Betrag" className="num">{euro(d.totals.gross_cents)}</td>
                  <td data-label="" onClick={(e) => e.stopPropagation()}>
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
