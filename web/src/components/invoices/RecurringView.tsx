import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro, centsToInput, inputToCents, lineTotalCents } from '../../money'
import { fmtDate, todayISO } from '../../util'
import { CatalogPicker, catalogItemToLine } from './CatalogPicker'
import type { Config, DocItem, RecurringInvoice } from '../../types'

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
    include_payment_link: 1,
    itemList: [{ ...EMPTY_ITEM }],
  }
}

export function RecurringView({ config }: { config: Config }) {
  const [rows, setRows] = useState<RecurringInvoice[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const { recurring } = await api.listRecurring()
    setRows(recurring)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function runDue() {
    setBusy(true)
    setMsg(null)
    try {
      const { generated } = await api.runDueRecurring()
      setMsg(
        generated
          ? `${generated} Rechnungsentwurf/-entwürfe erzeugt — unter „Rechnungen" prüfen und festschreiben.`
          : 'Keine fälligen Abos.',
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
    if (!confirm('Abo löschen? Bereits erzeugte Rechnungen bleiben erhalten.')) return
    await api.deleteRecurring(id)
    await refresh()
  }

  async function saveDraft() {
    if (!draft) return
    setBusy(true)
    try {
      const items = draft.itemList.filter((it) => (it.description ?? '').trim() || it.unit_price_cents !== 0)
      const body = {
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
        include_payment_link: draft.include_payment_link,
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
            <strong>{d.id ? 'Abo bearbeiten' : 'Neues Abo'}</strong>
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
                  {d.itemList.map((it, i) => (
                    <tr key={i}>
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
        <span className="page-title">Abo-Rechnungen</span>
        <span className="user-chip">{rows.length} Abos</span>
        <div className="spacer" />
        <button onClick={runDue} disabled={busy}>Fällige jetzt erzeugen</button>
        <button className="primary" onClick={() => setDraft(blankDraft(config))}>+ Neues Abo</button>
      </div>

      <div className="content">
        <p className="settings-hint">
          Ein Abo erzeugt je Turnus einen <strong>Rechnungsentwurf</strong> — du prüfst und schreibst ihn
          selbst fest. Nichts wird automatisch versendet.
        </p>
        {msg && <div className="section-info">{msg}</div>}

        {rows.length === 0 ? (
          <div className="center-muted">Noch keine Abos. Lege eins an, z. B. für eine monatliche Wartungspauschale.</div>
        ) : (
          <div className="table-wrap">
            <table className="leads">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Kunde</th>
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
                    <td data-label="Turnus">{CADENCE_LABEL[r.cadence] ?? r.cadence}</td>
                    <td data-label="Nächster Lauf">{fmtDate(r.next_run)}</td>
                    <td data-label="Letzter Lauf">{r.last_run ? fmtDate(r.last_run) : '—'}</td>
                    <td data-label="Status">
                      <span className={`doc-status doc-status-${r.active ? 'versendet' : 'storniert'}`}>
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
