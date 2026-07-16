import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../../api'
import { invalidateCustomersCache } from '../../customersCache'
import { euro } from '../../money'
import { fmtDate, useEscapeKey } from '../../util'
import type { Config, Contract, Customer, CustomerOverview, Doc, RecurringInvoice } from '../../types'
import type { BackTarget, ModuleIntent } from '../SuiteNav'

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

const LAST_CUSTOMER_KEY = 'openleads.lastCustomerId'

export function CustomersView({
  config,
  onIntent,
  intent,
  onIntentConsumed,
}: {
  config: Config
  onIntent: (intent: ModuleIntent) => void
  intent?: Extract<NonNullable<ModuleIntent>, { module: 'customers' }> | null
  onIntentConsumed?: () => void
}) {
  const [rows, setRows] = useState<Customer[]>([])
  const [loaded, setLoaded] = useState(false)
  const [q, setQ] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [overview, setOverview] = useState<CustomerOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // Attach existing Belege (docs / contracts / series) to this customer.
  type AttachKind = 'documents' | 'contracts' | 'recurring'
  const [attachKind, setAttachKind] = useState<AttachKind | null>(null)
  const [attachCandidates, setAttachCandidates] = useState<
    { id: number; label: string; sub: string }[]
  >([])
  const [attachSelected, setAttachSelected] = useState<Set<number>>(new Set())
  const [attachQ, setAttachQ] = useState('')
  const [attachBusy, setAttachBusy] = useState(false)
  const [attachLoading, setAttachLoading] = useState(false)

  const refresh = useCallback(async () => {
    const { customers } = await api.listCustomers(false)
    setRows(customers)
  }, [])

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : 'Laden fehlgeschlagen.'))
      .finally(() => setLoaded(true))
  }, [refresh])

  // Restore last open customer when returning to the tab (no cold empty list).
  useEffect(() => {
    if (intent) return
    if (draft) return
    const raw = sessionStorage.getItem(LAST_CUSTOMER_KEY)
    if (!raw) return
    const id = Number(raw)
    if (!Number.isFinite(id)) return
    let alive = true
    api
      .getCustomer(id)
      .then(({ customer }) => {
        if (alive) void openCustomer(customer)
      })
      .catch(() => {
        sessionStorage.removeItem(LAST_CUSTOMER_KEY)
      })
    return () => {
      alive = false
    }
    // Only on mount — openCustomer is stable enough for this restore path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Open customer from Lead → Kunde intent.
  useEffect(() => {
    if (!intent || intent.type !== 'open') return
    let alive = true
    api
      .getCustomer(intent.openId)
      .then(({ customer }) => {
        if (!alive) return
        void openCustomer(customer)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Kunde nicht gefunden.')
      })
      .finally(() => {
        if (alive) onIntentConsumed?.()
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.type === 'open' ? intent.openId : null])

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((c) => {
      if (activeOnly && !c.active) return false
      if (!needle) return true
      const hay = [c.name, c.city, c.email, c.contact_name, c.phone].filter(Boolean).join(' ').toLowerCase()
      return hay.includes(needle)
    })
  }, [rows, q, activeOnly])

  async function loadOverview(customerId: number) {
    setOverviewLoading(true)
    try {
      const { overview: o } = await api.customerOverview(customerId)
      setOverview(o)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Übersicht konnte nicht geladen werden.')
    } finally {
      setOverviewLoading(false)
    }
  }

  async function openCustomer(c: Customer) {
    setError(null)
    setMsg(null)
    setDraft({ ...c })
    try {
      sessionStorage.setItem(LAST_CUSTOMER_KEY, String(c.id))
    } catch {
      /* ignore */
    }
    // Keep previous overview visible while reloading when re-opening same id.
    if (overview?.customer.id !== c.id) setOverview(null)
    await loadOverview(c.id)
  }

  async function openAttach(kind: AttachKind) {
    if (!draft?.id) return
    setAttachKind(kind)
    setAttachSelected(new Set())
    setAttachQ('')
    setAttachCandidates([])
    setAttachLoading(true)
    setError(null)
    try {
      if (kind === 'documents') {
        const { documents } = await api.listDocuments()
        setAttachCandidates(
          documents
            .filter((d: Doc) => d.customer_id == null)
            .map((d) => ({
              id: d.id,
              label: `${KIND_LABEL[d.kind] ?? d.kind}${d.number ? ` ${d.number}` : ' (Entwurf)'}`,
              sub: [d.client_name, d.title, d.status].filter(Boolean).join(' · '),
            })),
        )
      } else if (kind === 'contracts') {
        const { contracts } = await api.listContracts()
        setAttachCandidates(
          contracts
            .filter((k: Contract) => k.customer_id == null)
            .map((k) => ({
              id: k.id,
              label: k.number ? `Vertrag ${k.number}` : `Entwurf: ${k.title ?? 'Vertrag'}`,
              sub: [k.client_name, k.title, STATUS_LABEL[k.status] ?? k.status].filter(Boolean).join(' · '),
            })),
        )
      } else {
        const { recurring } = await api.listRecurring()
        setAttachCandidates(
          recurring
            .filter((r: RecurringInvoice) => r.customer_id == null)
            .map((r) => ({
              id: r.id,
              label: r.title ?? 'Serienrechnung',
              sub: [r.client_name, CADENCE_LABEL[r.cadence] ?? r.cadence].filter(Boolean).join(' · '),
            })),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Liste konnte nicht geladen werden.')
      setAttachKind(null)
    } finally {
      setAttachLoading(false)
    }
  }

  async function confirmAttach() {
    if (!draft?.id || !attachKind || attachSelected.size === 0) return
    setAttachBusy(true)
    setError(null)
    try {
      const ids = [...attachSelected]
      for (const id of ids) {
        if (attachKind === 'documents') await api.updateDocument(id, { customer_id: draft.id })
        else if (attachKind === 'contracts') await api.updateContract(id, { customer_id: draft.id })
        else await api.updateRecurring(id, { customer_id: draft.id })
      }
      setAttachKind(null)
      setMsg(
        ids.length === 1
          ? '1 Beleg verknüpft.'
          : `${ids.length} Belege verknüpft.`,
      )
      await loadOverview(draft.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verknüpfen fehlgeschlagen.')
    } finally {
      setAttachBusy(false)
    }
  }

  /** Remove the Stamm-link from one Beleg (snapshot untouched, re-linkable any time). */
  async function detach(kind: AttachKind, id: number) {
    if (!draft?.id) return
    setError(null)
    try {
      if (kind === 'documents') await api.updateDocument(id, { customer_id: null })
      else if (kind === 'contracts') await api.updateContract(id, { customer_id: null })
      else await api.updateRecurring(id, { customer_id: null })
      setMsg('Verknüpfung gelöst.')
      await loadOverview(draft.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lösen fehlgeschlagen.')
    }
  }

  /** Detach the pipeline lead from this customer (registry link only). */
  async function detachLead() {
    if (!draft?.id) return
    setError(null)
    try {
      const { customer } = await api.updateCustomer(draft.id, { lead_id: null })
      setDraft(customer)
      setMsg('Lead-Verknüpfung gelöst.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lösen fehlgeschlagen.')
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
      invalidateCustomersCache()
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
      invalidateCustomersCache()
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
    // Cross-module jumps from this editor return here (same customer re-opened).
    const backHere = (): BackTarget => ({
      label: `Kunde ${(d.name ?? '').trim()}`.trim(),
      module: 'customers',
      openId: d.id ?? undefined,
    })
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
                try {
                  sessionStorage.removeItem(LAST_CUSTOMER_KEY)
                } catch {
                  /* ignore */
                }
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
            {d.lead_id != null && (
              <div className="muted" style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Verknüpfter Lead #{d.lead_id}</span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    onIntent({
                      type: 'open',
                      module: 'leads',
                      openId: d.lead_id!,
                      back: backHere(),
                    })
                  }
                >
                  Lead öffnen
                </button>
                <button type="button" className="ghost" onClick={detachLead}>
                  Lösen
                </button>
              </div>
            )}
          </fieldset>

          {d.id != null && (
            <>
              <div className="doc-editor-head" style={{ marginTop: 8 }}>
                <strong>Schnell anlegen</strong>
                <div className="spacer" />
                <button
                  onClick={() =>
                    onIntent({ type: 'create', module: 'documents', kind: 'rechnung', customer_id: d.id!, back: backHere() })
                  }
                >
                  + Rechnung
                </button>
                <button
                  onClick={() =>
                    onIntent({ type: 'create', module: 'documents', kind: 'angebot', customer_id: d.id!, back: backHere() })
                  }
                >
                  + Angebot
                </button>
                <button onClick={() => onIntent({ type: 'create', module: 'contracts', customer_id: d.id!, back: backHere() })}>
                  + Vertrag
                </button>
                <button onClick={() => onIntent({ type: 'create', module: 'recurring', customer_id: d.id!, back: backHere() })}>
                  + Serie
                </button>
              </div>

              {overviewLoading && !k && (
                <div className="center-muted" style={{ marginTop: 16 }}>
                  Lädt Übersicht…
                </div>
              )}

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
                    action={
                      <button className="ghost" type="button" onClick={() => openAttach('documents')}>
                        Bestehende verknüpfen
                      </button>
                    }
                    rows={overview.documents}
                    columns={['Art', 'Nr.', 'Status', 'Brutto', 'Offen', '']}
                    render={(doc) => (
                      <tr key={doc.id}>
                        <td>{KIND_LABEL[doc.kind] ?? doc.kind}</td>
                        <td>{doc.number ?? '—'}</td>
                        <td>{STATUS_LABEL[doc.status] ?? doc.status}</td>
                        <td className="num">{euro(doc.gross_cents)}</td>
                        <td className="num">{euro(doc.open_cents)}</td>
                        <td className="row-actions">
                          <button
                            className="ghost"
                            onClick={() => onIntent({ type: 'open', module: 'documents', openId: doc.id, back: backHere() })}
                          >
                            Öffnen
                          </button>
                          <button
                            className="ghost"
                            title="Kunden-Verknüpfung lösen (Beleg bleibt erhalten)"
                            onClick={() => detach('documents', doc.id)}
                          >
                            Lösen
                          </button>
                        </td>
                      </tr>
                    )}
                  />
                  <OverviewTable
                    title="Verträge"
                    empty="Keine verknüpften Verträge."
                    action={
                      <button className="ghost" type="button" onClick={() => openAttach('contracts')}>
                        Bestehende verknüpfen
                      </button>
                    }
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
                        <td className="row-actions">
                          <button
                            className="ghost"
                            onClick={() => onIntent({ type: 'open', module: 'contracts', openId: krow.id, back: backHere() })}
                          >
                            Öffnen
                          </button>
                          <button
                            className="ghost"
                            title="Kunden-Verknüpfung lösen (Vertrag bleibt erhalten)"
                            onClick={() => detach('contracts', krow.id)}
                          >
                            Lösen
                          </button>
                        </td>
                      </tr>
                    )}
                  />
                  <OverviewTable
                    title="Serienrechnungen"
                    empty="Keine verknüpften Serien."
                    action={
                      <button className="ghost" type="button" onClick={() => openAttach('recurring')}>
                        Bestehende verknüpfen
                      </button>
                    }
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
                        <td className="row-actions">
                          <button
                            className="ghost"
                            onClick={() => onIntent({ type: 'open', module: 'recurring', openId: s.id, back: backHere() })}
                          >
                            Öffnen
                          </button>
                          <button
                            className="ghost"
                            title="Kunden-Verknüpfung lösen (Serie bleibt erhalten)"
                            onClick={() => detach('recurring', s.id)}
                          >
                            Lösen
                          </button>
                        </td>
                      </tr>
                    )}
                  />
                </div>
              )}

              {attachKind && (
                <AttachModal
                  kind={attachKind}
                  loading={attachLoading}
                  busy={attachBusy}
                  candidates={attachCandidates}
                  selected={attachSelected}
                  query={attachQ}
                  onQuery={setAttachQ}
                  onToggle={(id) => {
                    setAttachSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(id)) next.delete(id)
                      else next.add(id)
                      return next
                    })
                  }}
                  onClose={() => setAttachKind(null)}
                  onConfirm={confirmAttach}
                />
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
        {!loaded ? (
          <div className="center-muted">Lädt…</div>
        ) : visible.length === 0 ? (
          <div className="center-muted">
            Noch keine Kunden. Lege einen Kunden an, oder öffne einen Lead und wähle „Als Kunde anlegen".
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
  action,
}: {
  title: string
  empty: string
  rows: T[]
  columns: string[]
  render: (row: T) => ReactNode
  action?: ReactNode
}) {
  return (
    <fieldset className="doc-block">
      <legend style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
        <span>{title}</span>
        {action ? <span style={{ marginLeft: 'auto', fontWeight: 400 }}>{action}</span> : null}
      </legend>
      {rows.length === 0 ? (
        <div className="muted">{empty}</div>
      ) : (
        <div className="table-wrap">
          <table className="leads">
            <thead>
              <tr>
                {columns.map((h) => (
                  <th key={h}>{h || ' '}</th>
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

function AttachModal({
  kind,
  loading,
  busy,
  candidates,
  selected,
  query,
  onQuery,
  onToggle,
  onClose,
  onConfirm,
}: {
  kind: 'documents' | 'contracts' | 'recurring'
  loading: boolean
  busy: boolean
  candidates: { id: number; label: string; sub: string }[]
  selected: Set<number>
  query: string
  onQuery: (q: string) => void
  onToggle: (id: number) => void
  onClose: () => void
  onConfirm: () => void
}) {
  useEscapeKey(() => {
    if (!busy) onClose()
  })
  const title =
    kind === 'documents'
      ? 'Bestehende Dokumente verknüpfen'
      : kind === 'contracts'
        ? 'Bestehende Verträge verknüpfen'
        : 'Bestehende Serien verknüpfen'
  const needle = query.trim().toLowerCase()
  const visible = candidates.filter((c) => {
    if (!needle) return true
    return `${c.label} ${c.sub}`.toLowerCase().includes(needle)
  })

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => {
        if (!busy) onClose()
      }}
    >
      <div className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          Nur Belege <strong>ohne</strong> Kunden-Verknüpfung. Festgeschriebene Belege behalten ihren
          Empfängertext — es ändert sich nur die Stamm-Verknüpfung.
        </p>
        <input
          className="search"
          placeholder="Suche Nummer, Name, Titel…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          style={{ width: '100%' }}
        />
        {loading ? (
          <div className="center-muted" style={{ padding: 16 }}>
            Lädt…
          </div>
        ) : visible.length === 0 ? (
          <div className="center-muted" style={{ padding: 16 }}>
            Keine unverknüpften Belege gefunden.
          </div>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="leads">
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => onToggle(c.id)}>
                    <td style={{ width: 32 }}>
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => onToggle(c.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td>
                      <strong>{c.label}</strong>
                      {c.sub ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                          {c.sub}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="modal-actions" style={{ alignItems: 'center' }}>
          <span className="user-chip" style={{ marginRight: 'auto' }}>
            {selected.size} ausgewählt
          </span>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Abbrechen
          </button>
          <button
            className="primary"
            type="button"
            onClick={onConfirm}
            disabled={busy || selected.size === 0}
          >
            {busy ? '…' : 'Verknüpfen'}
          </button>
        </div>
      </div>
    </div>
  )
}
