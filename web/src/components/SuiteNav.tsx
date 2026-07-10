import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AiStatus, User } from '../types'
import { AiBadge } from './ai/CopilotView'

export type Module =
  | 'dashboard'
  | 'copilot'
  | 'leads'
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
  { id: 'documents', label: 'Rechnungen' },
  { id: 'recurring', label: 'Abo-Rechnungen' },
  { id: 'contracts', label: 'Verträge' },
  { id: 'expenses', label: 'Ausgaben' },
  { id: 'settings', label: 'Einstellungen', adminOnly: true },
]

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', member: 'Team' }

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
  // Mobile only: the nav list collapses behind a burger. Selecting a tab closes it.
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
    <aside className={`side${menuOpen ? ' open' : ''}`}>
      <div className="brand">
        Open<i>Leads</i>
      </div>
      <button
        className="nav-burger"
        aria-label="Menü"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {menuOpen ? '✕' : '☰'}
      </button>
      <nav className="nav">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`nav-item${module === t.id ? ' active' : ''}`}
            onClick={() => pick(t.id)}
          >
            <span className="dot" />
            {t.label}
          </button>
        ))}
      </nav>
      <div className="side-foot">
        <AiBadge status={aiStatus} />
        <div className="side-user">
          <span className="avatar">{user.username.slice(0, 2)}</span>
          <div>
            <div className="side-user-name">{user.username}</div>
            <div className="side-user-role">
              {ROLE_LABEL[user.role] ?? user.role} · isarwebsites
            </div>
          </div>
        </div>
        <button className="ghost" onClick={onLogout}>
          Abmelden
        </button>
      </div>
    </aside>
  )
}
