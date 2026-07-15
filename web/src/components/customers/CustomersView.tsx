import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../../api'
import { euro } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Customer, CustomerOverview } from '../../types'
import type { ModuleIntent } from '../SuiteNav'

const CLIENT_TYPE_LABEL: Record<string, string> = {
  geschaeft: 'Geschäft (B2B)',
  privat: 'Privat (B2C)',
}
const KIND_LABEL: Record<string, string> = { angebot: 'Angebot', rechnung: 'Rechnung' }
const STATUS_LABEL: Record<string, string> = {
  entwurf: 'Entwurf',
  versendet: 'Versendet',
  aktiv: 'Aktiv',
  beendet: 'Beendet',
  abgelehnt: 'Abgelehnt',
  bezahlt: 'Bezahlt',
  storniert: 'Storniert',
}
const CADENCE_LABEL: Record<string, string> = {
  monatlich: 'Monatlich',
  quartalsweise: 'Quartalsweise',
  jährlich: 'Jährlich',
}

type Draft = Partial<Customer>

function blankDraft(config: Config): Draft {
  return {
    name: '',
    contact_name: '',
    address: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
    vat_id: '',
    client_type: config.clientTypes[0] ?? 'geschaeft',
    notes: '',
    active: 1,
  }
}

export function CustomersView({
  config,
  onIntent,
}: {
  config: Config
  onIntent: (intent: ModuleIntent) => void
}) {
  const [rows, setRows] = useState<Customer[]>([])
  const [q, setQ] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [overview, setOverview] = useState<CustomerOverview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { customers } = await api.listCustomers(false)
    setRows(customers)
  }, [])

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : 'Laden fehlgeschlagen.'))
  }, [refresh])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((c) => {
      if (activeOnly && !c.active) return false
      if (!needle) return true
      const hay = [c.name, c.city, c.email, c.contact_name, c.phone].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(needle)
    })
  }, [rows, q, activeOnly])

  async function openCustomer(c: Customer) {
    setError(null)
    setMsg(null)
    setDraft({ ...c })
    setOverview(null)
    try {
      const { overview: o } = await api.customerOverview(c.id)
      setOverview(o)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Übersicht konnte nicht geladen werden.')
    }
  }

  function startNew() {
    setDraft(blankDraft(config))
    setOverview(null)
    setError(null)
    setMsg(null)
  }

  async function save() {
    if (!draft) return
    setBusy(true)
    setError(null)
    try {
      const body: Partial<Customer> = {
        name: draft.name,
        contact_name: draft.contact_name || null,
        address: draft.address || null,
        zip: draft.zip || null,
        city: draft.city || null,
        email: draft.email || null,
        phone: draft.phone || null,
        vat_id: draft.vat_id || null,
        client_type: draft.client_type,
        notes: draft.notes || null,
        active: draft.active ? 1 : 0,
      }
      const { customer } = draft.id
        ? await api.updateCustomer(draft.id, body)
        : await api.createCustomer(body)
      setDraft(customer)
      await refresh()
      const { overview: o } = await api.customerOverview(customer.id)
      setOverview(o)
      setMsg('Gespeichert.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!draft?.id) return
    if (!confirm('Kunde löschen? Verknüpfte Belege bleiben erhalten (Verknüpfung wird gelöst).')) return
    setBusy(true)
    try {
      await api.deleteCustomer(draft.id)
      setDraft(null)
      setOverview(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.')
    } finally {
      setBusy(false)
    }
  }

  function setD(patch: Partial<Draft>) {
    setDraft((cur) => (cur ? { ...cur, ...patch } : cur))
  }

  // --- editor + overview ---
  if (draft) {
    const d = draft
    const k = overview?.kpis
    return (
      <div className="content">
        <div className="doc-editor">
          <div className="doc-editor-head">
            <button
              className="ghost"
              onClick={() => {
                setDraft(null)
                setOverview(null)
                setMsg(null)
                setError(null)
              }}
            >
              Zurück
            </button>
            <strong>{d.id ? d.name || 'Kunde' : 'Neuer Kunde'}</strong>
            {d.id != null && !d.active ? <span className="user-chip">inaktiv</span> : null}
            <div className="spacer" />
            {error && (
              <span className="user-chip" style={{ color: 'var(--danger)' }}>
                {error}
              </span>
            )}
            {msg && <span className="user-chip">{msg}</span>}
            {d.id != null && (
              <button className="danger" onClick={remove} disabled={busy}>
                Löschen
              </button>
            )}
            <button className="primary" onClick={save} disabled={busy || !(d.name ?? '').trim()}>
              {busy ? '…' : 'Speichern'}
            </button>
          </div>

          <div className="doc-grid">
            <div className="field">
              <label>Name / Firma</label>
              <input value={d.name ?? ''} onChange={(e) => setD({ name: e.target.value })} />
            </div>
            <div className="field">
              <label>Ansprechpartner</label>
              <input value={d.contact_name ?? ''} onChange={(e) => setD({ contact_name: e.target.value })} />
            </div>
            <div className="field">
              <label>Kundentyp</label>
              <select value={d.client_type ?? 'geschaeft'} onChange={(e) => setD({ client_type: e.target.value })}>
                {config.clientTypes.map((t) => (
                  <option key={t} value={t}>
                    {CLIENT_TYPE_LABEL[t] ?? t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={!!d.active}
                  onChange={(e) => setD({ active: e.target.checked ? 1 : 0 })}
                />{' '}
                Aktiv
              </label>
            </div>
          </div>

          <fieldset className="doc-block">
            <legend>Adresse & Kontakt</legend>
            <div className="field">
              <label>Straße & Hausnr.</label>
              <input value={d.address ?? ''} onChange={(e) => setD({ address: e.target.value })} />
            </div>
            <div className="row2">
              <div className="field">
                <label>PLZ</label>
                <input value={d.zip ?? ''} onChange={(e) => setD({ zip: e.target.value })} />
              </div>
              <div className="field">
                <label>Ort</label>
                <input value={d.city ?? ''} onChange={(e) => setD({ city: e.target.value })} />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>E-Mail</label>
                <input value={d.email ?? ''} onChange={(e) => setD({ email: e.target.value })} />
              </div>
              <div className="field">
                <label>Telefon</label>
                <input value={d.phone ?? ''} onChange={(e) => setD({ phone: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>USt-IdNr.</label>
              <input value={d.vat_id ?? ''} onChange={(e) => setD({ vat_id: e.target.value })} />
            </div>
            <div className="field">
              <label>Notizen (intern)</label>
              <textarea rows={2} value={d.notes ?? ''} onChange={(e) => setD({ notes: e.target.value })} />
            </div>
          </fieldset>

          {d.id != null && (
            <>
              <div className="doc-editor-head" style={{ marginTop: 8 }}>
                <strong>Schnell anlegen</strong>
                <div className="spacer" />
                <button
                  onClick={() =>
                    onIntent({ type: 'create', module: 'documents', kind: 'rechnung', customer_id: d.id! })
                  }
                >
                  + Rechnung
                </button>
                <button
                  onClick={() =>
                    onIntent({ type: 'create', module: 'documents', kind: 'angebot', customer_id: d.id! })
                  }
                >
                  + Angebot
                </button>
                <button onClick={() => onIntent({ type: 'create', module: 'contracts', customer_id: d.id! })}>
                  + Vertrag
                </button>
                <button onClick={() => onIntent({ type: 'create', module: 'recurring', customer_id: d.id! })}>
                  + Serie
                </button>
              </div>

              {k && (
                <div className="dash-cards" style={{ marginTop: 12 }}>
                  <div className="dash-card">
                    <span className="dash-card-label">Fakturiert</span>
                    <span className="dash-card-value">{euro(k.invoiced_gross_cents)}</span>
                    <span className="dash-card-sub">{k.invoices_count} Rechnung(en)</span>
                  </div>
                  <div className="dash-card">
                    <span className="dash-card-label">Bezahlt</span>
                    <span className="dash-card-value">{euro(k.paid_cents)}</span>
                    <span className="dash-card-sub">
                      offen {euro(k.open_cents)} · {k.quotes_count} Angebot(e)
                    </span>
                  </div>
                  <div className="dash-card">
                    <span className="dash-card-label">Verträge</span>
                    <span className="dash-card-value">{k.contracts_active}</span>
                    <span className="dash-card-sub">
                      aktiv von {k.contracts_total} · {k.series_active} Serie(n)
                    </span>
                  </div>
                </div>
              )}

              {overview && (
                <div style={{ marginTop: 16, display: 'grid', gap: 16 }}>
                  <OverviewTable
                    title="Dokumente"
                    empty="Keine verknüpften Angebote/Rechnungen."
                    rows={overview.documents}
                    columns={['Art', 'Nr.', 'Status', 'Brutto', 'Offen', '']}
                    render={(doc) => (
                      <tr key={doc.id}>
                        <td>{KIND_LABEL[doc.kind] ?? doc.kind}</td>
                        <td>{doc.number ?? '—'}</td>
                        <td>{STATUS_LABEL[doc.status] ?? doc.status}</td>
                        <td className="num">{euro(doc.gross_cents)}</td>
                        <td className="num">{euro(doc.open_cents)}</td>
                        <td>
                          <button
                            className="ghost"
                            onClick={() => onIntent({ type: 'open', module: 'documents', openId: doc.id })}
                          >
                            Öffnen
                          </button>
                        </td>
                      </tr>
                    )}
                  />
                  <OverviewTable
                    title="Verträge"
                    empty="Keine verknüpften Verträge."
                    rows={overview.contracts}
                    columns={['Nr.', 'Titel', 'Status', 'Wert', 'Unterschrift', '']}
                    render={(krow) => (
                      <tr key={krow.id}>
                        <td>{krow.number ?? '—'}</td>
                        <td>{krow.title ?? '—'}</td>
                        <td>{STATUS_LABEL[krow.status] ?? krow.status}</td>
                        <td className="num">{euro(krow.value_cents)}</td>
                        <td>
                          {krow.has_signed_doc ? (
                            <span className="user-chip" title={krow.signed_doc_name ?? undefined}>
                              Unterschrift liegt vor
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>
                          <button
                            className="ghost"
                            onClick={() => onIntent({ type: 'open', module: 'contracts', openId: krow.id })}
                          >
                            Öffnen
                          </button>
                        </td>
                      </tr>
                    )}
                  />
                  <OverviewTable
                    title="Serienrechnungen"
                    empty="Keine verknüpften Serien."
                    rows={overview.recurring}
                    columns={['Titel', 'Vertrag', 'Turnus', 'Nächster Lauf', 'Status', '']}
                    render={(s) => (
                      <tr key={s.id}>
                        <td>{s.title ?? '—'}</td>
                        <td>
                          {s.contract_number
                            ? s.contract_number
                            : s.contract_id != null
                              ? `#${s.contract_id}`
                              : '—'}
                        </td>
                        <td>{CADENCE_LABEL[s.cadence] ?? s.cadence}</td>
                        <td>{fmtDate(s.next_run)}</td>
                        <td>{s.active ? 'aktiv' : 'pausiert'}</td>
                        <td>
                          <button
                            className="ghost"
                            onClick={() => onIntent({ type: 'open', module: 'recurring', openId: s.id })}
                          >
                            Öffnen
                          </button>
                        </td>
                      </tr>
                    )}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">Kunden</h1>
        <input
          className="search"
          placeholder="Suche Name, Ort, E-Mail…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="seg">
          <button className={activeOnly ? 'active' : ''} onClick={() => setActiveOnly(true)}>
            Aktiv
          </button>
          <button className={!activeOnly ? 'active' : ''} onClick={() => setActiveOnly(false)}>
            Alle
          </button>
        </div>
        <span className="user-chip">{visible.length} Kunden</span>
        <div className="spacer" />
        <button className="primary" onClick={startNew}>
          + Kunde
        </button>
      </div>
      <div className="content">
        {error && <div className="section-error">{error}</div>}
        {visible.length === 0 ? (
          <div className="center-muted">
            Noch keine Kunden. Lege einen Kunden an — dann fließen Name und Adresse in Rechnungen, Verträge und
            Serien.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Ort</th>
                  <th>E-Mail</th>
                  <th>Typ</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => openCustomer(c)}>
                    <td>
                      <strong>{c.name}</strong>
                      {c.contact_name ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {c.contact_name}
                        </div>
                      ) : null}
                    </td>
                    <td>{c.city ?? '—'}</td>
                    <td>{c.email ?? '—'}</td>
                    <td>{CLIENT_TYPE_LABEL[c.client_type] ?? c.client_type}</td>
                    <td>{c.active ? 'aktiv' : 'inaktiv'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

function OverviewTable<T>({
  title,
  empty,
  rows,
  columns,
  render,
}: {
  title: string
  empty: string
  rows: T[]
  columns: string[]
  render: (row: T) => ReactNode
}) {
  return (
    <fieldset className="doc-block">
      <legend>{title}</legend>
      {rows.length === 0 ? (
        <div className="muted">{empty}</div>
      ) : (
        <div className="table-wrap">
          <table className="leads">
            <thead>
              <tr>
                {columns.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>{rows.map(render)}</tbody>
          </table>
        </div>
      )}
    </fieldset>
  )
}
