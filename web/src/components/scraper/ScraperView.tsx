import { useEffect, useState } from 'react'
import { api } from '../../api'
import { fmtDate } from '../../util'
import type { AiStatus, ScraperConfig, ScraperStatus, Settings } from '../../types'

// "2026-06-18 23:13:15" → "18.06.2026"
function dateOnly(ts: string | null): string {
  if (!ts) return '—'
  return fmtDate(ts.slice(0, 10))
}

export function ScraperView() {
  const [s, setS] = useState<Settings | null>(null)
  const [config, setConfig] = useState<ScraperConfig | null>(null)
  const [status, setStatus] = useState<ScraperStatus | null>(null)
  // The discovery model actually in effect (Settings default AI). Shown so the
  // operator can see whether it's a Claude model — the scraper needs one.
  const [ai, setAi] = useState<AiStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [starting, setStarting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  // Write-only discovery API key: held locally, sent only when typed.
  const [aiKey, setAiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)

  async function reloadStatus() {
    setStatus(await api.scraperStatus())
  }

  async function reloadAll() {
    const [{ settings }, config, status] = await Promise.all([
      api.getSettings(),
      api.scraperConfig(),
      api.scraperStatus(),
    ])
    setS(settings)
    setConfig(config)
    setStatus(status)
  }

  useEffect(() => {
    reloadAll()
    // Non-blocking: the AI probe never throws, but keep it off the critical path.
    api.aiStatus().then(setAi).catch(() => {})
  }, [])

  // While a run is in progress, poll the status so the panel stays live.
  const running = !!status?.run.running
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      api.scraperStatus().then(setStatus).catch(() => {})
    }, 2500)
    return () => clearInterval(t)
  }, [running])

  if (!s || !config || !status) return <div className="content center-muted">Lädt…</div>

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setS((cur) => (cur ? { ...cur, [k]: v } : cur))
    setSaved(false)
  }
  function setNum(k: keyof Settings, raw: string) {
    set(k, (raw.trim() === '' ? null : Number(raw)) as Settings[keyof Settings])
  }

  async function save() {
    if (!s) return
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        scraper_region: s.scraper_region?.trim() ? s.scraper_region : null,
        scraper_trades: s.scraper_trades?.trim() ? s.scraper_trades : null,
        scraper_towns: s.scraper_towns?.trim() ? s.scraper_towns : null,
        scraper_min_score: s.scraper_min_score,
        scraper_max_pairs: s.scraper_max_pairs,
        scraper_per_pair: s.scraper_per_pair,
      }
      if (clearKey) patch.scraper_ai_api_key = ''
      else if (aiKey) patch.scraper_ai_api_key = aiKey
      const { settings } = await api.updateSettings(patch as Partial<Settings>)
      setS(settings)
      setAiKey('')
      setClearKey(false)
      const c = await api.scraperConfig()
      setConfig(c)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function run(dry: boolean) {
    setRunError(null)
    setStarting(true)
    try {
      await api.runScraper(dry)
      await reloadStatus() // picks up running=true → polling effect takes over
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Start fehlgeschlagen.')
    } finally {
      setStarting(false)
    }
  }

  const effective = config
  const perRun = `bis zu ${effective.max_pairs} Kombination(en) × ${effective.per_pair} Treffer = max. ${
    effective.max_pairs * effective.per_pair
  } Kandidaten pro Lauf`
  const run_ = status.run

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Scraper</span>
        <div className="spacer" />
        {saved && <span className="user-chip">Gespeichert ✓</span>}
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? '…' : 'Speichern'}
        </button>
      </div>

      <div className="content">
        <div className="scraper-page">
          {/* --- run panel --- */}
          <fieldset className="doc-block">
            <legend>Lauf starten</legend>
            {!status.reachable ? (
              <div className="section-error">
                Scraper-Quellen sind von der API aus nicht erreichbar (getrennte Container). Ein Lauf
                lässt sich hier nicht starten — den Scraper-Dienst separat ausführen.
              </div>
            ) : (
              <>
                <p className="settings-hint" style={{ marginBottom: 12 }}>
                  Sucht per KI-Websuche nach Betrieben mit veralteter Website und legt neue Leads an
                  (Domains im System werden übersprungen). Der Lauf kostet API-Guthaben — der{' '}
                  <strong>Testlauf</strong> nutzt Fixtures und kostet nichts.
                </p>
                {!status.service_token_configured && (
                  <div className="section-error" style={{ marginBottom: 10 }}>
                    <code>SERVICE_TOKEN</code> ist in der API nicht gesetzt — bitte in{' '}
                    <code>api/.env</code> eintragen, sonst kann der Lauf keine Leads anlegen. (Der
                    Scraper übernimmt diesen Token automatisch; eine eigene <code>scraper/.env</code>{' '}
                    ist dafür nicht nötig.)
                  </div>
                )}
                <div className="dunning-actions" style={{ marginBottom: 10 }}>
                  <button className="primary" onClick={() => run(false)} disabled={running || starting}>
                    {running && !run_.dry ? 'Läuft…' : 'Jetzt scrapen'}
                  </button>
                  <button onClick={() => run(true)} disabled={running || starting}>
                    {running && run_.dry ? 'Testlauf läuft…' : 'Testlauf (ohne Kosten)'}
                  </button>
                  {running && <span className="user-chip">⏳ Lauf aktiv seit {run_.started_at ? new Date(run_.started_at).toLocaleTimeString('de-DE') : '—'}…</span>}
                </div>
                {runError && <div className="section-error">{runError}</div>}
                {!running && run_.last && (
                  <div className={run_.last.ok ? 'section-info' : 'section-error'}>
                    {run_.last.ok ? '✓ ' : '✕ '}
                    {run_.last.dry ? 'Testlauf: ' : 'Lauf: '}
                    {run_.last.detail}
                    {run_.finished_at && ` (${new Date(run_.finished_at).toLocaleTimeString('de-DE')})`}
                  </div>
                )}
              </>
            )}
          </fieldset>

          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-num">{status.scraped}</div>
              <div className="stat-label">Scraper-Leads gesamt</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{status.today}</div>
              <div className="stat-label">Heute gefunden</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{dateOnly(status.last)}</div>
              <div className="stat-label">Letzter Fund</div>
            </div>
            <div className="stat-card">
              <div className="stat-num">{status.total}</div>
              <div className="stat-label">Leads im System</div>
            </div>
          </div>

          <fieldset className="doc-block">
            <legend>Suchraster</legend>
            <div className="field">
              <label>Region {config.using_defaults.region && <em>(nicht gesetzt)</em>}</label>
              <input
                placeholder="Discovery-Anker, z. B. „Großraum Köln“ — muss zu den Orten passen"
                value={s.scraper_region ?? ''}
                onChange={(e) => set('scraper_region', e.target.value)}
              />
            </div>
            <div className="row2">
              <div className="field">
                <label>Gewerke {config.using_defaults.trades && <em>(Standardliste aktiv)</em>}</label>
                <textarea
                  rows={8}
                  placeholder={'Ein Gewerk pro Zeile, z.B.\nSchreiner\nMaler\nDachdecker'}
                  value={s.scraper_trades ?? ''}
                  onChange={(e) => set('scraper_trades', e.target.value)}
                />
                {config.using_defaults.trades && (
                  <button
                    className="ghost"
                    style={{ marginTop: 6 }}
                    onClick={() => set('scraper_trades', config.trades.join('\n'))}
                  >
                    Standardliste einfügen ({config.trades.length})
                  </button>
                )}
              </div>
              <div className="field">
                <label>Orte {config.using_defaults.towns && <em>(keine gesetzt)</em>}</label>
                <textarea
                  rows={8}
                  placeholder={'Ein Ort pro Zeile, z.B.\nDachau\nErding\nFreising'}
                  value={s.scraper_towns ?? ''}
                  onChange={(e) => set('scraper_towns', e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>Lauf-Parameter</legend>
            <div className="row2">
              <div className="field">
                <label>Mindest-Score (Schwelle für „veraltet")</label>
                <input
                  type="number"
                  placeholder={`Standard: ${effective.min_score}`}
                  value={s.scraper_min_score ?? ''}
                  onChange={(e) => setNum('scraper_min_score', e.target.value)}
                />
              </div>
              <div className="field">
                <label>Kombinationen pro Lauf (Gewerk × Ort)</label>
                <input
                  type="number"
                  placeholder={`Standard: ${effective.max_pairs}`}
                  value={s.scraper_max_pairs ?? ''}
                  onChange={(e) => setNum('scraper_max_pairs', e.target.value)}
                />
              </div>
            </div>
            <div className="field">
              <label>Treffer pro Kombination</label>
              <input
                type="number"
                placeholder={`Standard: ${effective.per_pair}`}
                value={s.scraper_per_pair ?? ''}
                onChange={(e) => setNum('scraper_per_pair', e.target.value)}
              />
            </div>
            <div className="muted" style={{ fontSize: 13 }}>Aktuell: {perRun}.</div>
          </fieldset>

          <fieldset className="doc-block">
            <legend>KI-Discovery</legend>
            <p className="settings-hint">
              Die Discovery nutzt das in den <strong>Einstellungen</strong> konfigurierte
              Standard-KI-Modell — es gibt kein separates Scraper-Modell mehr. Hier wird nur der
              API-Schlüssel hinterlegt (er überschreibt <code>scraper/.env</code>), sodass ein Lauf
              aus der Oberfläche ohne separate Scraper-Konfiguration funktioniert. Die Discovery
              nutzt die Websuche von Anthropic, daher muss das Standardmodell ein Claude-Modell sein
              (z. B. Opus, Sonnet, Haiku).
            </p>
            {ai &&
              (/claude/i.test(ai.model) ? (
                <div className="section-info" style={{ marginBottom: 10 }}>
                  Discovery-Modell: <strong>{ai.label || ai.model}</strong>
                </div>
              ) : (
                <div className="section-error" style={{ marginBottom: 10 }}>
                  Das konfigurierte Standard-KI-Modell (<code>{ai.model}</code>) ist kein
                  Claude-Modell. Die Discovery läuft daher auf einem Claude-Standardmodell. Für
                  volle Kontrolle in den <strong>Einstellungen</strong> ein Claude-Modell wählen.
                </div>
              ))}
            <div className="row2">
              <div className="field">
                <label>
                  API-Schlüssel{' '}
                  {s.scraper_ai_api_key_set && <span className="user-chip">gespeichert</span>}
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={aiKey}
                  disabled={clearKey}
                  placeholder={
                    s.scraper_ai_api_key_set
                      ? '******** (leer lassen zum Beibehalten)'
                      : 'sk-ant-… (sonst aus scraper/.env)'
                  }
                  onChange={(e) => {
                    setAiKey(e.target.value)
                    setSaved(false)
                  }}
                />
                {s.scraper_ai_api_key_set && (
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={clearKey}
                      onChange={(e) => {
                        setClearKey(e.target.checked)
                        setSaved(false)
                      }}
                    />
                    Gespeicherten Schlüssel löschen
                  </label>
                )}
              </div>
            </div>
            {s.settings_key_configured === false && (
              <p className="settings-hint" style={{ color: 'var(--danger)' }}>
                <code>SETTINGS_KEY</code> ist nicht gesetzt — der Schlüssel wird mit einem unsicheren
                Standardschlüssel verschlüsselt (im Produktivbetrieb wird das Speichern abgelehnt).
              </p>
            )}
          </fieldset>

          <fieldset className="doc-block">
            <legend>Zuletzt gefundene Leads</legend>
            {status.recent.length === 0 ? (
              <div className="center-muted">Noch keine Scraper-Leads.</div>
            ) : (
              <div className="table-wrap">
                <table className="leads">
                  <thead>
                    <tr>
                      <th>Firma</th>
                      <th>Gewerk</th>
                      <th>Ort</th>
                      <th className="num">Score</th>
                      <th>Gefunden</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.recent.map((l) => (
                      <tr key={l.id}>
                        <td data-label="Firma" className="cell-primary">{l.company ?? '—'}</td>
                        <td data-label="Gewerk">{l.trade ?? '—'}</td>
                        <td data-label="Ort">{l.city ?? '—'}</td>
                        <td data-label="Score" className="num">{l.score}</td>
                        <td data-label="Gefunden">{dateOnly(l.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </fieldset>
        </div>
      </div>
    </>
  )
}
