import { useEffect, useState } from 'react'
import { api } from './api'
import type { Config, User } from './types'
import { Login } from './components/Login'
import { SuiteNav, type Module, type ModuleIntent } from './components/SuiteNav'
import { CopilotView } from './components/ai/CopilotView'
import { LeadsView } from './components/LeadsView'
import { CustomersView } from './components/customers/CustomersView'
import { InvoicesView } from './components/invoices/InvoicesView'
import { SettingsView } from './components/invoices/SettingsView'
import { DashboardView } from './components/DashboardView'
import { RecurringView } from './components/invoices/RecurringView'
import { ContractsView } from './components/contracts/ContractsView'
import { ExpensesModule } from './components/expenses/ExpensesModule'

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [config, setConfig] = useState<Config | null>(null)
  const [module, setModule] = useState<Module>('dashboard')
  const [intent, setIntent] = useState<ModuleIntent>(null)

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

  function navigateWithIntent(next: ModuleIntent) {
    if (!next) {
      setIntent(null)
      return
    }
    setIntent(next)
    setModule(next.module)
  }

  if (user === undefined || (user && !config))
    return (
      <div className="center-muted" style={{ paddingTop: 80 }}>
        Lädt…
      </div>
    )
  if (user === null) return <Login onSuccess={setUser} />

  const documentsIntent =
    intent && intent.module === 'documents' ? intent : null
  const contractsIntent =
    intent && intent.module === 'contracts' ? intent : null
  const recurringIntent =
    intent && intent.module === 'recurring' ? intent : null

  return (
    <div className="app">
      <SuiteNav module={module} setModule={setModule} user={user} onLogout={onLogout} />
      <div className="main">
        {module === 'dashboard' && <DashboardView config={config!} onNavigate={setModule} />}
        {module === 'copilot' && <CopilotView />}
        {module === 'leads' && (
          <LeadsView
            config={config!}
            onCreateInvoice={(lead) => {
              navigateWithIntent({
                type: 'create',
                module: 'documents',
                kind: 'angebot',
                lead_id: lead.id,
              })
            }}
          />
        )}
        {module === 'customers' && (
          <CustomersView config={config!} onIntent={navigateWithIntent} />
        )}
        {module === 'documents' && (
          <InvoicesView
            config={config!}
            intent={documentsIntent}
            onIntentConsumed={() => setIntent(null)}
          />
        )}
        {module === 'recurring' && (
          <RecurringView
            config={config!}
            intent={recurringIntent}
            onIntentConsumed={() => setIntent(null)}
          />
        )}
        {module === 'contracts' && (
          <ContractsView
            config={config!}
            intent={contractsIntent}
            onIntentConsumed={() => setIntent(null)}
            onNavigateRecurring={(id) =>
              navigateWithIntent({ type: 'open', module: 'recurring', openId: id })
            }
          />
        )}
        {module === 'expenses' && <ExpensesModule config={config!} />}
        {module === 'settings' && <SettingsView user={user} config={config!} />}
      </div>
    </div>
  )
}
