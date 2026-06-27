import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AiStatus, User } from '../types'
import { AiBadge } from './ai/CopilotView'

export type Module =
  | 'dashboard'
  | 'copilot'
  | 'leads'
  | 'scraper'
  | 'documents'
  | 'recurring'
  | 'contracts'
  | 'expenses'
  | 'settings'

// `adminOnly` tabs are hidden for members (the backend also gates the routes).
const TABS: { id: Module; label: string; adminOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Übersicht' },
  { id: 'copilot', label: 'Chat' },
  { id: 'leads', label: 'Leads' },
  { id: 'scraper', label: 'Scraper' },
  { id: 'documents', label: 'Rechnungen' },
  { id: 'recurring', label: 'Abo-Rechnungen' },
  { id: 'contracts', label: 'Verträge' },
  { id: 'expenses', label: 'Ausgaben' },
  { id: 'settings', label: 'Einstellungen' },
]

export function SuiteNav({
  module,
  setModule,
  user,
  onLogout,
}: {
  module: Module
  setModule: (m: Module) => void
  user: User
  onLogout: () => void
}) {
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  // Mobile only: the tab list collapses behind a burger. Selecting a tab closes it.
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => api.aiStatus().then((s) => alive && setAiStatus(s)).catch(() => {})
    load()
    const t = setInterval(load, 30_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const tabs = TABS.filter((t) => !t.adminOnly || user.role === 'admin')

  function pick(m: Module) {
    setModule(m)
    setMenuOpen(false)
  }

  return (
    <div className={`suite-nav${menuOpen ? ' open' : ''}`}>
      <div className="brand">
        Open<span>Leads</span>
      </div>
      <button
        className="nav-burger"
        aria-label="Menü"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {menuOpen ? '✕' : '☰'}
      </button>
      <nav className="suite-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={module === t.id ? 'active' : ''}
            onClick={() => pick(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="spacer" />
      <AiBadge status={aiStatus} />
      <span className="user-chip">{user.username}</span>
      <button className="ghost" onClick={onLogout}>
        Abmelden
      </button>
    </div>
  )
}
