import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Config, Lead, SemanticHit } from '../types'
import { Toolbar } from './Toolbar'
import { Board } from './Board'
import { Table } from './Table'
import { LeadDetail } from './LeadDetail'
import { NewLeadModal } from './NewLeadModal'

export function LeadsView({
  config,
  onCreateInvoice,
}: {
  config: Config
  onCreateInvoice: (lead: Lead) => void
}) {
  const [leads, setLeads] = useState<Lead[]>([])
  // Kanban drag-and-drop needs a mouse; default phones to the table view, whose
  // per-row Phase dropdown works with touch.
  const [view, setView] = useState<'board' | 'table'>(() =>
    typeof window !== 'undefined' && window.innerWidth <= 720 ? 'table' : 'board',
  )
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [importing, setImporting] = useState(false)

  // KI-Suche (semantische Suche). Solange Ergebnisse vorliegen, ersetzen sie die
  // normale Liste; null bedeutet: keine KI-Suche aktiv -> normale Ansicht.
  const [aiQuery, setAiQuery] = useState('')
  const [aiSearching, setAiSearching] = useState(false)
  const [aiHits, setAiHits] = useState<SemanticHit[] | null>(null)
  const [aiMode, setAiMode] = useState<'semantic' | 'fallback' | null>(null)
  const [aiErr, setAiErr] = useState<string | null>(null)
  const [reindexing, setReindexing] = useState(false)
  const [reindexNote, setReindexNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { leads } = await api.listLeads()
    setLeads(leads)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function onMove(id: number, stage: string) {
    setLeads((ls) => ls.map((l) => (l.id === id ? { ...l, stage } : l)))
    try {
      await api.updateLead(id, { stage })
    } catch {
      refresh()
    }
  }

  function onChanged(updated: Lead) {
    setLeads((ls) => ls.map((l) => (l.id === updated.id ? updated : l)))
  }

  async function importFile(file: File) {
    setImporting(true)
    try {
      const r = await api.importLeads(file)
      await refresh()
      alert(
        `Import abgeschlossen: ${r.imported} neu, ${r.deduped} bereits vorhanden ` +
          `(von ${r.total} Zeilen).`,
      )
    } catch (e) {
      alert('Import fehlgeschlagen: ' + (e instanceof Error ? e.message : 'Unbekannter Fehler'))
    } finally {
      setImporting(false)
    }
  }

  async function runAiSearch() {
    const query = aiQuery.trim()
    if (!query) return
    setAiSearching(true)
    setAiErr(null)
    try {
      const { mode, hits } = await api.semanticSearch(query)
      setAiMode(mode)
      setAiHits(hits)
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : 'Unbekannter Fehler')
      setAiHits(null)
      setAiMode(null)
    } finally {
      setAiSearching(false)
    }
  }

  function clearAiSearch() {
    setAiQuery('')
    setAiHits(null)
    setAiMode(null)
    setAiErr(null)
  }

  async function reindex() {
    setReindexing(true)
    setReindexNote(null)
    setAiErr(null)
    try {
      const { indexed, model } = await api.reindexLeads()
      setReindexNote(`${indexed} Leads neu indexiert (${model}).`)
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setReindexing(false)
    }
  }

  const q = search.trim().toLowerCase()
  const filtered = q
    ? leads.filter((l) =>
        [l.company, l.city, l.trade, l.website, l.tags].some((v) => v?.toLowerCase().includes(q)),
      )
    : leads

  return (
    <>
      <Toolbar
        view={view}
        setView={setView}
        search={search}
        setSearch={setSearch}
        count={filtered.length}
        onNew={() => setShowNew(true)}
        onImportFile={importFile}
        importing={importing}
        exportHref={api.exportLeadsUrl({ q: search.trim() || undefined })}
      />
      <div className="content">
        <div className="ai-search">
          <span className="ai-badge ai-badge-cloud">KI</span>
          <input
            className="search ai-search-input"
            placeholder="KI-Suche: z. B. „Dachdecker ohne Website in der Nähe von Köln“"
            value={aiQuery}
            onChange={(e) => setAiQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runAiSearch()
            }}
          />
          <button className="primary" disabled={aiSearching || !aiQuery.trim()} onClick={runAiSearch}>
            {aiSearching ? 'Suche…' : 'KI-Suche'}
          </button>
          {aiHits !== null && (
            <button className="ghost" onClick={clearAiSearch}>
              Zurücksetzen
            </button>
          )}
          <div className="spacer" />
          <button className="ghost-link" disabled={reindexing} onClick={reindex}>
            {reindexing ? 'Indexiere…' : 'Neu indexieren'}
          </button>
        </div>
        {reindexNote && (
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {reindexNote}
          </div>
        )}
        {aiErr && (
          <div className="section-error" role="alert">
            {aiErr}
          </div>
        )}

        {aiHits !== null ? (
          <div className="ai-results">
            <div className="ai-results-head">
              <span className="user-chip">{aiHits.length} Treffer</span>
              {aiMode === 'fallback' && (
                <span className="muted" style={{ fontSize: 12 }}>
                  Textsuche — KI-Modell offline
                </span>
              )}
            </div>
            {aiHits.length === 0 ? (
              <div className="center-muted">Keine passenden Leads gefunden.</div>
            ) : (
              aiHits.map(({ lead, score }) => (
                <button
                  type="button"
                  className="ai-result-row"
                  key={lead.id}
                  onClick={() => setSelectedId(lead.id)}
                >
                  <div className="ai-result-main">
                    <span className="ai-result-company">{lead.company ?? 'Lead'}</span>
                    <span className="muted">
                      {[lead.trade, lead.city].filter(Boolean).join(' · ') || '—'}
                    </span>
                  </div>
                  <span className="chip">{Math.round(score * 100)}%</span>
                </button>
              ))
            )}
          </div>
        ) : leads.length === 0 ? (
          <div className="center-muted">
            Noch keine Leads. Der Scraper füllt sie automatisch — oder lege manuell
            einen an („+ Lead").
          </div>
        ) : view === 'board' ? (
          <Board stages={config.stages} leads={filtered} onOpen={setSelectedId} onMove={onMove} />
        ) : (
          <Table stages={config.stages} leads={filtered} onOpen={setSelectedId} onMove={onMove} />
        )}
      </div>

      {selectedId !== null && (
        <LeadDetail
          id={selectedId}
          stages={config.stages}
          priorities={config.priorities}
          onClose={() => setSelectedId(null)}
          onChanged={onChanged}
          onCreateInvoice={(lead) => {
            setSelectedId(null)
            onCreateInvoice(lead)
          }}
        />
      )}

      {showNew && (
        <NewLeadModal
          priorities={config.priorities}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false)
            refresh()
          }}
        />
      )}
    </>
  )
}
