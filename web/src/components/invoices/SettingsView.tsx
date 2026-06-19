import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { Settings } from '../../types'

export function SettingsView() {
  const [s, setS] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [exportFrom, setExportFrom] = useState('')
  const [exportTo, setExportTo] = useState('')

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
    try {
      const { settings } = await api.updateSettings(s)
      setS(settings)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <strong style={{ paddingLeft: 4 }}>Geschäftsdaten für Angebote & Rechnungen</strong>
        <div className="spacer" />
        {saved && <span className="user-chip">Gespeichert ✓</span>}
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
