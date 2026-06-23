import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro, centsToInput, inputToCents, lineTotalCents } from '../../money'
import { fmtDate, todayISO } from '../../util'
import type { Config, Doc, DocItem, Payment, ValidationResult } from '../../types'

const EMPTY_ITEM: DocItem = { description: '', quantity: 1, unit: 'Pauschal', unit_price_cents: 0 }
const CLIENT_TYPE_LABEL: Record<string, string> = { geschaeft: 'Geschäft (B2B)', privat: 'Privat (B2C)' }

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
  // Payments (only for finalised invoices).
  const [payments, setPayments] = useState<Payment[]>([])
  const [paySummary, setPaySummary] = useState<{ paid_cents: number; outstanding_cents: number } | null>(null)
  const [payAmount, setPayAmount] = useState('')
  const [payDate, setPayDate] = useState(todayISO())
  const [payMethod, setPayMethod] = useState('Überweisung')
  // Integration actions (pay link, e-mail send, VIES check).
  const [busy, setBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [payLink, setPayLink] = useState<string | null>(null)
  const [vatResult, setVatResult] = useState<string | null>(null)

  const isFinalInvoice = !!doc && doc.kind === 'rechnung' && !!doc.number

  const loadPayments = useCallback(async () => {
    if (!isFinalInvoice) return
    const s = await api.listPayments(id)
    setPayments(s.payments)
    setPaySummary({ paid_cents: s.paid_cents, outstanding_cents: s.outstanding_cents })
  }, [id, isFinalInvoice])

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

  useEffect(() => {
    loadPayments()
  }, [loadPayments])

  if (!doc) return <div className="center-muted">Lädt…</div>

  const locked = !!doc.number // finalised documents are read-only
  const isAngebot = doc.kind === 'angebot'
  const statuses = config.docStatuses[doc.kind] ?? []
  const clientTypes = config.clientTypes ?? ['geschaeft', 'privat']

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
        client_type: doc!.client_type,
        buyer_reference: doc!.buyer_reference,
        client_vat_id: doc!.client_vat_id,
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

  // Payment due date drives the Mahnungen list. Editable even after finalisation
  // (extending a deadline is a real action); persisted immediately when locked
  // since there is no Save button then.
  async function changeDueDate(due: string) {
    const v = due || null
    field('due_date', v)
    if (locked) {
      const { document } = await api.updateDocument(id, { due_date: v })
      setDoc(document)
      onChanged()
    }
  }

  // Debtor type drives the §288 dunning Pauschale (B2B only). Editable even after
  // finalisation; persisted immediately when locked (no Save button then).
  async function changeClientType(ct: string) {
    field('client_type', ct)
    if (locked) {
      const { document } = await api.updateDocument(id, { client_type: ct })
      setDoc(document)
      onChanged()
    }
  }

  // Recipient e-mail for "Per E-Mail senden". Editable even after finalisation
  // (the invoice is sent after festschreiben); persisted immediately when locked
  // since there is no Save button then.
  async function changeClientEmail(email: string) {
    const v = email || null
    field('client_email', v)
    if (locked) {
      const { document } = await api.updateDocument(id, { client_email: v })
      setDoc(document)
      onChanged()
    }
  }

  // Whether a Stripe/GoCardless pay link is attached when this invoice is e-mailed.
  // Editable on finalised invoices (no Save button then) → persist immediately.
  async function changeIncludePayLink(on: boolean) {
    field('include_payment_link', on ? 1 : 0)
    const { document } = await api.updateDocument(id, { include_payment_link: on ? 1 : 0 })
    setDoc(document)
    onChanged()
  }

  async function recordPayment() {
    const amount = inputToCents(payAmount)
    if (amount <= 0) return
    const { document } = await api.addPayment(id, {
      amount_cents: amount,
      paid_on: payDate || todayISO(),
      method: payMethod || undefined,
    })
    setDoc(document)
    setPayAmount('')
    await loadPayments()
    onChanged()
  }

  async function removePayment(paymentId: number) {
    const { document } = await api.deletePayment(paymentId)
    setDoc(document)
    await loadPayments()
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

  // Create a hosted payment link (Stripe/GoCardless) for the open amount.
  async function createPayLink() {
    setBusy(true)
    setActionMsg(null)
    setPayLink(null)
    try {
      const { payment_link } = await api.documentPaymentLink(id)
      setPayLink(payment_link.url)
    } catch (e) {
      setActionMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // E-mail the invoice PDF to the client (with a pay link if it's an invoice).
  async function sendByEmail() {
    setBusy(true)
    setActionMsg(null)
    try {
      const r = await api.sendDocument(id, doc!.kind === 'rechnung' && !!doc!.include_payment_link)
      setActionMsg(`Per E-Mail gesendet an ${r.to}.`)
    } catch (e) {
      setActionMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Validate the client's USt-IdNr via the active accounting adapter (VIES).
  async function checkVat() {
    setBusy(true)
    setVatResult(null)
    try {
      if (dirty && !locked) await save()
      const { validation } = await api.validateVat(id)
      setVatResult(
        validation.valid
          ? `USt-IdNr. gültig${validation.name ? ' — ' + validation.name : ''}`
          : 'USt-IdNr. ungültig (VIES).',
      )
    } catch (e) {
      setVatResult((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Push the finalised invoice to the active accounting system (lexoffice/sevDesk).
  async function pushAccounting() {
    setBusy(true)
    setActionMsg(null)
    try {
      const { result } = await api.pushAccounting(id)
      setActionMsg(
        result.already_pushed
          ? `Bereits an die Buchhaltung übergeben (Beleg ${result.external_id}) — kein erneuter Export.`
          : `An Buchhaltung übergeben (Beleg ${result.external_id}).`,
      )
    } catch (e) {
      setActionMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="doc-editor">
      <div className="doc-editor-head">
        <button className="ghost" onClick={onClose}>
          Zurück
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
        <button onClick={openPdf}>PDF</button>
        {!locked && (
          <button onClick={finalize} disabled={cleanItems.length === 0}>
            Festschreiben
          </button>
        )}
        {isAngebot && (
          <button onClick={convert} title="In eine Rechnung umwandeln">
            In Rechnung umwandeln
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
        {isFinalInvoice && (
          <>
            <button
              onClick={sendByEmail}
              disabled={busy || !doc.client_email}
              title={doc.client_email ? 'Als PDF per E-Mail senden' : 'Keine Empfänger-E-Mail hinterlegt'}
            >
              Per E-Mail senden
            </button>
            <button onClick={createPayLink} disabled={busy} title="Karten-Zahlungslink erzeugen (Stripe/GoCardless)">
              Zahlungslink
            </button>
            <button onClick={pushAccounting} disabled={busy} title="An lexoffice/sevDesk übergeben">
              An Buchhaltung
            </button>
          </>
        )}
      </div>

      {isFinalInvoice && (
        <label className="check-row" style={{ marginTop: 8 }} title="Bei „Per E-Mail senden“ einen Online-Zahlungslink (Stripe/GoCardless) in die E-Mail aufnehmen.">
          <input
            type="checkbox"
            checked={!!doc.include_payment_link}
            onChange={(e) => changeIncludePayLink(e.target.checked)}
          />
          Zahlungslink in E-Mail aufnehmen
        </label>
      )}

      {locked && (
        <div className="doc-locked">
          Festgeschrieben am {doc.issue_date ? fmtDate(doc.issue_date) : '—'} · Nr. {doc.number}.
          Ausgestellte Dokumente sind unveränderlich (GoBD). Für Änderungen{' '}
          {isAngebot ? 'ein neues Angebot' : 'eine Storno-/Korrekturrechnung'} anlegen.
        </div>
      )}

      {validationError && <div className="section-error">{validationError}</div>}

      {actionMsg && <div className="doc-locked">{actionMsg}</div>}
      {payLink && (
        <div className="doc-locked" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Zahlungslink:</span>
          <a href={payLink} target="_blank" rel="noreferrer" className="break-all" style={{ flex: 1 }}>
            {payLink}
          </a>
          <button className="ghost" onClick={() => navigator.clipboard?.writeText(payLink)}>
            Kopieren
          </button>
        </div>
      )}

      {validation && (
        <div className="erechnung-panel">
          {validation.valid && validation.errors.length === 0 ? (
            <span className="erechnung-badge erechnung-ok">Gültig (EN 16931)</span>
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
        {doc.kind === 'rechnung' && (
          <div className="field">
            <label>Fällig am</label>
            <input
              type="date"
              value={doc.due_date ?? ''}
              onChange={(e) => changeDueDate(e.target.value)}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Zahlungsziel. Nach Ablauf erscheint die Rechnung unter „Mahnungen".
            </div>
          </div>
        )}
        {doc.kind === 'rechnung' && (
          <div className="field">
            <label>Kundentyp</label>
            <select value={doc.client_type} onChange={(e) => changeClientType(e.target.value)}>
              {clientTypes.map((t) => (
                <option key={t} value={t}>{CLIENT_TYPE_LABEL[t] ?? t}</option>
              ))}
            </select>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Privatkunden schulden im Verzug keine €40-Pauschale (§288(5) BGB, nur B2B).
            </div>
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
          <label>E-Mail (Empfänger)</label>
          <input
            type="email"
            value={doc.client_email ?? ''}
            placeholder="kunde@example.de"
            onChange={(e) => changeClientEmail(e.target.value)}
          />
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Adresse für „Per E-Mail senden". Kann auch nach dem Festschreiben hinterlegt werden.
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
        <div className="field">
          <label>USt-IdNr. (Kunde)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={doc.client_vat_id ?? ''}
              disabled={locked}
              placeholder="z. B. DE123456789"
              style={{ flex: 1 }}
              onChange={(e) => field('client_vat_id', e.target.value)}
            />
            <button className="ghost" onClick={checkVat} disabled={busy || !(doc.client_vat_id ?? '').trim()}>
              Prüfen (VIES)
            </button>
          </div>
          {vatResult && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{vatResult}</div>}
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
                <td data-label="Beschreibung">
                  <input
                    value={it.description ?? ''}
                    disabled={locked}
                    placeholder="Leistung…"
                    onChange={(e) => setItem(i, { description: e.target.value })}
                  />
                </td>
                <td data-label="Menge" className="num">
                  <input
                    type="number"
                    step="0.5"
                    value={it.quantity}
                    disabled={locked}
                    onChange={(e) => setItem(i, { quantity: Number(e.target.value) })}
                  />
                </td>
                <td data-label="Einheit">
                  <input
                    value={it.unit ?? ''}
                    disabled={locked}
                    onChange={(e) => setItem(i, { unit: e.target.value })}
                  />
                </td>
                <td data-label="Einzelpreis" className="num">
                  <input
                    defaultValue={centsToInput(it.unit_price_cents)}
                    disabled={locked}
                    onBlur={(e) => setItem(i, { unit_price_cents: inputToCents(e.target.value) })}
                  />
                </td>
                <td data-label="Gesamt" className="num cell-total">{euro(lineTotalCents(it.quantity, it.unit_price_cents))}</td>
                <td data-label="">
                  {!locked && (
                    <button className="ghost" onClick={() => removeItem(i)} title="Entfernen">
                      Entfernen
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

      {isFinalInvoice && paySummary && (
        <fieldset className="doc-block">
          <legend>Zahlungen</legend>
          <div className="pay-summary">
            <div><span>Rechnungsbetrag</span><span>{euro(gross)}</span></div>
            <div><span>Bezahlt</span><span>{euro(paySummary.paid_cents)}</span></div>
            <div className="grand">
              <span>Offen</span>
              <span style={{ color: paySummary.outstanding_cents > 0 ? 'var(--danger)' : 'var(--ok)' }}>
                {euro(paySummary.outstanding_cents)}
              </span>
            </div>
          </div>

          {payments.length > 0 && (
            <div className="table-wrap">
              <table className="items-table">
                <thead>
                  <tr><th>Datum</th><th>Art</th><th className="num">Betrag</th><th /></tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td data-label="Datum">{fmtDate(p.paid_on)}</td>
                      <td data-label="Art">{p.method ?? '—'}</td>
                      <td data-label="Betrag" className="num">{euro(p.amount_cents)}</td>
                      <td data-label="">
                        <button className="ghost" onClick={() => removePayment(p.id)} title="Zahlung entfernen">Entfernen</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {doc.status !== 'storniert' && (
            <div className="pay-form">
              <div className="field">
                <label>Betrag</label>
                <input
                  value={payAmount}
                  placeholder={centsToInput(paySummary.outstanding_cents)}
                  onChange={(e) => setPayAmount(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Datum</label>
                <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="field">
                <label>Art</label>
                <input
                  value={payMethod}
                  list="pay-methods"
                  onChange={(e) => setPayMethod(e.target.value)}
                />
                <datalist id="pay-methods">
                  <option value="Überweisung" />
                  <option value="Bar" />
                  <option value="PayPal" />
                  <option value="Lastschrift" />
                  <option value="Karte" />
                </datalist>
              </div>
              <button className="primary" onClick={recordPayment} disabled={inputToCents(payAmount) <= 0}>
                Zahlung erfassen
              </button>
              {paySummary.outstanding_cents > 0 && (
                <button
                  onClick={() => setPayAmount(centsToInput(paySummary.outstanding_cents))}
                  title="Offenen Betrag übernehmen"
                >
                  Offen übernehmen
                </button>
              )}
            </div>
          )}
        </fieldset>
      )}

      <div className="field">
        <label>Fußnote / Hinweise</label>
        <textarea rows={2} value={doc.notes ?? ''} disabled={locked} onChange={(e) => field('notes', e.target.value)} />
      </div>
    </div>
  )
}
