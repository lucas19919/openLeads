import { useEffect, useState } from 'react'
import { api } from './api'
import type { Config, Lead, User } from './types'
import { Login } from './components/Login'
import { SuiteNav, type Module } from './components/SuiteNav'
import { CopilotView } from './components/ai/CopilotView'
import { LeadsView } from './components/LeadsView'
import { InvoicesView } from './components/invoices/InvoicesView'
import { MahnungenView } from './components/invoices/MahnungenView'
import { SettingsView } from './components/invoices/SettingsView'
import { DashboardView } from './components/DashboardView'
import { RecurringView } from './components/invoices/RecurringView'

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [config, setConfig] = useState<Config | null>(null)
  const [module, setModule] = useState<Module>('dashboard')
  // A lead handed from the CRM to the invoicing module to prefill a new Angebot.
  const [invoiceLead, setInvoiceLead] = useState<Lead | null>(null)

  useEffect(() => {
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
    api.config().then(setConfig).catch(() => {})
  }, [])

  async function onLogout() {
    await api.logout().catch(() => {})
    setUser(null)
  }

  if (user === undefined || (user && !config))
    return (
      <div className="center-muted" style={{ paddingTop: 80 }}>
        Lädt…
      </div>
    )
  if (user === null) return <Login onSuccess={setUser} />

  return (
    <div className="app">
      <SuiteNav module={module} setModule={setModule} user={user} onLogout={onLogout} />
      {module === 'dashboard' && <DashboardView config={config!} onNavigate={setModule} />}
      {module === 'copilot' && <CopilotView />}
      {module === 'leads' && (
        <LeadsView
          config={config!}
          onCreateInvoice={(lead) => {
            setInvoiceLead(lead)
            setModule('documents')
          }}
        />
      )}
      {module === 'documents' && (
        <InvoicesView
          config={config!}
          prefillLead={invoiceLead}
          onPrefillHandled={() => setInvoiceLead(null)}
        />
      )}
      {module === 'recurring' && <RecurringView config={config!} />}
      {module === 'mahnungen' && <MahnungenView />}
      {module === 'settings' && <SettingsView user={user} config={config!} />}
    </div>
  )
}
