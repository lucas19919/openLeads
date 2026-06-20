import { useEffect, useState } from 'react'
import { api } from '../../api'
import { fmtDate } from '../../util'
import type { ScraperConfig, ScraperStatus, ScraperSuggestion, Settings } from '../../types'

// "2026-06-18 23:13:15" → "18.06.2026"
function dateOnly(ts: string | null): string {
  if (!ts) return '—'
  return fmtDate(ts.slice(0, 10))
}

export function ScraperView() {
  const [s, setS] = useState<Settings | null>(null)
  const [config, setConfig] = useState<ScraperConfig | null>(null)
  const [status, setStatus] = useState<ScraperStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [starting, setStarting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  // "Analyse meine Website" → ICP suggestion (fills the raster, never auto-saves).
  const [siteUrl, setSiteUrl] = useState('')
  const [suggesting, setSuggesting] = useState(false)
  const [suggestion, setSuggestion] = useState<ScraperSuggestion | null>(null)
  const [suggestErr, setSuggestErr] = useState<string | null>(null)

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
    setSiteUrl((cur) => cur || settings.website || '')
  }

  useEffect(() => {
    reloadAll()
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
      await api.updateSettings({
        scraper_region: s.scraper_region?.trim() ? s.scraper_region : null,
        scraper_trades: s.scraper_trades?.trim() ? s.scraper_trades : null,
        scraper_towns: s.scraper_towns?.trim() ? s.scraper_towns : null,
        scraper_min_score: s.scraper_min_score,
        scraper_max_pairs: s.scraper_max_pairs,
        scraper_per_pair: s.scraper_per_pair,
      })
      const c = await api.scraperConfig()
      setConfig(c)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  async function analyzeSite() {
    setSuggestErr(null)
    setSuggestion(null)
    setSuggesting(true)
    try {
      const { suggestion } = await api.suggestScraperRaster(siteUrl.trim())
      setSuggestion(suggestion)
    } catch (e) {
      setSuggestErr(e instanceof Error ? e.message : 'Analyse fehlgeschlagen.')
    } finally {
      setSuggesting(false)
    }
  }

  function applySuggestion() {
    if (!suggestion) return
    if (suggestion.trades.length) set('scraper_trades', suggestion.trades.join('\n'))
    if (suggestion.towns.length) set('scraper_towns', suggestion.towns.join('\n'))
    if (suggestion.region) set('scraper_region', suggestion.region)
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
                  Sucht über Sonnet + Websuche nach Betrieben mit veralteter Website und legt neue
                  Leads an (Domains im System werden übersprungen). Der Lauf kostet API-Guthaben —
                  der <strong>Testlauf</strong> nutzt Fixtures und kostet nichts.
                </p>
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
            <legend>Zielkunden aus eigener Website (KI)</legend>
            <p className="settings-hint">
              Analysiert deine eigene Website und schlägt passende Gewerke und eine Region für die
              Lead-Suche vor. Der Vorschlag füllt nur das Raster unten — prüfen und speichern bleibt
              bei dir.
            </p>
            <div className="field">
              <label>Eigene Website</label>
              <input
                placeholder="z. B. meine-agentur.de"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
              />
            </div>
            <div className="dunning-actions">
              <button onClick={analyzeSite} disabled={suggesting || !siteUrl.trim()}>
                {suggesting ? 'Analysiere…' : 'Website analysieren'}
              </button>
            </div>
            {suggestErr && <div className="section-error" style={{ marginTop: 10 }}>{suggestErr}</div>}
            {suggestion && (
              <div className="section-info" style={{ marginTop: 10 }}>
                {suggestion.rationale && <p style={{ marginTop: 0 }}>{suggestion.rationale}</p>}
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                  <strong>Gewerke:</strong> {suggestion.trades.join(', ') || '—'}
                  <br />
                  <strong>Region:</strong> {suggestion.region || '—'}
                  <br />
                  <strong>Orte:</strong> {suggestion.towns.join(', ') || '—'}
                </div>
                <button className="primary" style={{ marginTop: 10 }} onClick={applySuggestion}>
                  Ins Raster übernehmen
                </button>
              </div>
            )}
          </fieldset>

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
