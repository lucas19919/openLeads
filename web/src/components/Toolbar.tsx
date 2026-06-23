import { useRef } from 'react'

export function Toolbar({
  view,
  setView,
  search,
  setSearch,
  count,
  onNew,
  onImportFile,
  importing,
  exportHref,
  aiOpen,
  onToggleAi,
}: {
  view: 'board' | 'table'
  setView: (v: 'board' | 'table') => void
  search: string
  setSearch: (v: string) => void
  count: number
  onNew: () => void
  onImportFile: (file: File) => void
  importing: boolean
  exportHref: string
  aiOpen?: boolean
  onToggleAi?: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="toolbar">
      <span className="page-title">Leads</span>
      <div className="seg">
        <button
          className={view === 'board' ? 'active' : ''}
          onClick={() => setView('board')}
        >
          Board
        </button>
        <button
          className={view === 'table' ? 'active' : ''}
          onClick={() => setView('table')}
        >
          Tabelle
        </button>
      </div>
      <input
        className="search"
        placeholder="Suche Firma, Ort, Gewerk…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {onToggleAi && (
        <button
          className={aiOpen ? 'ai-toggle active' : 'ai-toggle'}
          onClick={onToggleAi}
          aria-pressed={aiOpen}
          title="Semantische KI-Suche ein-/ausblenden"
        >
          KI-Suche
        </button>
      )}
      <span className="user-chip">{count} Leads</span>
      <div className="spacer" />
      <button onClick={() => fileRef.current?.click()} disabled={importing}>
        {importing ? 'Importiere…' : 'Import xlsx'}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".xlsx,.xls"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onImportFile(f)
          e.target.value = ''
        }}
      />
      <a className="btn" href={exportHref} download title="Sichtbare Leads als CSV exportieren">
        Export CSV
      </a>
      <button onClick={onNew}>+ Lead</button>
    </div>
  )
}
