import { useEffect, useState } from 'react'
import { api } from '../api'
import type { AiStatus, User } from '../types'
import { AiBadge } from './ai/CopilotView'
import Brand from './Brand'
import { THEME_LABEL, useTheme } from '../theme'

export type Module =
  | 'dashboard'
  | 'copilot'
  | 'leads'
  | 'customers'
  | 'documents'
  | 'recurring'
  | 'contracts'
  | 'expenses'
  | 'firma'
  | 'settings'

/**
 * Where a cross-module jump came from, so the app can offer a way back.
 * `openId` re-opens that item on return (module list otherwise).
 */
export type BackTarget = { label: string; module: Module; openId?: number }

/** Cross-module open / create intents (no client router). Module is per-variant for narrowing. */
export type ModuleIntent =
  | { type: 'open'; module: 'leads'; openId: number; back?: BackTarget }
  | { type: 'open'; module: 'customers'; openId: number; back?: BackTarget }
  | { type: 'open'; module: 'documents'; openId: number; back?: BackTarget }
  | { type: 'open'; module: 'contracts'; openId: number; back?: BackTarget }
  | { type: 'open'; module: 'recurring'; openId: number; back?: BackTarget }
  | {
      type: 'create'
      module: 'documents'
      kind: 'angebot' | 'rechnung'
      customer_id?: number
      lead_id?: number
      back?: BackTarget
    }
  | { type: 'create'; module: 'contracts'; customer_id: number; back?: BackTarget }
  | { type: 'create'; module: 'recurring'; customer_id: number; back?: BackTarget }
  | null

// Serienrechnungen has no tab of its own — series are reached from their
// Vertrag or Kunde. `adminOnly` tabs are hidden for members (the backend also
// gates the routes).
const TABS: { id: Module; label: string; adminOnly?: boolean }[] = [
  { id: 'dashboard', label: 'Übersicht' },
  { id: 'copilot', label: 'Chat' },
  { id: 'leads', label: 'Leads' },
  { id: 'customers', label: 'Kunden' },
  { id: 'documents', label: 'Rechnungen' },
  { id: 'contracts', label: 'Verträge' },
  { id: 'expenses', label: 'Ausgaben' },
  { id: 'firma', label: 'Firma', adminOnly: true },
  { id: 'settings', label: 'Einstellungen', adminOnly: true },
]

// Phone bottom bar: the four everyday modules get a permanent tab, the rest
// live behind "Mehr". Every one of these is role-independent, so the bar has
// the same five slots for admins and members alike.
const PRIMARY: Module[] = ['dashboard', 'leads', 'customers', 'documents']

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', member: 'Team' }

/** 20px stroke glyphs — labels alone don't fit five tabs across a 375px phone. */
function TabIcon({ id }: { id: Module | 'more' | 'search' }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <svg className="tab-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
      {id === 'dashboard' && (
        <g {...p}>
          <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
          <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
          <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
          <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
        </g>
      )}
      {id === 'leads' && (
        <g {...p}>
          <path d="M2.5 3.5h15l-5.75 6.75v5.5l-3.5 1.75v-7.25z" />
        </g>
      )}
      {id === 'customers' && (
        <g {...p}>
          <circle cx="7.5" cy="6.5" r="2.75" />
          <path d="M2.5 16.5c0-2.5 2.2-4.25 5-4.25s5 1.75 5 4.25" />
          <path d="M13.5 4.4a2.75 2.75 0 0 1 0 5.2M14.5 12.6c2.05.45 3.5 1.95 3.5 3.9" />
        </g>
      )}
      {id === 'documents' && (
        <g {...p}>
          <path d="M4.5 2.5h7l4 4v11h-11z" />
          <path d="M11.5 2.5v4h4M7 10h6M7 13h6" />
        </g>
      )}
      {id === 'search' && (
        <g {...p}>
          <circle cx="8.75" cy="8.75" r="5.25" />
          <path d="M12.75 12.75l4 4" />
        </g>
      )}
      {id === 'more' && (
        <g fill="currentColor">
          <circle cx="4" cy="10" r="1.7" />
          <circle cx="10" cy="10" r="1.7" />
          <circle cx="16" cy="10" r="1.7" />
        </g>
      )}
    </svg>
  )
}

export function SuiteNav({
  module,
  setModule,
  user,
  onLogout,
  onSearch,
}: {
  module: Module
  setModule: (m: Module) => void
  user: User
  onLogout: () => void
  onSearch?: () => void
}) {
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  // Phone only: the non-primary modules live in a bottom sheet behind "Mehr".
  const [sheetOpen, setSheetOpen] = useState(false)
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

  // Escape closes the sheet, like every other overlay in the app.
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheetOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  const tabs = TABS.filter((t) => !t.adminOnly || user.role === 'admin')
  const primary = PRIMARY.map((id) => tabs.find((t) => t.id === id)!).filter(Boolean)
  const rest = tabs.filter((t) => !PRIMARY.includes(t.id))

  function pick(m: Module) {
    setModule(m)
    setSheetOpen(false)
  }

  const [theme, nextTheme] = useTheme()
  const themeButton = (
    <button className="ghost" onClick={nextTheme} title="Hell, dunkel oder wie das System">
      {THEME_LABEL[theme]}
    </button>
  )

  const userBlock = (
    <div className="side-user">
      <span className="avatar">{user.username.slice(0, 2)}</span>
      <div>
        <div className="side-user-name">{user.username}</div>
        <div className="side-user-role">{ROLE_LABEL[user.role] ?? user.role}</div>
      </div>
    </div>
  )

  return (
    <>
      {/* Desktop / tablet: the full sidebar. Hidden on phones. */}
      <aside className="side">
        <Brand />
        <nav className="nav">
          {onSearch && (
            <button className="nav-item nav-search" onClick={onSearch}>
              <span className="dot" />
              Suche
              <kbd>Strg K</kbd>
            </button>
          )}
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item${module === t.id ? ' active' : ''}`}
              onClick={() => setModule(t.id)}
            >
              <span className="dot" />
              {t.label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <AiBadge status={aiStatus} />
          {userBlock}
          <div className="side-actions">
            <button className="ghost" onClick={onLogout}>
              Abmelden
            </button>
            {themeButton}
          </div>
        </div>
      </aside>

      {/* Phone: fixed bottom tab bar — one tap per module, no chrome at the top. */}
      <nav className="tabbar" aria-label="Hauptnavigation">
        {primary.map((t) => (
          <button
            key={t.id}
            className={`tab${module === t.id ? ' active' : ''}`}
            aria-current={module === t.id ? 'page' : undefined}
            onClick={() => pick(t.id)}
          >
            <TabIcon id={t.id} />
            {t.label}
          </button>
        ))}
        <button
          className={`tab${rest.some((t) => t.id === module) ? ' active' : ''}`}
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen((o) => !o)}
        >
          <TabIcon id="more" />
          Mehr
        </button>
      </nav>

      {sheetOpen && (
        <>
          <div className="overlay sheet-scrim" onClick={() => setSheetOpen(false)} />
          <div className="sheet" role="dialog" aria-label="Weitere Bereiche">
            <div className="sheet-head">
              <Brand />
              <button className="ghost" onClick={() => setSheetOpen(false)}>
                Schließen
              </button>
            </div>
            <div className="sheet-nav">
              {onSearch && (
                <button
                  className="sheet-item"
                  onClick={() => {
                    onSearch()
                    setSheetOpen(false)
                  }}
                >
                  <TabIcon id="search" />
                  Suche
                </button>
              )}
              {rest.map((t) => (
                <button
                  key={t.id}
                  className={`sheet-item${module === t.id ? ' active' : ''}`}
                  onClick={() => pick(t.id)}
                >
                  <span className="dot" />
                  {t.label}
                </button>
              ))}
            </div>
            <div className="sheet-foot">
              {userBlock}
              <AiBadge status={aiStatus} />
              <div className="spacer" />
              {themeButton}
              <button className="ghost" onClick={onLogout}>
                Abmelden
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
