import { useEffect, useState } from 'react'
import { api } from '../api'
import { getActiveCustomers } from '../customersCache'
import type { Customer } from '../types'

/**
 * Select a Kunde from the registry. On select, the parent receives the full
 * customer so it can set customer_id and (on drafts) prefill local client_* fields.
 * Editing name after select should keep customer_id (parent responsibility).
 *
 * `linkOnly`: finalised Belege — only the Stamm-link changes; helper text says so.
 * The picker itself stays enabled so operators can attach historical papers.
 */
export function CustomerPicker({
  value,
  onSelect,
  disabled,
  linkOnly,
}: {
  value: number | null | undefined
  onSelect: (customer: Customer | null) => void
  disabled?: boolean
  /** When true, copy explains link-only (no snapshot rewrite). */
  linkOnly?: boolean
}) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  // The linked customer when it is not in the active list (deactivated since):
  // fetched separately so the select never misrepresents an existing link.
  const [linkedInactive, setLinkedInactive] = useState<Customer | null>(null)

  useEffect(() => {
    let alive = true
    getActiveCustomers()
      .then((list) => {
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

  useEffect(() => {
    if (loading || value == null || customers.some((c) => c.id === value)) {
      setLinkedInactive(null)
      return
    }
    let alive = true
    api
      .getCustomer(value)
      .then(({ customer }) => {
        if (alive) setLinkedInactive(customer)
      })
      .catch(() => {
        if (alive) setLinkedInactive(null)
      })
    return () => {
      alive = false
    }
  }, [loading, value, customers])

  const options = linkedInactive ? [linkedInactive, ...customers] : customers

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
            {c.active ? '' : ' (inaktiv)'}
          </option>
        ))}
      </select>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {linkOnly
          ? 'Festgeschrieben: ändert nur die Kunden-Verknüpfung. Empfängertext und PDF bleiben unverändert.'
          : 'Adresse wird beim Anlegen übernommen. Später nur noch die Verknüpfung ändern — Belege behalten ihren Empfänger-Snapshot.'}
      </div>
    </div>
  )
}
