import { useRef } from 'react'

export function Toolbar({
  phone,
  stages,
  stageFilter,
  setStageFilter,
  view,
  setView,
  search,
  setSearch,
  count,
  onNew,
  onImportFile,
  importing,
  exportHref,
}: {
  phone: boolean
  stages: string[]
  stageFilter: string
  setStageFilter: (v: string) => void
  view: 'board' | 'table'
  setView: (v: 'board' | 'table') => void
  search: string
  setSearch: (v: string) => void
  count: number
  onNew: () => void
  onImportFile: (file: File) => void
  importing: boolean
  exportHref: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  return (
    <div className="toolbar">
      <h1 className="page-title">Leads</h1>
      {/* Phones get one card list filtered by phase instead of the two views. */}
      {phone ? (
        <select
          aria-label="Phase filtern"
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value)}
        >
          <option value="">Alle Phasen</option>
          {stages.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      ) : (
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
      )}
      <input
        className="search"
        placeholder="Suche Firma, Ort, Gewerk…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
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
      <button className="primary" onClick={onNew}>+ Lead</button>
    </div>
  )
}
