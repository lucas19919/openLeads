import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { useEscapeKey } from '../util'
import type { NewLead } from '../types'

export function NewLeadModal({
  priorities,
  onClose,
  onCreated,
}: {
  priorities: string[]
  onClose: () => void
  onCreated: () => void
}) {
  const [f, setF] = useState<NewLead>({ priority: 'mittel' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEscapeKey(onClose)

  function set<K extends keyof NewLead>(k: K, v: NewLead[K]) {
    setF((s) => ({ ...s, [k]: v }))
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    try {
      const r = await api.createLead(f)
      if ('deduped' in r && r.deduped) {
        setMsg('Diese Domain ist bereits im System.')
        setBusy(false)
        return
      }
      onCreated()
    } catch {
      setMsg('Konnte Lead nicht anlegen.')
      setBusy(false)
    }
  }

  return (
    <div className="modal" onClick={onClose}>
      <form className="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Neuer Lead</h2>
        <div className="field">
          <label>Firma</label>
          <input value={f.company ?? ''} onChange={(e) => set('company', e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Website</label>
          <input
            value={f.website ?? ''}
            placeholder="https://…"
            onChange={(e) => set('website', e.target.value)}
          />
        </div>
        <div className="row2">
          <div className="field">
            <label>Gewerk</label>
            <input value={f.trade ?? ''} onChange={(e) => set('trade', e.target.value)} />
          </div>
          <div className="field">
            <label>Ort</label>
            <input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>Telefon</label>
            <input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="field">
            <label>E-Mail</label>
            <input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Priorität</label>
          <select value={f.priority ?? 'mittel'} onChange={(e) => set('priority', e.target.value)}>
            {priorities.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        {msg && <div className="error">{msg}</div>}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? '…' : 'Anlegen'}
          </button>
        </div>
      </form>
    </div>
  )
}
