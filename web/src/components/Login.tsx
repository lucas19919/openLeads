import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../api'
import type { User } from '../types'

export function Login({ onSuccess }: { onSuccess: (u: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setErr('')
    setBusy(true)
    try {
      const { user } = await api.login(username, password)
      onSuccess(user)
    } catch (e) {
      setErr(
        e instanceof ApiError && e.status === 401
          ? 'Benutzername oder Passwort falsch.'
          : 'Login fehlgeschlagen. Server erreichbar?',
      )
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1 className="brand">
          Open<i>Leads</i>
        </h1>
        <div className="sub">isarwebsites · Interne Tools — Leads & Rechnungen</div>
        <div className="field">
          <label>Benutzer</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label>Passwort</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {err && <div className="error">{err}</div>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? '…' : 'Anmelden'}
        </button>
      </form>
    </div>
  )
}
