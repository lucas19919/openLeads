import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { euro, centsToInput, inputToCents, lineTotalCents } from '../../money'
import { fmtDate, todayISO } from '../../util'
import { CatalogPicker, catalogItemToLine } from './CatalogPicker'
import { CustomerPicker } from '../CustomerPicker'
import type { CatalogItem, Config, Customer, Doc, DocItem, Payment, ValidationResult } from '../../types'
import type { ModuleIntent } from '../SuiteNav'

const EMPTY_ITEM: DocItem = { description: '', quantity: 1, unit: 'Pauschal', unit_price_cents: 0 }
const CLIENT_TYPE_LABEL: Record<string, string> = { geschaeft: 'Geschäft (B2B)', privat: 'Privat (B2C)' }

export function DocumentEditor({
  id,
  config,
  onClose,
  onChanged,
  onOpenDocument,
  onIntent,
}: {
  id: number
  config: Config
  onClose: () => void
  onChanged: () => void
  /** Open a sibling document in this module (Angebot → Rechnung conversion). */
  onOpenDocument?: (id: number) => void
  /** Cross-module jump (Angebot → Vertrag conversion). */
  onIntent?: (intent: ModuleIntent) => void
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
  // E-mail send + signed-doc upload + link-only customer PATCH share one busy flag.
  const [busy, setBusy] = useState(false)
  const [actionMsg, setActionMsg] = useState<string | null>(null)

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
  function addCatalogLine(it: CatalogItem) {
    setItems((arr) => {
      const line = catalogItemToLine(it)
      // Replace a single empty starter row instead of leaving it dangling.
      const onlyEmptyStarter =
        arr.length === 1 && !(arr[0].description ?? '').trim() && arr[0].unit_price_cents === 0
      return onlyEmptyStarter ? [line] : [...arr, line]
    })
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
        customer_id: doc!.customer_id ?? null,
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
    if (onOpenDocument) {
      onOpenDocument(document.id)
      return
    }
    alert(`Rechnung als Entwurf erstellt (${document.title ?? 'Rechnung'}). Du findest sie in der Liste.`)
  }

  async function toContract() {
    if (dirty && !locked) await save()
    const { contract } = await api.documentToContract(id)
    if (onIntent) {
      onIntent({
        type: 'open',
        module: 'contracts',
        openId: contract.id,
        back: {
          label: doc?.number ? `${isAngebot ? 'Angebot' : 'Rechnung'} ${doc.number}` : 'Angebot (Entwurf)',
          module: 'documents',
          openId: id,
        },
      })
      return
    }
    alert(`Vertragsentwurf erstellt (${contract.title ?? 'Vertrag'}). Du findest ihn unter „Verträge".`)
  }

  async function changeStatus(status: string) {
    field('status', status)
    const { document } = await api.updateDocument(id, { status })
    setDoc(document)
    onChanged()
  }

  // Payment due date drives the overdue marker. Editable even after finalisation
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

  // Debtor classification (B2B/B2C), kept as a record on the document. Editable
  // even after finalisation; persisted immediately when locked (no Save button then).
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

  // E-mail the invoice/quote PDF to the client.
  async function sendByEmail() {
    setBusy(true)
    setActionMsg(null)
    try {
      const r = await api.sendDocument(id)
      setActionMsg(`Per E-Mail gesendet an ${r.to}.`)
    } catch (e) {
      setActionMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Save / remove the signed or final copy of this document (PDF or scan).
  async function uploadSignedDoc(file: File) {
    setBusy(true)
    setActionMsg(null)
    try {
      const { document } = await api.uploadSignedDocument(id, file)
      setDoc(document)
      onChanged()
    } catch (e) {
      setActionMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function removeSignedDoc() {
    if (!confirm('Gespeichertes Dokument entfernen?')) return
    setBusy(true)
    try {
      const { document } = await api.deleteSignedDocument(id)
      setDoc(document)
      onChanged()
    } catch (e) {
      setActionMsg((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // GoBD-correct cancellation: a linked draft with negated positions. The
  // original flips to 'storniert' when the Storno is finalised.
  async function createStorno() {
    if (
      !confirm(
        'Stornorechnung erstellen? Es entsteht ein Entwurf mit negierten Positionen. ' +
          'Erst beim Festschreiben des Stornos wird diese Rechnung auf „storniert" gesetzt.',
      )
    )
      return
    setBusy(true)
    setActionMsg(null)
    try {
      const { document } = await api.stornoDocument(id)
      onChanged()
      if (onOpenDocument) onOpenDocument(document.id)
      else setActionMsg(`Stornorechnungs-Entwurf erstellt (${document.title ?? 'Storno'}).`)
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
        {isAngebot && (
          <button onClick={toContract} title="In einen Vertrag umwandeln (Entwurf)">
            In Vertrag umwandeln
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
          <button
            onClick={sendByEmail}
            disabled={busy || !doc.client_email}
            title={doc.client_email ? 'Als PDF per E-Mail senden' : 'Keine Empfänger-E-Mail hinterlegt'}
          >
            Per E-Mail senden
          </button>
        )}
        {isFinalInvoice && doc.status !== 'storniert' && doc.corrects_document_id == null && (
          <button
            onClick={createStorno}
            disabled={busy}
            title="Stornorechnung (Korrekturrechnung) als Entwurf erstellen"
          >
            Stornieren
          </button>
        )}
      </div>

      {locked && (
        <div className="doc-locked">
          Festgeschrieben am {doc.issue_date ? fmtDate(doc.issue_date) : '—'} · Nr. {doc.number}.
          Ausgestellte Dokumente sind unveränderlich (GoBD). Für Änderungen{' '}
          {isAngebot ? 'ein neues Angebot' : 'eine Storno-/Korrekturrechnung („Stornieren")'} anlegen.
        </div>
      )}

      {doc.corrects_document_id != null && (
        <div className="doc-locked">
          Stornorechnung — korrigiert eine bestehende Rechnung.
          {!doc.number && ' Beim Festschreiben wird die Originalrechnung auf „storniert" gesetzt.'}
          {onOpenDocument && (
            <>
              {' '}
              <button className="ghost" onClick={() => onOpenDocument(doc.corrects_document_id!)}>
                Original öffnen
              </button>
            </>
          )}
        </div>
      )}

      {validationError && <div className="section-error">{validationError}</div>}

      {actionMsg && <div className="doc-locked">{actionMsg}</div>}

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
              Zahlungsziel. Nach Ablauf gilt die Rechnung als überfällig (Übersicht).
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
              Einordnung des Empfängers (Geschäfts- oder Privatkunde) für deine Unterlagen.
            </div>
          </div>
        )}
      </div>

      <fieldset className="doc-block">
        <legend>Empfänger</legend>
        <CustomerPicker
          value={doc.customer_id}
          linkOnly={locked}
          onSelect={(c: Customer | null) => {
            // Finalised: link-only immediate PATCH — never rewrite client_* snapshot.
            if (locked) {
              void (async () => {
                setBusy(true)
                setActionMsg(null)
                try {
                  const { document } = await api.updateDocument(id, {
                    customer_id: c?.id ?? null,
                  })
                  setDoc(document)
                  setActionMsg(c ? `Mit Kunde „${c.name}" verknüpft.` : 'Kunden-Verknüpfung gelöst.')
                  onChanged()
                } catch (e) {
                  setActionMsg(e instanceof Error ? e.message : 'Verknüpfung fehlgeschlagen.')
                } finally {
                  setBusy(false)
                }
              })()
              return
            }
            if (!c) {
              field('customer_id', null)
              return
            }
            // Draft: prefill from customer; later manual edits keep customer_id.
            setDoc((d) =>
              d
                ? {
                    ...d,
                    customer_id: c.id,
                    client_name: c.name,
                    client_address: c.address,
                    client_zip: c.zip,
                    client_city: c.city,
                    client_email: c.email,
                    client_vat_id: c.vat_id,
                    client_type: c.client_type || d.client_type,
                  }
                : d,
            )
            setDirty(true)
          }}
        />
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
          <input
            value={doc.client_vat_id ?? ''}
            disabled={locked}
            placeholder="z. B. DE123456789"
            onChange={(e) => field('client_vat_id', e.target.value)}
          />
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
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={addItem}>+ Position</button>
            <CatalogPicker onPick={addCatalogLine} />
          </div>
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

      <fieldset className="doc-block">
        <legend>Gespeichertes Dokument</legend>
        {doc.has_signed_doc ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <a href={api.signedDocumentUrl(id)} target="_blank" rel="noreferrer">
              {doc.signed_doc_name ?? 'Dokument anzeigen'}
            </a>
            {doc.signed_doc_size ? <span className="muted" style={{ fontSize: 12 }}>{Math.round(doc.signed_doc_size / 1024)} KB</span> : null}
            <button className="ghost danger-text" onClick={removeSignedDoc} disabled={busy}>Entfernen</button>
          </div>
        ) : (
          <div className="field">
            <label>Unterschriebenes / abgelegtes PDF oder Scan hochladen</label>
            <input
              type="file"
              accept=".pdf,application/pdf,image/png,image/jpeg,image/webp,image/heic,image/heif,image/tiff"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) uploadSignedDoc(f)
                e.currentTarget.value = ''
              }}
            />
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Lege das unterschriebene oder finale Exemplar zu diesem {isAngebot ? 'Angebot' : 'Beleg'} ab (im Backup enthalten).
            </div>
          </div>
        )}
      </fieldset>
    </div>
  )
}
