import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { Config, PublicUser, Settings, User } from '../../types'

export function SettingsView({ user, config }: { user: User; config: Config }) {
  const [s, setS] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [exportFrom, setExportFrom] = useState('')
  const [exportTo, setExportTo] = useState('')
  // Write-only secrets: held locally, sent only when typed, never read back.
  const [aiApiKey, setAiApiKey] = useState('')
  const [smtpPass, setSmtpPass] = useState('')
  const [clearAiKey, setClearAiKey] = useState(false)
  const [clearSmtpPass, setClearSmtpPass] = useState(false)

  useEffect(() => {
    api.getSettings().then(({ settings }) => setS(settings))
  }, [])

  if (!s) return <div className="content center-muted">Lädt…</div>

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((cur) => (cur ? { ...cur, [k]: v } : cur))
    setSaved(false)
  }

  async function save() {
    if (!s) return
    setSaving(true)
    setError(null)
    try {
      // Strip server-managed read-only flags; attach secrets only when changed.
      const { ai_api_key_set, smtp_pass_set, settings_key_configured, ...rest } = s
      const patch: Record<string, unknown> = { ...rest }
      if (clearAiKey) patch.ai_api_key = ''
      else if (aiApiKey) patch.ai_api_key = aiApiKey
      if (clearSmtpPass) patch.smtp_pass = ''
      else if (smtpPass) patch.smtp_pass = smtpPass

      const { settings } = await api.updateSettings(patch as Partial<Settings>)
      setS(settings)
      setAiApiKey('')
      setSmtpPass('')
      setClearAiKey(false)
      setClearSmtpPass(false)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message || 'Speichern fehlgeschlagen.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Einstellungen</span>
        <div className="spacer" />
        {error && <span className="user-chip" style={{ color: 'var(--danger, #c0392b)' }}>{error}</span>}
        {saved && <span className="user-chip">Gespeichert</span>}
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? '…' : 'Speichern'}
        </button>
      </div>

      <div className="content">
        <div className="settings-form">
          {s.settings_key_configured === false && (
            <div className="settings-keywarn">
              <strong><code>SETTINGS_KEY</code> ist nicht gesetzt.</strong> Gespeicherte Zugangsdaten
              (KI-/SMTP-Schlüssel) werden sonst mit einem unsicheren Standardschlüssel verschlüsselt —
              im Produktivbetrieb wird das Speichern dieser Felder abgelehnt. Trage in{' '}
              <code>api/.env</code> eine lange Zufallszeichenkette ein und starte die API neu:
              <pre>SETTINGS_KEY=$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")</pre>
            </div>
          )}

          <fieldset className="doc-block">
            <legend>Absender</legend>
            <div className="field">
              <label>Firmenname</label>
              <input value={s.business_name ?? ''} onChange={(e) => set('business_name', e.target.value)} />
            </div>
            <div className="field">
              <label>Inhaber/in</label>
              <input value={s.owner ?? ''} onChange={(e) => set('owner', e.target.value)} />
            </div>
            <div className="field">
              <label>Straße & Hausnr.</label>
              <input value={s.address ?? ''} onChange={(e) => set('address', e.target.value)} />
            </div>
            <div className="row2">
              <div className="field">
                <label>PLZ</label>
                <input value={s.zip ?? ''} onChange={(e) => set('zip', e.target.value)} />
              </div>
              <div className="field">
                <label>Ort</label>
                <input value={s.city ?? ''} onChange={(e) => set('city', e.target.value)} />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>E-Mail</label>
                <input value={s.email ?? ''} onChange={(e) => set('email', e.target.value)} />
              </div>
              <div className="field">
                <label>Telefon</label>
                <input value={s.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>Website</label>
              <input value={s.website ?? ''} onChange={(e) => set('website', e.target.value)} />
            </div>
            <div className="field">
              <label>Steuernummer / USt-IdNr.</label>
              <input value={s.tax_id ?? ''} onChange={(e) => set('tax_id', e.target.value)} />
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Bankverbindung</legend>
            <div className="field">
              <label>Bank</label>
              <input value={s.bank ?? ''} onChange={(e) => set('bank', e.target.value)} />
            </div>
            <div className="row2">
              <div className="field">
                <label>IBAN</label>
                <input value={s.iban ?? ''} onChange={(e) => set('iban', e.target.value)} />
              </div>
              <div className="field">
                <label>BIC</label>
                <input value={s.bic ?? ''} onChange={(e) => set('bic', e.target.value)} />
              </div>
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Steuer & Nummernkreise</legend>
            <label className="check-row">
              <input
                type="checkbox"
                checked={!!s.small_business}
                onChange={(e) => set('small_business', e.target.checked ? 1 : 0)}
              />
              Kleinunternehmer nach §19 UStG (keine Umsatzsteuer ausweisen)
            </label>
            <div className="row2">
              <div className="field">
                <label>USt-Satz (%)</label>
                <input
                  type="number"
                  value={s.vat_rate}
                  disabled={!!s.small_business}
                  onChange={(e) => set('vat_rate', Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label>Zahlungsziel (Tage)</label>
                <input
                  type="number"
                  value={s.payment_terms}
                  onChange={(e) => set('payment_terms', Number(e.target.value))}
                />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>Rechnungs-Präfix</label>
                <input value={s.rechnung_prefix} onChange={(e) => set('rechnung_prefix', e.target.value)} />
              </div>
              <div className="field">
                <label>Nächste Rechnungs-Nr.</label>
                <input
                  type="number"
                  value={s.rechnung_next}
                  onChange={(e) => set('rechnung_next', Number(e.target.value))}
                />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>Angebots-Präfix</label>
                <input value={s.angebot_prefix} onChange={(e) => set('angebot_prefix', e.target.value)} />
              </div>
              <div className="field">
                <label>Nächste Angebots-Nr.</label>
                <input
                  type="number"
                  value={s.angebot_next}
                  onChange={(e) => set('angebot_next', Number(e.target.value))}
                />
              </div>
            </div>
            <div className="field">
              <label>Verzugszins-Basiszinssatz (%)</label>
              <input
                type="number"
                step="0.01"
                value={s.verzug_base_rate ?? ''}
                onChange={(e) => set('verzug_base_rate', Number(e.target.value))}
              />
            </div>
            <div className="row3">
              <div className="field">
                <label>DATEV Erlöskonto</label>
                <input
                  value={s.datev_revenue_account ?? ''}
                  placeholder="8400 / 8200 (§19)"
                  onChange={(e) => set('datev_revenue_account', e.target.value)}
                />
              </div>
              <div className="field">
                <label>DATEV Debitorenkonto</label>
                <input
                  value={s.datev_debitor_account ?? ''}
                  placeholder="10000"
                  onChange={(e) => set('datev_debitor_account', e.target.value)}
                />
              </div>
              <div className="field">
                <label>DATEV Gegenkonto (Ausgaben)</label>
                <input
                  value={s.datev_bank_account ?? ''}
                  placeholder="1200"
                  onChange={(e) => set('datev_bank_account', e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>KI-Anbindung</legend>
            <p className="settings-hint">
              Überschreibt die <code>AI_*</code>-Umgebungsvariablen. Leer lassen, um die
              Werte aus <code>.env</code> zu verwenden. Standard ist lokales Ollama
              (<code>http://localhost:11434/v1</code>) — keine Datenübermittlung.
            </p>
            <div className="row2">
              <div className="field">
                <label>Basis-URL (OpenAI-kompatibel)</label>
                <input
                  value={s.ai_base_url ?? ''}
                  placeholder="http://localhost:11434/v1"
                  onChange={(e) => set('ai_base_url', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Modell</label>
                <input
                  value={s.ai_model ?? ''}
                  placeholder="llama3.1:8b"
                  onChange={(e) => set('ai_model', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>Anzeigename (optional)</label>
              <input
                value={s.ai_label ?? ''}
                placeholder="z.B. Teuken-7B · self-hosted (EU)"
                onChange={(e) => set('ai_label', e.target.value)}
              />
            </div>
            <SecretField
              label="API-Schlüssel"
              isSet={!!s.ai_api_key_set}
              value={aiApiKey}
              onChange={(v) => { setAiApiKey(v); setSaved(false) }}
              clear={clearAiKey}
              onClearChange={(v) => { setClearAiKey(v); setSaved(false) }}
              unsetPlaceholder="nur für gehostete Endpunkte nötig"
            />
          </fieldset>

          <fieldset className="doc-block">
            <legend>E-Mail-Versand (SMTP)</legend>
            <p className="settings-hint">
              Überschreibt die <code>SMTP_*</code>-Umgebungsvariablen. Nur ein
              freigegebener Entwurf wird je versendet; jede Nachricht erhält automatisch
              Impressum + Opt-out. Leer lassen, um den Versand zu deaktivieren.
            </p>
            <div className="row2">
              <div className="field">
                <label>SMTP-Host</label>
                <input
                  value={s.smtp_host ?? ''}
                  placeholder="smtp.example.de"
                  onChange={(e) => set('smtp_host', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Port</label>
                <input
                  type="number"
                  value={s.smtp_port ?? ''}
                  placeholder="587"
                  onChange={(e) => set('smtp_port', e.target.value === '' ? null : Number(e.target.value))}
                />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>Benutzername</label>
                <input
                  value={s.smtp_user ?? ''}
                  autoComplete="off"
                  onChange={(e) => set('smtp_user', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Absender (From)</label>
                <input
                  value={s.smtp_from ?? ''}
                  placeholder="Web Studio <hallo@webstudio.de>"
                  onChange={(e) => set('smtp_from', e.target.value)}
                />
              </div>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={s.smtp_secure === 1}
                onChange={(e) => set('smtp_secure', e.target.checked ? 1 : 0)}
              />
              Implizites TLS (Port 465) — sonst STARTTLS
            </label>
            <SecretField
              label="Passwort"
              isSet={!!s.smtp_pass_set}
              value={smtpPass}
              onChange={(v) => { setSmtpPass(v); setSaved(false) }}
              clear={clearSmtpPass}
              onClearChange={(v) => { setClearSmtpPass(v); setSaved(false) }}
            />
          </fieldset>

          {user.role === 'admin' && <BackupSection />}

          <fieldset className="doc-block">
            <legend>Steuerberater-Export</legend>
            <p className="settings-hint">
              GoBD-konformes Rechnungsjournal bzw. DATEV-Buchungsstapel für den Steuerberater —
              für Einnahmen (Rechnungen) und Ausgaben (Belege); Zeitraum optional.
            </p>
            <div className="row2">
              <div className="field">
                <label>Von</label>
                <input
                  type="date"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Bis</label>
                <input
                  type="date"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                />
              </div>
            </div>
            <div className="export-links">
              <a
                className="backup-link"
                href={api.exportInvoicesUrl(exportFrom || undefined, exportTo || undefined)}
                download
              >
                Rechnungsjournal (CSV)
              </a>
              <a
                className="backup-link"
                href={api.exportDatevUrl(exportFrom || undefined, exportTo || undefined)}
                download
              >
                DATEV-Buchungen (CSV)
              </a>
              <a
                className="backup-link"
                href={api.exportExpensesUrl(exportFrom || undefined, exportTo || undefined)}
                download
              >
                Ausgabenjournal (CSV)
              </a>
              <a
                className="backup-link"
                href={api.exportExpensesDatevUrl(exportFrom || undefined, exportTo || undefined)}
                download
              >
                DATEV-Ausgaben (CSV)
              </a>
            </div>
          </fieldset>

          {user.role === 'admin' && <TeamSettings config={config} currentUserId={user.id} />}
        </div>
      </div>
    </>
  )
}

// Admin-only data safety: download a full snapshot, or restore one (overwriting
// all current data). The download/restore pair lives together so the capability
// is obviously symmetric — you can get your data out AND back in.
function BackupSection() {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function restore() {
    if (!file) return
    if (
      !confirm(
        'Achtung: Die Wiederherstellung ÜBERSCHREIBT alle aktuellen Daten mit der hochgeladenen ' +
          'Sicherung und kann nicht rückgängig gemacht werden. Fortfahren?',
      )
    )
      return
    setBusy(true)
    setErr(null)
    setMsg(null)
    try {
      const r = await api.restoreBackup(file)
      setMsg(`Wiederhergestellt: ${r.rows} Datensätze in ${r.tables} Tabellen. Seite wird neu geladen…`)
      setTimeout(() => window.location.reload(), 1500)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Wiederherstellung fehlgeschlagen.')
      setBusy(false)
    }
  }

  return (
    <fieldset className="doc-block">
      <legend>Datensicherung</legend>
      <p className="settings-hint">
        Lade eine konsistente SQLite-Momentaufnahme deiner Datenbank herunter — oder spiele eine
        frühere Sicherung wieder ein. Die Sicherung gehört dir als Betreiber/in.
      </p>
      <a className="backup-link" href={api.backupUrl()} download>
        Backup herunterladen (.db)
      </a>
      <div className="field" style={{ marginTop: 14 }}>
        <label>Sicherung wiederherstellen (.db)</label>
        <input
          type="file"
          accept=".db,application/octet-stream,application/x-sqlite3"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setMsg(null)
            setErr(null)
          }}
        />
      </div>
      <button className="ghost danger-text" onClick={restore} disabled={busy || !file}>
        {busy ? '…' : 'Wiederherstellen (überschreibt alle Daten)'}
      </button>
      {msg && <p className="settings-hint" style={{ color: 'var(--ok)', marginTop: 8 }}>{msg}</p>}
      {err && <div className="section-error">{err}</div>}
    </fieldset>
  )
}

// A write-only credential field: never pre-filled with the stored value, shows a
// "gespeichert" chip when one exists, and offers an explicit "clear" toggle.
// Shared by the AI key and the SMTP password (same behaviour, was duplicated).
function SecretField({
  label,
  isSet,
  value,
  onChange,
  clear,
  onClearChange,
  unsetPlaceholder,
}: {
  label: string
  isSet: boolean
  value: string
  onChange: (v: string) => void
  clear: boolean
  onClearChange: (v: boolean) => void
  unsetPlaceholder?: string
}) {
  return (
    <div className="field">
      <label>
        {label} {isSet && <span className="user-chip">gespeichert</span>}
      </label>
      <input
        type="password"
        autoComplete="new-password"
        value={value}
        disabled={clear}
        placeholder={isSet ? '******** (leer lassen zum Beibehalten)' : unsetPlaceholder ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {isSet && (
        <label className="check-row">
          <input type="checkbox" checked={clear} onChange={(e) => onClearChange(e.target.checked)} />
          Gespeicherten Wert löschen
        </label>
      )}
    </div>
  )
}

// Admin-only user management: add team members, change roles, reset passwords.
function TeamSettings({ config, currentUserId }: { config: Config; currentUserId: number }) {
  const [users, setUsers] = useState<PublicUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newPass, setNewPass] = useState('')
  const [newRole, setNewRole] = useState(config.roles[0] ?? 'member')

  function refresh() {
    api.listUsers().then(({ users }) => setUsers(users)).catch(() => {})
  }
  useEffect(refresh, [])

  async function addUser() {
    setError(null)
    try {
      await api.createUser({ username: newName.trim(), password: newPass, role: newRole })
      setNewName('')
      setNewPass('')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Anlegen fehlgeschlagen.')
    }
  }

  async function changeRole(u: PublicUser, role: string) {
    setError(null)
    try {
      await api.updateUser(u.id, { role })
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Änderung fehlgeschlagen.')
    }
  }

  async function resetPassword(u: PublicUser) {
    const pw = prompt(`Neues Passwort für ${u.username} (min. 8 Zeichen):`)
    if (!pw) return
    setError(null)
    try {
      await api.updateUser(u.id, { password: pw })
      alert('Passwort gesetzt.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Zurücksetzen fehlgeschlagen.')
    }
  }

  async function removeUser(u: PublicUser) {
    if (!confirm(`Benutzer ${u.username} löschen?`)) return
    setError(null)
    try {
      await api.deleteUser(u.id)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.')
    }
  }

  return (
    <fieldset className="doc-block">
      <legend>Team & Benutzer</legend>
      <p className="settings-hint">
        Admins verwalten Benutzer und Einstellungen; Mitglieder arbeiten Pipeline und Rechnungen.
      </p>
      {error && <div className="section-error">{error}</div>}
      <div className="table-wrap">
        <table className="items-table">
          <thead>
            <tr><th>Benutzer</th><th>Rolle</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td data-label="Benutzer" className="cell-primary">{u.username}{u.id === currentUserId && <span className="user-chip" style={{ marginLeft: 6 }}>du</span>}</td>
                <td data-label="Rolle">
                  <select value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
                    {config.roles.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </td>
                <td data-label="">
                  <button className="ghost" onClick={() => resetPassword(u)}>Passwort</button>
                  {u.id !== currentUserId && (
                    <button className="ghost" onClick={() => removeUser(u)}>Löschen</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row2" style={{ marginTop: 10 }}>
        <div className="field">
          <label>Neuer Benutzername</label>
          <input value={newName} autoComplete="off" onChange={(e) => setNewName(e.target.value)} />
        </div>
        <div className="field">
          <label>Passwort (min. 8)</label>
          <input type="password" autoComplete="new-password" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
        </div>
      </div>
      <div className="row2">
        <div className="field">
          <label>Rolle</label>
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
            {config.roles.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="field" style={{ alignSelf: 'end' }}>
          <button className="primary" onClick={addUser} disabled={!newName.trim() || newPass.length < 8}>
            Benutzer anlegen
          </button>
        </div>
      </div>
    </fieldset>
  )
}
