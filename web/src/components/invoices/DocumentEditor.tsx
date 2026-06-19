import { useEffect, useState } from 'react'
import { api } from '../../api'
import { euro, centsToInput, inputToCents, lineTotalCents } from '../../money'
import { fmtDate } from '../../util'
import type { Config, Doc, DocItem, ValidationResult } from '../../types'

const EMPTY_ITEM: DocItem = { description: '', quantity: 1, unit: 'Pauschal', unit_price_cents: 0 }

export function DocumentEditor({
  id,
  config,
  onClose,
  onChanged,
}: {
  id: number
  config: Config
  onClose: () => void
  onChanged: () => void
}) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [items, setItems] = useState<DocItem[]>([])
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    api.getDocument(id).then(({ document }) => {
      if (!active) return
      setDoc(document)
      setItems(document.items.length ? document.items : [{ ...EMPTY_ITEM }])
      setDirty(false)
    })
    return () => {
      active = false
    }
  }, [id])

  if (!doc) return <div className="center-muted">Lädt…</div>

  const locked = !!doc.number // finalised documents are read-only
  const isAngebot = doc.kind === 'angebot'
  const statuses = config.docStatuses[doc.kind] ?? []

  function field<K extends keyof Doc>(k: K, v: Doc[K]) {
    setDoc((d) => (d ? { ...d, [k]: v } : d))
    setDirty(true)
  }

  function setItem(i: number, patch: Partial<DocItem>) {
    setItems((arr) => arr.map((it, j) => (j === i ? { ...it, ...patch } : it)))
    setDirty(true)
  }
  function addItem() {
    setItems((arr) => [...arr, { ...EMPTY_ITEM }])
    setDirty(true)
  }
  function removeItem(i: number) {
    setItems((arr) => arr.filter((_, j) => j !== i))
    setDirty(true)
  }

  const cleanItems = items.filter(
    (it) => (it.description ?? '').trim() || it.unit_price_cents !== 0,
  )
  const net = cleanItems.reduce((s, it) => s + lineTotalCents(it.quantity, it.unit_price_cents), 0)
  const vat = doc.small_business ? 0 : Math.round((net * doc.vat_rate) / 100)
  const gross = net + vat

  async function save(): Promise<Doc> {
    setSaving(true)
    try {
      const { document } = await api.updateDocument(id, {
        client_name: doc!.client_name,
        client_address: doc!.client_address,
        client_zip: doc!.client_zip,
        client_city: doc!.client_city,
        client_email: doc!.client_email,
        buyer_reference: doc!.buyer_reference,
        title: doc!.title,
        intro: doc!.intro,
        notes: doc!.notes,
        due_date: doc!.due_date,
        small_business: doc!.small_business,
        status: doc!.status,
        items: cleanItems,
      })
      setDoc(document)
      setItems(document.items.length ? document.items : [{ ...EMPTY_ITEM }])
      setDirty(false)
      onChanged()
      return document
    } finally {
      setSaving(false)
    }
  }

  async function openPdf() {
    if (dirty && !locked) await save()
    window.open(api.pdfUrl(id), '_blank')
  }

  async function finalize() {
    if (!confirm('Dokument festschreiben? Es bekommt eine fortlaufende Nummer und kann danach nicht mehr geändert werden.')) return
    if (dirty) await save()
    const { document } = await api.finalizeDocument(id)
    setDoc(document)
    onChanged()
  }

  async function convert() {
    const { document } = await api.convertDocument(id)
    onChanged()
    alert(`Rechnung als Entwurf erstellt (${document.title ?? 'Rechnung'}). Du findest sie in der Liste.`)
  }

  async function changeStatus(status: string) {
    field('status', status)
    const { document } = await api.updateDocument(id, { status })
    setDoc(document)
    onChanged()
  }

  async function validate() {
    setValidating(true)
    setValidationError(null)
    try {
      const { validation } = await api.validateDocument(id)
      setValidation(validation)
    } catch (e) {
      setValidation(null)
      setValidationError(e instanceof Error ? e.message : 'Prüfung fehlgeschlagen.')
    } finally {
      setValidating(false)
    }
  }

  return (
    <div className="doc-editor">
      <div className="doc-editor-head">
        <button className="ghost" onClick={onClose}>
          ← Zurück
        </button>
        <strong>
          {isAngebot ? 'Angebot' : 'Rechnung'}
          {doc.number ? ` ${doc.number}` : ' (Entwurf)'}
        </strong>
        <div className="spacer" />
        {!locked && (
          <button className="primary" onClick={save} disabled={saving || !dirty}>
            {saving ? '…' : 'Speichern'}
          </button>
        )}
        <button onClick={openPdf}>📄 PDF</button>
        {!locked && (
          <button onClick={finalize} disabled={cleanItems.length === 0}>
            Festschreiben
          </button>
        )}
        {isAngebot && (
          <button onClick={convert} title="In eine Rechnung umwandeln">
            → Rechnung
          </button>
        )}
        {doc.kind === 'rechnung' && (
          <button
            onClick={validate}
            disabled={validating}
            title="Gegen die EN-16931-Regeln für E-Rechnungen prüfen (für festgeschriebene Rechnungen)"
          >
            {validating ? '…' : 'E-Rechnung prüfen'}
          </button>
        )}
      </div>

      {locked && (
        <div className="doc-locked">
          Festgeschrieben am {doc.issue_date ? fmtDate(doc.issue_date) : '—'} · Nr. {doc.number}.
          Ausgestellte Dokumente sind unveränderlich (GoBD). Für Änderungen{' '}
          {isAngebot ? 'ein neues Angebot' : 'eine Storno-/Korrekturrechnung'} anlegen.
        </div>
      )}

      {validationError && <div className="section-error">{validationError}</div>}

      {validation && (
        <div className="erechnung-panel">
          {validation.valid && validation.errors.length === 0 ? (
            <span className="erechnung-badge erechnung-ok">✓ Gültig (EN 16931)</span>
          ) : (
            <span className="erechnung-badge erechnung-bad">
              Nicht konform ({validation.errors.length}{' '}
              {validation.errors.length === 1 ? 'Fehler' : 'Fehler'})
            </span>
          )}
          <span className="erechnung-meta">
            Profil {validation.profile} · geprüft {fmtDate(validation.checked_at)}
          </span>
          {validation.errors.length > 0 && (
            <ul className="erechnung-list">
              {validation.errors.map((f, i) => (
                <li key={`e${i}`} className="erechnung-error">
                  <code>{f.rule}</code> {f.message}
                </li>
              ))}
            </ul>
          )}
          {validation.warnings.length > 0 && (
            <ul className="erechnung-list">
              {validation.warnings.map((f, i) => (
                <li key={`w${i}`} className="erechnung-warn">
                  <code>{f.rule}</code> {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="doc-grid">
        <div className="field">
          <label>Titel</label>
          <input value={doc.title ?? ''} disabled={locked} onChange={(e) => field('title', e.target.value)} />
        </div>
        {statuses.length > 0 && (
          <div className="field">
            <label>Status</label>
            <select value={doc.status} onChange={(e) => changeStatus(e.target.value)}>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <fieldset className="doc-block">
        <legend>Empfänger</legend>
        <div className="field">
          <label>Name / Firma</label>
          <input value={doc.client_name ?? ''} disabled={locked} onChange={(e) => field('client_name', e.target.value)} />
        </div>
        <div className="field">
          <label>Straße & Hausnr.</label>
          <input value={doc.client_address ?? ''} disabled={locked} onChange={(e) => field('client_address', e.target.value)} />
        </div>
        <div className="row2">
          <div className="field">
            <label>PLZ</label>
            <input value={doc.client_zip ?? ''} disabled={locked} onChange={(e) => field('client_zip', e.target.value)} />
          </div>
          <div className="field">
            <label>Ort</label>
            <input value={doc.client_city ?? ''} disabled={locked} onChange={(e) => field('client_city', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Käuferreferenz / Leitweg-ID</label>
          <input
            value={doc.buyer_reference ?? ''}
            disabled={locked}
            placeholder="z. B. 04011000-1234512345-06 (für Behörden/B2G)"
            onChange={(e) => field('buyer_reference', e.target.value)}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Pflichtangabe für Rechnungen an öffentliche Auftraggeber (XRechnung).
          </div>
        </div>
      </fieldset>

      <div className="field">
        <label>Anschreiben (über der Tabelle)</label>
        <textarea rows={2} value={doc.intro ?? ''} disabled={locked} onChange={(e) => field('intro', e.target.value)} />
      </div>

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
            {items.map((it, i) => (
              <tr key={i}>
                <td>
                  <input
                    value={it.description ?? ''}
                    disabled={locked}
                    placeholder="Leistung…"
                    onChange={(e) => setItem(i, { description: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step="0.5"
                    value={it.quantity}
                    disabled={locked}
                    onChange={(e) => setItem(i, { quantity: Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    value={it.unit ?? ''}
                    disabled={locked}
                    onChange={(e) => setItem(i, { unit: e.target.value })}
                  />
                </td>
                <td className="num">
                  <input
                    defaultValue={centsToInput(it.unit_price_cents)}
                    disabled={locked}
                    onBlur={(e) => setItem(i, { unit_price_cents: inputToCents(e.target.value) })}
                  />
                </td>
                <td className="num cell-total">{euro(lineTotalCents(it.quantity, it.unit_price_cents))}</td>
                <td>
                  {!locked && (
                    <button className="ghost" onClick={() => removeItem(i)} title="Entfernen">
                      ✕
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        {!locked && (
          <button onClick={addItem} style={{ marginTop: 8 }}>
            + Position
          </button>
        )}
      </fieldset>

      <div className="doc-totals">
        {!doc.small_business && (
          <>
            <div>
              <span>Netto</span>
              <span>{euro(net)}</span>
            </div>
            <div>
              <span>zzgl. {doc.vat_rate}% USt.</span>
              <span>{euro(vat)}</span>
            </div>
          </>
        )}
        <div className="grand">
          <span>Gesamt</span>
          <span>{euro(gross)}</span>
        </div>
        {!!doc.small_business && (
          <div className="kleinunternehmer">Kleinunternehmer §19 UStG — keine USt. ausgewiesen.</div>
        )}
      </div>

      <div className="field">
        <label>Fußnote / Hinweise</label>
        <textarea rows={2} value={doc.notes ?? ''} disabled={locked} onChange={(e) => field('notes', e.target.value)} />
      </div>
    </div>
  )
}
