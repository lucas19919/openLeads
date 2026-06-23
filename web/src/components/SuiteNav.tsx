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
  | 'mahnungen'
  | 'expenses'
  | 'integrations'
  | 'settings'

// `adminOnly` tabs are hidden for members (the backend also gates the routes).
const TABS: { id: Module; label: string; adminOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Übersicht' },
  { id: 'copilot', label: 'Chat' },
  { id: 'leads', label: 'Leads' },
  { id: 'scraper', label: 'Scraper' },
  { id: 'documents', label: 'Rechnungen' },
  { id: 'recurring', label: 'Serien' },
  { id: 'mahnungen', label: 'Mahnungen' },
  { id: 'expenses', label: 'Ausgaben' },
  { id: 'integrations', label: 'Integrationen', adminOnly: true },
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
  return (
    <div className="suite-nav">
      <div className="brand">
        Open<span>Leads</span>
      </div>
      <nav className="suite-tabs">
        {TABS.filter((t) => !t.adminOnly || user.role === 'admin').map((t) => (
          <button
            key={t.id}
            className={module === t.id ? 'active' : ''}
            onClick={() => setModule(t.id)}
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
