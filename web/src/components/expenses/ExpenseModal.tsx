import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api'
import { euro, centsToInput, inputToCents } from '../../money'
import { todayISO } from '../../util'
import type { Config, Expense } from '../../types'

// VAT rates an expense can carry. 0 = no Vorsteuer (e.g. a §19 supplier or a
// non-taxable item); 7/19 are the German reduced/standard rates.
const VAT_RATES = [19, 7, 0]

type Form = {
  vendor: string
  category: string
  description: string
  expense_date: string
  paid_on: string
  grossInput: string
  vat_rate: number
  payment_method: string
  note: string
}

function emptyForm(config: Config): Form {
  return {
    vendor: '',
    category: 'sonstiges',
    description: '',
    expense_date: todayISO(),
    paid_on: '',
    grossInput: '',
    vat_rate: 19,
    payment_method: config.paymentMethods[0] ?? '',
    note: '',
  }
}

function formFrom(e: Expense): Form {
  return {
    vendor: e.vendor ?? '',
    category: e.category,
    description: e.description ?? '',
    expense_date: e.expense_date,
    paid_on: e.paid_on ?? '',
    grossInput: centsToInput(e.gross_cents),
    vat_rate: e.vat_rate,
    payment_method: e.payment_method ?? '',
    note: e.note ?? '',
  }
}

/** Net + Vorsteuer derived live from the gross input (matches the server's splitGross). */
function preview(grossCents: number, rate: number): { net: number; vat: number } {
  if (rate === 0 || grossCents <= 0) return { net: grossCents, vat: 0 }
  const net = Math.round(grossCents / (1 + rate / 100))
  return { net, vat: grossCents - net }
}

export function ExpenseModal({
  config,
  expense,
  onClose,
  onSaved,
}: {
  config: Config
  expense: Expense | null // null = create new
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<Form>(() => (expense ? formFrom(expense) : emptyForm(config)))
  const [file, setFile] = useState<File | null>(null)
  const [hasReceipt, setHasReceipt] = useState(!!expense?.has_receipt)
  const [receiptName, setReceiptName] = useState(expense?.receipt_name ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setF((s) => ({ ...s, [k]: v }))
  }

  const grossCents = inputToCents(f.grossInput)
  const { net, vat } = preview(grossCents, f.vat_rate)

  // Remove the receipt already stored on an existing expense.
  async function removeReceipt() {
    if (!expense) return
    if (!confirm('Beleg entfernen?')) return
    try {
      await api.deleteReceipt(expense.id)
      setHasReceipt(false)
      setReceiptName(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Beleg konnte nicht entfernt werden.')
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    if (grossCents <= 0) {
      setErr('Bitte einen Bruttobetrag größer 0 eingeben.')
      return
    }
    setBusy(true)
    const body = {
      vendor: f.vendor.trim() || null,
      category: f.category,
      description: f.description.trim() || null,
      expense_date: f.expense_date,
      paid_on: f.paid_on || null,
      gross_cents: grossCents,
      vat_rate: f.vat_rate,
      payment_method: f.payment_method || null,
      note: f.note.trim() || null,
    }
    try {
      const id = expense
        ? (await api.updateExpense(expense.id, body)).expense.id
        : (await api.createExpense(body)).expense.id
      // Upload the receipt after the row exists (separate multipart request).
      if (file) await api.uploadReceipt(id, file)
      onSaved()
    } catch (e) {
      const msg =
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Speichern fehlgeschlagen.'
      setErr(msg)
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <form className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{expense ? 'Ausgabe bearbeiten' : 'Neue Ausgabe'}</h2>

        <div className="row2">
          <div className="field">
            <label>Lieferant</label>
            <input
              value={f.vendor}
              autoFocus
              placeholder="z. B. Bürohaus Müller"
              onChange={(e) => set('vendor', e.target.value)}
            />
          </div>
          <div className="field">
            <label>Kategorie</label>
            <select value={f.category} onChange={(e) => set('category', e.target.value)}>
              {config.expenseCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>Beschreibung</label>
          <input
            value={f.description}
            placeholder="Verwendungszweck"
            onChange={(e) => set('description', e.target.value)}
          />
        </div>

        <div className="row3">
          <div className="field">
            <label>Bruttobetrag (€)</label>
            <input
              inputMode="decimal"
              value={f.grossInput}
              placeholder="0,00"
              onChange={(e) => set('grossInput', e.target.value)}
            />
          </div>
          <div className="field">
            <label>USt-Satz</label>
            <select value={f.vat_rate} onChange={(e) => set('vat_rate', Number(e.target.value))}>
              {VAT_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Zahlungsart</label>
            <select value={f.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
              <option value="">—</option>
              {config.paymentMethods.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="expense-split">
          Netto <strong>{euro(net)}</strong> · Vorsteuer <strong>{euro(vat)}</strong> · Brutto{' '}
          <strong>{euro(grossCents)}</strong>
        </div>

        <div className="row2">
          <div className="field">
            <label>Belegdatum</label>
            <input
              type="date"
              value={f.expense_date}
              onChange={(e) => set('expense_date', e.target.value)}
            />
          </div>
          <div className="field">
            <label>Bezahlt am <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input type="date" value={f.paid_on} onChange={(e) => set('paid_on', e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Notiz</label>
          <textarea rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} />
        </div>

        <div className="field">
          <label>Beleg (PDF oder Bild)</label>
          {hasReceipt && expense && (
            <div className="expense-receipt-row">
              <a
                className="ghost-link"
                href={api.receiptUrl(expense.id)}
                target="_blank"
                rel="noreferrer"
              >
                📎 {receiptName ?? 'Beleg ansehen'}
              </a>
              <button type="button" className="ghost" onClick={removeReceipt}>
                Entfernen
              </button>
            </div>
          )}
          <input
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <div className="expense-file-hint">
              Neuer Beleg: {file.name}
              {hasReceipt ? ' (ersetzt den bestehenden)' : ''}
            </div>
          )}
        </div>

        {err && <div className="error">{err}</div>}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '…' : expense ? 'Speichern' : 'Anlegen'}
          </button>
        </div>
      </form>
    </div>
  )
}
