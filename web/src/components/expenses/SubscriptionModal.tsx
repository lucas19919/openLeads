import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../../api'
import { euro, centsToInput, inputToCents } from '../../money'
import { useEscapeKey } from '../../util'
import type { Config, Subscription } from '../../types'

const VAT_RATES = [19, 7, 0]
const CADENCE_LABEL: Record<string, string> = {
  monatlich: 'Monatlich',
  quartalsweise: 'Quartalsweise',
  jährlich: 'Jährlich',
}
const PER_YEAR: Record<string, number> = { monatlich: 12, quartalsweise: 4, jährlich: 1 }

type Form = {
  vendor: string
  description: string
  category: string
  amountInput: string
  vat_rate: number
  cadence: string
  next_renewal: string
  payment_method: string
  active: boolean
  note: string
}

function emptyForm(config: Config): Form {
  return {
    vendor: '',
    description: '',
    category: 'software',
    amountInput: '',
    vat_rate: 19,
    cadence: config.cadences[0] ?? 'monatlich',
    next_renewal: '',
    payment_method: config.paymentMethods[0] ?? '',
    active: true,
    note: '',
  }
}

function formFrom(s: Subscription): Form {
  return {
    vendor: s.vendor,
    description: s.description ?? '',
    category: s.category,
    amountInput: centsToInput(s.amount_cents),
    vat_rate: s.vat_rate,
    cadence: s.cadence,
    next_renewal: s.next_renewal ?? '',
    payment_method: s.payment_method ?? '',
    active: !!s.active,
    note: s.note ?? '',
  }
}

export function SubscriptionModal({
  config,
  subscription,
  onClose,
  onSaved,
}: {
  config: Config
  subscription: Subscription | null // null = create new
  onClose: () => void
  onSaved: () => void
}) {
  const [f, setF] = useState<Form>(() => (subscription ? formFrom(subscription) : emptyForm(config)))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEscapeKey(onClose)

  function set<K extends keyof Form>(k: K, v: Form[K]) {
    setF((s) => ({ ...s, [k]: v }))
  }

  const amountCents = inputToCents(f.amountInput)
  const monthly = Math.round((amountCents * (PER_YEAR[f.cadence] ?? 12)) / 12)
  const yearly = amountCents * (PER_YEAR[f.cadence] ?? 12)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    if (!f.vendor.trim()) {
      setErr('Bitte einen Anbieter angeben.')
      return
    }
    if (amountCents <= 0) {
      setErr('Bitte einen Betrag größer 0 eingeben.')
      return
    }
    setBusy(true)
    const body = {
      vendor: f.vendor.trim(),
      description: f.description.trim() || null,
      category: f.category,
      amount_cents: amountCents,
      vat_rate: f.vat_rate,
      cadence: f.cadence,
      next_renewal: f.next_renewal || null,
      payment_method: f.payment_method || null,
      active: f.active ? 1 : 0,
      note: f.note.trim() || null,
    }
    try {
      if (subscription) await api.updateSubscription(subscription.id, body)
      else await api.createSubscription(body)
      onSaved()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Speichern fehlgeschlagen.')
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <form className="modal-card modal-card-wide" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>{subscription ? 'Abo bearbeiten' : 'Neues Abo'}</h2>

        <div className="row2">
          <div className="field">
            <label>Anbieter</label>
            <input
              value={f.vendor}
              autoFocus
              placeholder="z. B. Anthropic (Claude)"
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
          <label>Tarif / Beschreibung</label>
          <input
            value={f.description}
            placeholder="z. B. Max-Plan"
            onChange={(e) => set('description', e.target.value)}
          />
        </div>

        <div className="row3">
          <div className="field">
            <label>Betrag je Turnus (€)</label>
            <input
              inputMode="decimal"
              value={f.amountInput}
              placeholder="0,00"
              onChange={(e) => set('amountInput', e.target.value)}
            />
          </div>
          <div className="field">
            <label>Turnus</label>
            <select value={f.cadence} onChange={(e) => set('cadence', e.target.value)}>
              {config.cadences.map((c) => (
                <option key={c} value={c}>
                  {CADENCE_LABEL[c] ?? c}
                </option>
              ))}
            </select>
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
        </div>

        <div className="expense-split">
          Pro Monat <strong>{euro(monthly)}</strong> · Pro Jahr <strong>{euro(yearly)}</strong>
        </div>

        <div className="row2">
          <div className="field">
            <label>Nächste Verlängerung <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input type="date" value={f.next_renewal} onChange={(e) => set('next_renewal', e.target.value)} />
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

        <div className="field">
          <label className="check-row">
            <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
            Aktiv (zählt zu den laufenden Kosten)
          </label>
        </div>

        <div className="field">
          <label>Notiz</label>
          <textarea rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} />
        </div>

        {err && <div className="error">{err}</div>}

        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '…' : subscription ? 'Speichern' : 'Anlegen'}
          </button>
        </div>
      </form>
    </div>
  )
}
