import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { Settings } from '../../types'

export function SettingsView() {
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
            <div className="row2">
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
            <div className="field">
              <label>API-Schlüssel {s.ai_api_key_set && <span className="user-chip">gespeichert</span>}</label>
              <input
                type="password"
                autoComplete="new-password"
                value={aiApiKey}
                disabled={clearAiKey}
                placeholder={s.ai_api_key_set ? '******** (leer lassen zum Beibehalten)' : 'nur für gehostete Endpunkte nötig'}
                onChange={(e) => { setAiApiKey(e.target.value); setSaved(false) }}
              />
              {s.ai_api_key_set && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={clearAiKey}
                    onChange={(e) => { setClearAiKey(e.target.checked); setSaved(false) }}
                  />
                  Gespeicherten Schlüssel löschen
                </label>
              )}
            </div>
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
            <div className="field">
              <label>Passwort {s.smtp_pass_set && <span className="user-chip">gespeichert</span>}</label>
              <input
                type="password"
                autoComplete="new-password"
                value={smtpPass}
                disabled={clearSmtpPass}
                placeholder={s.smtp_pass_set ? '******** (leer lassen zum Beibehalten)' : ''}
                onChange={(e) => { setSmtpPass(e.target.value); setSaved(false) }}
              />
              {s.smtp_pass_set && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={clearSmtpPass}
                    onChange={(e) => { setClearSmtpPass(e.target.checked); setSaved(false) }}
                  />
                  Gespeichertes Passwort löschen
                </label>
              )}
            </div>
            {s.settings_key_configured === false && (
              <p className="settings-hint" style={{ color: 'var(--danger, #c0392b)' }}>
                <code>SETTINGS_KEY</code> ist nicht gesetzt. Zugangsdaten werden dann mit einem
                unsicheren Standardschlüssel verschlüsselt — im Produktivbetrieb wird das Speichern
                abgelehnt. Bitte <code>SETTINGS_KEY</code> (langer Zufallswert) in der Umgebung setzen.
              </p>
            )}
          </fieldset>

          <fieldset className="doc-block">
            <legend>Datensicherung</legend>
            <p className="settings-hint">
              Lade eine konsistente SQLite-Momentaufnahme deiner Datenbank herunter — die Sicherung
              gehört dir als Betreiber/in.
            </p>
            <a className="backup-link" href={api.backupUrl()} download>
              Backup herunterladen (.db)
            </a>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Steuerberater-Export</legend>
            <p className="settings-hint">
              GoBD-konformes Rechnungsjournal bzw. DATEV-Buchungsstapel für den Steuerberater;
              Zeitraum optional.
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
            </div>
          </fieldset>
        </div>
      </div>
    </>
  )
}
