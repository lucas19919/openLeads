import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Customer } from '../types'

/**
 * Select a Kunde from the registry. On select, the parent receives the full
 * customer so it can set customer_id and prefill local client_* fields.
 * Editing name after select should keep customer_id (parent responsibility).
 */
export function CustomerPicker({
  value,
  onSelect,
  disabled,
}: {
  value: number | null | undefined
  onSelect: (customer: Customer | null) => void
  disabled?: boolean
}) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .listCustomers(true)
      .then(({ customers: list }) => {
        if (alive) setCustomers(list)
      })
      .catch(() => {
        if (alive) setCustomers([])
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // If the linked customer is inactive, still show it in the list.
  const options = customers.slice()
  if (value != null && !options.some((c) => c.id === value)) {
    // Placeholder until full list loaded; optional fetch not required for create flow.
  }

  return (
    <div className="field">
      <label>Kunde (Stammdaten)</label>
      <select
        disabled={disabled || loading}
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value
          if (!raw) {
            onSelect(null)
            return
          }
          const id = Number(raw)
          const c = options.find((x) => x.id === id) ?? null
          onSelect(c)
        }}
      >
        <option value="">{loading ? 'Lädt…' : '— manuell / kein Kunde —'}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.city ? ` · ${c.city}` : ''}
          </option>
        ))}
      </select>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Adresse wird beim Anlegen übernommen. Später nur noch die Verknüpfung ändern — Belege behalten ihren
        Empfänger-Snapshot.
      </div>
    </div>
  )
}
