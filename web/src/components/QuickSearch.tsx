import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { euro } from '../money'
import { useEscapeKey } from '../util'
import type { ModuleIntent } from './SuiteNav'

const KIND_LABEL: Record<string, string> = { angebot: 'Angebot', rechnung: 'Rechnung' }

interface Hit {
  key: string
  group: 'Leads' | 'Kunden' | 'Belege' | 'Verträge' | 'Serien'
  label: string
  sub: string
  intent: NonNullable<ModuleIntent>
}

const GROUP_ORDER: Hit['group'][] = ['Kunden', 'Belege', 'Verträge', 'Serien', 'Leads']
const PER_GROUP = 5

/**
 * Ctrl/Cmd+K jump box over everything that has an id: leads, customers,
 * documents (by number too), contracts, series. Client-side index — the lists
 * are small enough that five fetches on open beat a dedicated endpoint.
 */
export function QuickSearch({
  onClose,
  onJump,
}: {
  onClose: () => void
  onJump: (intent: NonNullable<ModuleIntent>) => void
}) {
  const [q, setQ] = useState('')
  const [index, setIndex] = useState<Hit[] | null>(null)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEscapeKey(onClose)

  useEffect(() => {
    let alive = true
    Promise.all([
      api.listLeads().catch(() => ({ leads: [] })),
      api.listCustomers(false).catch(() => ({ customers: [] })),
      api.listDocuments().catch(() => ({ documents: [] })),
      api.listContracts().catch(() => ({ contracts: [] })),
      api.listRecurring().catch(() => ({ recurring: [] })),
    ]).then(([l, c, d, k, r]) => {
      if (!alive) return
      const hits: Hit[] = []
      for (const x of c.customers)
        hits.push({
          key: `c${x.id}`,
          group: 'Kunden',
          label: x.name,
          sub: [x.city, x.email].filter(Boolean).join(' · '),
          intent: { type: 'open', module: 'customers', openId: x.id },
        })
      for (const x of d.documents)
        hits.push({
          key: `d${x.id}`,
          group: 'Belege',
          label: `${KIND_LABEL[x.kind] ?? x.kind} ${x.number ?? '(Entwurf)'}`,
          sub: [x.client_name, x.title, x.status, euro(x.totals.gross_cents)]
            .filter(Boolean)
            .join(' · '),
          intent: { type: 'open', module: 'documents', openId: x.id },
        })
      for (const x of k.contracts)
        hits.push({
          key: `k${x.id}`,
          group: 'Verträge',
          label: x.number ? `Vertrag ${x.number}` : `Vertragsentwurf: ${x.title ?? '—'}`,
          sub: [x.client_name, x.title, x.status].filter(Boolean).join(' · '),
          intent: { type: 'open', module: 'contracts', openId: x.id },
        })
      for (const x of r.recurring)
        hits.push({
          key: `r${x.id}`,
          group: 'Serien',
          label: x.title ?? `Serie #${x.id}`,
          sub: [x.client_name, x.cadence].filter(Boolean).join(' · '),
          intent: { type: 'open', module: 'recurring', openId: x.id },
        })
      for (const x of l.leads)
        hits.push({
          key: `l${x.id}`,
          group: 'Leads',
          label: x.company ?? `Lead #${x.id}`,
          sub: [x.trade, x.city, x.stage].filter(Boolean).join(' · '),
          intent: { type: 'open', module: 'leads', openId: x.id },
        })
      setIndex(hits)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle || !index) return []
    const scored = index
      .map((h) => {
        const hay = `${h.label} ${h.sub}`.toLowerCase()
        if (!hay.includes(needle)) return null
        return { h, rank: h.label.toLowerCase().startsWith(needle) ? 0 : 1 }
      })
      .filter((x): x is { h: Hit; rank: number } => x !== null)
      .sort((a, b) => a.rank - b.rank)
    const grouped: Hit[] = []
    for (const g of GROUP_ORDER) {
      grouped.push(...scored.filter((x) => x.h.group === g).slice(0, PER_GROUP).map((x) => x.h))
    }
    return grouped
  }, [q, index])

  useEffect(() => {
    setSel(0)
  }, [q])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === 'Enter' && results[sel]) {
      onJump(results[sel].intent)
    }
  }

  let lastGroup: string | null = null

  return (
    <div className="modal modal-top" role="dialog" aria-modal="true" aria-label="Suche" onClick={onClose}>
      <div className="modal-card qs-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search"
          placeholder="Suche Kunde, Rechnungsnummer, Lead, Vertrag…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {q.trim() === '' ? (
          <div className="qs-hint">
            Tippe zum Suchen — springt direkt zu Kunden, Belegen, Verträgen, Serien und Leads.
          </div>
        ) : index === null ? (
          <div className="qs-hint">Lädt…</div>
        ) : results.length === 0 ? (
          <div className="qs-hint">Keine Treffer.</div>
        ) : (
          <div className="qs-list">
            {results.map((h, i) => {
              const header = h.group !== lastGroup ? h.group : null
              lastGroup = h.group
              return (
                <div key={h.key}>
                  {header && <div className="qs-group">{header}</div>}
                  <button
                    className={`qs-item${i === sel ? ' sel' : ''}`}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => onJump(h.intent)}
                  >
                    <span className="qs-label">{h.label}</span>
                    {h.sub && <span className="qs-sub">{h.sub}</span>}
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
