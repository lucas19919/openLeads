import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { getActiveCustomers } from '../../customersCache'
import { euro, centsToInput, inputToCents, lineTotalCents } from '../../money'
import { fmtDate, todayISO } from '../../util'
import { CatalogPicker, catalogItemToLine } from './CatalogPicker'
import { CustomerPicker } from '../CustomerPicker'
import type { Config, Customer, DocItem, RecurringInvoice } from '../../types'
import type { ModuleIntent } from '../SuiteNav'

const CADENCE_LABEL: Record<string, string> = {
  monatlich: 'Monatlich',
  quartalsweise: 'Quartalsweise',
  jährlich: 'Jährlich',
}
const CLIENT_TYPE_LABEL: Record<string, string> = { geschaeft: 'Geschäft (B2B)', privat: 'Privat (B2C)' }
const EMPTY_ITEM: DocItem = { description: '', quantity: 1, unit: 'Monat', unit_price_cents: 0 }

type Draft = Partial<RecurringInvoice> & { itemList: DocItem[] }

function toDraft(r: RecurringInvoice): Draft {
  let itemList: DocItem[] = []
  try {
    itemList = JSON.parse(r.items)
  } catch {
    itemList = []
  }
  return { ...r, itemList: itemList.length ? itemList : [{ ...EMPTY_ITEM }] }
}

function blankDraft(config: Config): Draft {
  return {
    client_name: '',
    client_type: config.clientTypes[0] ?? 'geschaeft',
    title: 'Rechnung',
    intro: '',
    notes: '',
    cadence: config.cadences[0] ?? 'monatlich',
    next_run: todayISO(),
    small_business: 1,
    vat_rate: 19,
    active: 1,
    itemList: [{ ...EMPTY_ITEM }],
  }
}

type RecurringIntent = Extract<NonNullable<ModuleIntent>, { module: 'recurring' }>

export function RecurringView({
  config,
  intent,
  onIntentConsumed,
  onIntent,
}: {
  config: Config
  intent?: RecurringIntent | null
  onIntentConsumed?: () => void
  /** Cross-module jumps (open the linked Vertrag). */
  onIntent?: (intent: ModuleIntent) => void
}) {
  const [rows, setRows] = useState<RecurringInvoice[]>([])
  const [loaded, setLoaded] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [filterCustomerId, setFilterCustomerId] = useState<number | ''>('')
  const [customers, setCustomers] = useState<Customer[]>([])

  const refresh = useCallback(async () => {
    const { recurring } = await api.listRecurring(
      filterCustomerId === '' ? {} : { customer_id: filterCustomerId },
    )
    setRows(recurring)
  }, [filterCustomerId])

  useEffect(() => {
    refresh().finally(() => setLoaded(true))
  }, [refresh])

  useEffect(() => {
    getActiveCustomers().then(setCustomers).catch(() => {})
  }, [])

  // Ref-only idempotency guard — see InvoicesView: an `active`-cancel here would
  // make StrictMode swallow the intent (and orphan the created series).
  const intentKey = intent
    ? intent.type === 'open'
      ? `open-${intent.openId}`
      : `create-${intent.customer_id}`
    : null
  const handledIntent = useRef<string | null>(null)
  useEffect(() => {
    if (!intent || !intentKey) {
      if (!intent) handledIntent.current = null
      return
    }
    if (handledIntent.current === intentKey) return
    handledIntent.current = intentKey
    ;(async () => {
      try {
        if (intent.type === 'open') {
          const { recurring } = await api.listRecurring()
          const row = recurring.find((r) => r.id === intent.openId)
          if (row) setDraft(toDraft(row))
          return
        }
        const { recurring: created } = await api.createRecurring({ customer_id: intent.customer_id })
        await refresh()
        setDraft(toDraft(created))
      } catch (e) {
        setMsg(e instanceof Error ? e.message : 'Aktion fehlgeschlagen.')
      } finally {
        onIntentConsumed?.()
      }
    })()
  }, [intent, intentKey, refresh, onIntentConsumed])

  async function runDue() {
    setBusy(true)
    setMsg(null)
    try {
      const { generated } = await api.runDueRecurring()
      setMsg(
        generated
          ? `${generated} Rechnungsentwurf/-entwürfe erzeugt — unter „Rechnungen" prüfen und festschreiben.`
          : 'Keine fälligen Serienrechnungen.',
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function runOne(id: number) {
    setBusy(true)
    setMsg(null)
    try {
      await api.runRecurring(id)
      setMsg('Entwurf erzeugt — unter „Rechnungen" prüfen und festschreiben.')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(r: RecurringInvoice) {
    await api.updateRecurring(r.id, { active: r.active ? 0 : 1 })
    await refresh()
  }

  async function remove(id: number) {
    if (!confirm('Serienrechnung löschen? Bereits erzeugte Rechnungen bleiben erhalten.')) return
    await api.deleteRecurring(id)
    await refresh()
  }

  async function saveDraft() {
    if (!draft) return
    setBusy(true)
    try {
      const items = draft.itemList.filter((it) => (it.description ?? '').trim() || it.unit_price_cents !== 0)
      const body = {
        customer_id: draft.customer_id ?? null,
        contract_id: draft.contract_id ?? null,
        client_name: draft.client_name,
        client_address: draft.client_address,
        client_zip: draft.client_zip,
        client_city: draft.client_city,
        client_email: draft.client_email,
        client_type: draft.client_type,
        title: draft.title,
        intro: draft.intro,
        notes: draft.notes,
        cadence: draft.cadence,
        next_run: draft.next_run,
        small_business: draft.small_business,
        vat_rate: draft.vat_rate,
        active: draft.active,
        items,
      }
      if (draft.id) await api.updateRecurring(draft.id, body)
      else await api.createRecurring(body)
      setDraft(null)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  // --- editor ---
  if (draft) {
    const d = draft
    const setD = (patch: Partial<Draft>) => setDraft((cur) => (cur ? { ...cur, ...patch } : cur))
    const setItem = (i: number, patch: Partial<DocItem>) =>
      setD({ itemList: d.itemList.map((it, j) => (j === i ? { ...it, ...patch } : it)) })
    const net = d.itemList.reduce((s, it) => s + lineTotalCents(it.quantity, it.unit_price_cents), 0)
    const gross = d.small_business ? net : net + Math.round((net * (d.vat_rate ?? 19)) / 100)
    return (
      <div className="content">
        <div className="doc-editor">
          <div className="doc-editor-head">
            <button className="ghost" onClick={() => setDraft(null)}>Zurück</button>
            <strong>{d.id ? 'Serie bearbeiten' : 'Neue Serie'}</strong>
            {d.contract_id != null &&
              (onIntent ? (
                <button
                  type="button"
                  className="ghost"
                  title="Verknüpften Vertrag öffnen"
                  onClick={() =>
                    onIntent({
                      type: 'open',
                      module: 'contracts',
                      openId: d.contract_id!,
                      back: {
                        label: `Serie ${d.title ?? ''}`.trim(),
                        module: 'recurring',
                        openId: d.id ?? undefined,
                      },
                    })
                  }
                >
                  Vertrag #{d.contract_id} öffnen
                </button>
              ) : (
                <span className="user-chip">Vertrag #{d.contract_id}</span>
              ))}
            <div className="spacer" />
            <button className="primary" onClick={saveDraft} disabled={busy}>
              {busy ? '…' : 'Speichern'}
            </button>
          </div>

          <div className="doc-grid">
            <div className="field">
              <label>Titel</label>
              <input value={d.title ?? ''} onChange={(e) => setD({ title: e.target.value })} />
            </div>
            <div className="field">
              <label>Turnus</label>
              <select value={d.cadence} onChange={(e) => setD({ cadence: e.target.value })}>
                {config.cadences.map((c) => (
                  <option key={c} value={c}>{CADENCE_LABEL[c] ?? c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Nächster Lauf</label>
              <input type="date" value={d.next_run ?? ''} onChange={(e) => setD({ next_run: e.target.value })} />
            </div>
          </div>

          <fieldset className="doc-block">
            <legend>Empfänger</legend>
            <CustomerPicker
              value={d.customer_id}
              onSelect={(c: Customer | null) => {
                if (!c) {
                  setD({ customer_id: null })
                  return
                }
                setD({
                  customer_id: c.id,
                  client_name: c.name,
                  client_address: c.address,
                  client_zip: c.zip,
                  client_city: c.city,
                  client_email: c.email,
                  client_type: c.client_type,
                })
              }}
            />
            <div className="field">
              <label>Name / Firma</label>
              <input value={d.client_name ?? ''} onChange={(e) => setD({ client_name: e.target.value })} />
            </div>
            <div className="row2">
              <div className="field">
                <label>Straße & Hausnr.</label>
                <input value={d.client_address ?? ''} onChange={(e) => setD({ client_address: e.target.value })} />
              </div>
              <div className="field">
                <label>Kundentyp</label>
                <select value={d.client_type} onChange={(e) => setD({ client_type: e.target.value })}>
                  {config.clientTypes.map((t) => (
                    <option key={t} value={t}>{CLIENT_TYPE_LABEL[t] ?? t}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>PLZ</label>
                <input value={d.client_zip ?? ''} onChange={(e) => setD({ client_zip: e.target.value })} />
              </div>
              <div className="field">
                <label>Ort</label>
                <input value={d.client_city ?? ''} onChange={(e) => setD({ client_city: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label>E-Mail</label>
              <input value={d.client_email ?? ''} onChange={(e) => setD({ client_email: e.target.value })} />
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Positionen</legend>
            <div className="table-wrap">
              <table className="items-table">
                <thead>
                  <tr>
                    <th>Beschreibung</th>
                    <th className="num">Menge</th>
                    <th>Einh.</th>
                    <th className="num">Einzelpreis</th>
                    <th className="num">Gesamt</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {/* Key by series id too — the editor survives draft switches
                      (quick-search jumps), and index keys would leave stale
                      uncontrolled price inputs. */}
                  {d.itemList.map((it, i) => (
                    <tr key={`${d.id ?? 'neu'}:${i}`}>
                      <td data-label="Beschreibung"><input value={it.description ?? ''} placeholder="Leistung…" onChange={(e) => setItem(i, { description: e.target.value })} /></td>
                      <td data-label="Menge" className="num"><input type="number" step="0.5" value={it.quantity} onChange={(e) => setItem(i, { quantity: Number(e.target.value) })} /></td>
                      <td data-label="Einheit"><input value={it.unit ?? ''} onChange={(e) => setItem(i, { unit: e.target.value })} /></td>
                      <td data-label="Einzelpreis" className="num"><input defaultValue={centsToInput(it.unit_price_cents)} onBlur={(e) => setItem(i, { unit_price_cents: inputToCents(e.target.value) })} /></td>
                      <td data-label="Gesamt" className="num cell-total">{euro(lineTotalCents(it.quantity, it.unit_price_cents))}</td>
                      <td data-label=""><button className="ghost" onClick={() => setD({ itemList: d.itemList.filter((_, j) => j !== i) })}>Entfernen</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setD({ itemList: [...d.itemList, { ...EMPTY_ITEM }] })}>+ Position</button>
              <CatalogPicker
                onPick={(it) => {
                  const line = catalogItemToLine(it)
                  const arr = d.itemList
                  const onlyEmptyStarter =
                    arr.length === 1 && !(arr[0].description ?? '').trim() && arr[0].unit_price_cents === 0
                  setD({ itemList: onlyEmptyStarter ? [line] : [...arr, line] })
                }}
              />
            </div>
          </fieldset>

          <div className="doc-grid">
            <label className="check-row">
              <input type="checkbox" checked={!!d.small_business} onChange={(e) => setD({ small_business: e.target.checked ? 1 : 0 })} />
              Kleinunternehmer §19 (keine USt.)
            </label>
            {!d.small_business && (
              <div className="field">
                <label>USt-Satz (%)</label>
                <input type="number" value={d.vat_rate ?? 19} onChange={(e) => setD({ vat_rate: Number(e.target.value) })} />
              </div>
            )}
            <div className="field">
              <label>Summe je Lauf</label>
              <input value={euro(gross)} disabled />
            </div>
          </div>

          <div className="field">
            <label>Anschreiben</label>
            <textarea rows={2} value={d.intro ?? ''} onChange={(e) => setD({ intro: e.target.value })} />
          </div>
          <div className="field">
            <label>Fußnote / Hinweise</label>
            <textarea rows={2} value={d.notes ?? ''} onChange={(e) => setD({ notes: e.target.value })} />
          </div>
        </div>
      </div>
    )
  }

  // --- list ---
  return (
    <>
      <div className="toolbar">
        <h1 className="page-title">Serienrechnungen</h1>
        <select
          value={filterCustomerId === '' ? '' : String(filterCustomerId)}
          onChange={(e) => setFilterCustomerId(e.target.value ? Number(e.target.value) : '')}
          style={{ maxWidth: 220 }}
          title="Nach Kunde filtern"
        >
          <option value="">Alle Kunden</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span className="user-chip">{rows.length} Serien</span>
        <div className="spacer" />
        <button onClick={runDue} disabled={busy}>Fällige jetzt erzeugen</button>
        <button className="primary" onClick={() => setDraft(blankDraft(config))}>+ Neue Serie</button>
      </div>

      <div className="content">
        <div className="hint">
          Eine Serienrechnung (z.&nbsp;B. Hosting-/Wartungsvertrag) erzeugt je Turnus einen{' '}
          <strong>Rechnungsentwurf</strong> — du prüfst und schreibst ihn selbst fest. Nichts wird
          automatisch versendet.
        </div>
        {msg && <div className="section-info">{msg}</div>}

        {!loaded ? (
          <div className="center-muted">Lädt…</div>
        ) : rows.length === 0 ? (
          <div className="center-muted">
            Noch keine Serienrechnungen. Lege eine an, z.&nbsp;B. für eine monatliche Wartungspauschale —
            oder starte vom Vertrag aus („Serie anlegen“).
          </div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Kunde</th>
                  <th>Vertrag</th>
                  <th>Turnus</th>
                  <th>Nächster Lauf</th>
                  <th>Letzter Lauf</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setDraft(toDraft(r))}>
                    <td data-label="Titel" className="cell-primary">{r.title ?? '—'}</td>
                    <td data-label="Kunde">{r.client_name ?? '—'}</td>
                    <td data-label="Vertrag">{r.contract_id != null ? `#${r.contract_id}` : '—'}</td>
                    <td data-label="Turnus">{CADENCE_LABEL[r.cadence] ?? r.cadence}</td>
                    <td data-label="Nächster Lauf">{fmtDate(r.next_run)}</td>
                    <td data-label="Letzter Lauf">{r.last_run ? fmtDate(r.last_run) : '—'}</td>
                    <td data-label="Status">
                      {/* Paused is a neutral state — never the storno/danger red. */}
                      <span className={`doc-status doc-status-${r.active ? 'versendet' : 'entwurf'}`}>
                        {r.active ? 'aktiv' : 'pausiert'}
                      </span>
                    </td>
                    <td data-label="" onClick={(e) => e.stopPropagation()}>
                      <button className="ghost" onClick={() => runOne(r.id)} disabled={busy} title="Jetzt einen Entwurf erzeugen">Erzeugen</button>
                      <button className="ghost" onClick={() => toggleActive(r)}>{r.active ? 'Pausieren' : 'Aktivieren'}</button>
                      <button className="ghost" onClick={() => remove(r.id)}>Löschen</button>
                    </td>
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
