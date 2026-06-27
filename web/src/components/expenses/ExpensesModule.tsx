import { useState } from 'react'
import type { Config } from '../../types'
import { ExpensesView } from './ExpensesView'
import { SubscriptionsView } from './SubscriptionsView'

// The "money out" hub: one-off receipts (Belege) and recurring outgoing
// subscriptions (Abos) share a module and a segmented switch in the toolbar.
export type ExpTab = 'belege' | 'abos'

export function ExpensesTabs({ tab, onTab }: { tab: ExpTab; onTab: (t: ExpTab) => void }) {
  return (
    <div className="seg">
      <button className={tab === 'belege' ? 'active' : ''} onClick={() => onTab('belege')}>
        Belege
      </button>
      <button className={tab === 'abos' ? 'active' : ''} onClick={() => onTab('abos')}>
        Abos
      </button>
    </div>
  )
}

export function ExpensesModule({ config }: { config: Config }) {
  const [tab, setTab] = useState<ExpTab>('belege')
  return tab === 'belege' ? (
    <ExpensesView config={config} tab={tab} onTab={setTab} />
  ) : (
    <SubscriptionsView config={config} tab={tab} onTab={setTab} />
  )
}
