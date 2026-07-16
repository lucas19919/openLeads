import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Config, Lead } from '../types'
import type { ModuleIntent } from './SuiteNav'
import { Toolbar } from './Toolbar'
import { Board } from './Board'
import { Table } from './Table'
import { LeadDetail } from './LeadDetail'
import { NewLeadModal } from './NewLeadModal'

export function LeadsView({
  config,
  intent,
  onIntentConsumed,
  onCreateInvoice,
  onOpenCustomer,
}: {
  config: Config
  intent?: Extract<NonNullable<ModuleIntent>, { module: 'leads' }> | null
  onIntentConsumed?: () => void
  onCreateInvoice: (lead: Lead) => void
  onOpenCustomer?: (lead: Lead) => void | Promise<void>
}) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loaded, setLoaded] = useState(false)
  // Kanban drag-and-drop needs a mouse; default phones to the table view, whose
  // per-row Phase dropdown works with touch.
  const [view, setView] = useState<'board' | 'table'>(() =>
    typeof window !== 'undefined' && window.innerWidth <= 720 ? 'table' : 'board',
  )
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [importing, setImporting] = useState(false)

  const refresh = useCallback(async () => {
    const { leads } = await api.listLeads()
    setLeads(leads)
  }, [])

  useEffect(() => {
    refresh().finally(() => setLoaded(true))
  }, [refresh])

  // Open a lead's drawer when jumped to from another module (Kunde → Lead, back-nav).
  useEffect(() => {
    if (!intent || intent.type !== 'open') return
    setSelectedId(intent.openId)
    onIntentConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.type === 'open' ? intent.openId : null])

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
        {!loaded ? (
          <div className="center-muted">Lädt…</div>
        ) : leads.length === 0 ? (
          <div className="center-muted">
            Noch keine Leads. Importiere eine Liste (.xlsx), lass den KI-Chat eine
            Website prüfen — oder lege manuell einen an („+ Lead").
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
          onOpenCustomer={
            onOpenCustomer
              ? async (lead) => {
                  setSelectedId(null)
                  await onOpenCustomer(lead)
                }
              : undefined
          }
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
