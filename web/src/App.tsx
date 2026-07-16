import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { invalidateCustomersCache } from './customersCache'
import type { Config, Lead, User } from './types'
import { Login } from './components/Login'
import { SuiteNav, type BackTarget, type Module, type ModuleIntent } from './components/SuiteNav'
import { CopilotView } from './components/ai/CopilotView'
import { LeadsView } from './components/LeadsView'
import { CustomersView } from './components/customers/CustomersView'
import { InvoicesView } from './components/invoices/InvoicesView'
import { SettingsView } from './components/invoices/SettingsView'
import { DashboardView } from './components/DashboardView'
import { RecurringView } from './components/invoices/RecurringView'
import { ContractsView } from './components/contracts/ContractsView'
import { ExpensesModule } from './components/expenses/ExpensesModule'
import { QuickSearch } from './components/QuickSearch'

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [config, setConfig] = useState<Config | null>(null)
  const [module, setModule] = useState<Module>('dashboard')
  const [intent, setIntent] = useState<ModuleIntent>(null)
  // Origins of cross-module jumps; the bar above the content pops the top.
  const [backStack, setBackStack] = useState<BackTarget[]>([])
  const [searchOpen, setSearchOpen] = useState(false)

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

  function pushBack(back: BackTarget) {
    setBackStack((s) => [...s.slice(-7), back])
    // Mirror the in-app stack in browser history so the hardware/browser back
    // button pops it too (popstate → goBack).
    try {
      history.pushState({ ol: true }, '')
    } catch {
      /* history may be unavailable; the bar still works */
    }
  }

  /** Sidebar switch: a fresh context — no way back, no pending intent. */
  function switchModule(m: Module) {
    setIntent(null)
    setBackStack([])
    setModule(m)
  }

  function navigateWithIntent(next: ModuleIntent) {
    if (!next) {
      setIntent(null)
      return
    }
    if (next.back) pushBack(next.back)
    setIntent(next)
    setModule(next.module)
  }

  /** Plain module switch that still offers a way back (dashboard drill-downs). */
  function navigateTo(m: Module, back: BackTarget) {
    pushBack(back)
    setIntent(null)
    setModule(m)
  }

  const goBack = useCallback(() => {
    setBackStack((s) => {
      const target = s[s.length - 1]
      if (!target) return s
      if (target.openId != null) {
        // Only 'open'-style restores are replayed — never 'create' intents.
        setIntent({ type: 'open', module: target.module, openId: target.openId } as ModuleIntent)
      } else {
        setIntent(null)
      }
      setModule(target.module)
      return s.slice(0, -1)
    })
  }, [])

  // Browser/phone back pops the in-app stack (we pushed one history entry per
  // stack entry). With an empty stack the event is a no-op and further backs
  // leave the app as usual.
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  useEffect(() => {
    const onPop = () => goBackRef.current()
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Ctrl/Cmd+K toggles the global quick search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Search jump: a fresh context, like a sidebar click — no back trail. */
  function jumpTo(next: NonNullable<ModuleIntent>) {
    setSearchOpen(false)
    setBackStack([])
    setIntent(next)
    setModule(next.module)
  }

  /** Back-bar click: consume the matching browser-history entry; popstate does the rest. */
  function requestBack() {
    try {
      history.back()
    } catch {
      goBack()
    }
  }

  /** Lead → Kunde: open existing by lead_id, or create from lead fields. */
  async function openOrCreateCustomerFromLead(lead: Lead) {
    const back: BackTarget = { label: 'Leads', module: 'leads', openId: lead.id }
    try {
      const { customers } = await api.listCustomers(false, lead.id)
      if (customers[0]) {
        navigateWithIntent({ type: 'open', module: 'customers', openId: customers[0].id, back })
        return
      }
      const { customer } = await api.createCustomer({
        name: lead.company?.trim() || 'Unbenannt',
        email: lead.email,
        phone: lead.phone,
        city: lead.city,
        lead_id: lead.id,
        client_type: 'geschaeft',
        active: 1,
      })
      invalidateCustomersCache()
      navigateWithIntent({ type: 'open', module: 'customers', openId: customer.id, back })
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Kunde konnte nicht angelegt werden.')
    }
  }

  if (user === undefined || (user && !config))
    return (
      <div className="center-muted" style={{ paddingTop: 80 }}>
        Lädt…
      </div>
    )
  if (user === null) return <Login onSuccess={setUser} />

  const leadsIntent = intent && intent.module === 'leads' ? intent : null
  const customersIntent =
    intent && intent.module === 'customers' ? intent : null
  const documentsIntent =
    intent && intent.module === 'documents' ? intent : null
  const contractsIntent =
    intent && intent.module === 'contracts' ? intent : null
  const recurringIntent =
    intent && intent.module === 'recurring' ? intent : null

  const backTop = backStack[backStack.length - 1] ?? null

  return (
    <div className="app">
      <SuiteNav
        module={module}
        setModule={switchModule}
        user={user}
        onLogout={onLogout}
        onSearch={() => setSearchOpen(true)}
      />
      <div className="main">
        {backTop && (
          <div className="back-bar">
            <button className="back-bar-btn" onClick={requestBack}>
              <span aria-hidden="true">←</span> Zurück zu {backTop.label}
            </button>
          </div>
        )}
        {module === 'dashboard' && (
          <DashboardView
            config={config!}
            onNavigate={(m) => navigateTo(m, { label: 'Übersicht', module: 'dashboard' })}
          />
        )}
        {module === 'copilot' && <CopilotView />}
        {module === 'leads' && (
          <LeadsView
            config={config!}
            intent={leadsIntent}
            onIntentConsumed={() => setIntent(null)}
            onCreateInvoice={(lead) => {
              navigateWithIntent({
                type: 'create',
                module: 'documents',
                kind: 'angebot',
                lead_id: lead.id,
                back: { label: 'Leads', module: 'leads', openId: lead.id },
              })
            }}
            onOpenCustomer={openOrCreateCustomerFromLead}
          />
        )}
        {module === 'customers' && (
          <CustomersView
            config={config!}
            onIntent={navigateWithIntent}
            intent={customersIntent}
            onIntentConsumed={() => setIntent(null)}
          />
        )}
        {/* Paper modules: no nav tab — reached via Kunden, Übersicht or lead intents. */}
        {module === 'documents' && (
          <InvoicesView
            config={config!}
            intent={documentsIntent}
            onIntentConsumed={() => setIntent(null)}
            onIntent={navigateWithIntent}
          />
        )}
        {module === 'recurring' && (
          <RecurringView
            config={config!}
            intent={recurringIntent}
            onIntentConsumed={() => setIntent(null)}
            onIntent={navigateWithIntent}
          />
        )}
        {module === 'contracts' && (
          <ContractsView
            config={config!}
            intent={contractsIntent}
            onIntentConsumed={() => setIntent(null)}
            onIntent={navigateWithIntent}
          />
        )}
        {module === 'expenses' && <ExpensesModule config={config!} />}
        {module === 'firma' && <SettingsView user={user} config={config!} variant="firma" />}
        {module === 'settings' && <SettingsView user={user} config={config!} variant="admin" />}
      </div>
      {searchOpen && <QuickSearch onClose={() => setSearchOpen(false)} onJump={jumpTo} />}
    </div>
  )
}
