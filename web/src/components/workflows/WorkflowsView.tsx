import { useEffect, useState } from 'react'
import { api } from '../../api'
import { fmtDate } from '../../util'
import type {
  ScraperConfig,
  ScraperStatus,
  Settings,
  WorkflowRun,
  WorkflowSummary,
} from '../../types'

const TOOL_LABEL: Record<string, string> = {
  analyze_lead: 'Qualifiziert',
  draft_outreach: 'Ansprache entworfen',
}

// "2026-06-18 23:13:15" → "18.06.2026"
function dateOnly(ts: string | null): string {
  if (!ts) return '—'
  return fmtDate(ts.slice(0, 10))
}

function RunBadge({ run }: { run: WorkflowRun | null }) {
  if (!run) return <span className="user-chip">noch nie ausgeführt</span>
  if (run.status === 'running') return <span className="user-chip">läuft…</span>
  const cls = run.status === 'ok' ? 'wf-ok' : 'wf-err'
  const when = dateOnly(run.started_at)
  return (
    <span className={`wf-status ${cls}`}>
      {run.status === 'ok' ? '✓' : '⚠'} {run.steps_ok} ok
      {run.steps_failed > 0 ? ` · ${run.steps_failed} Fehler` : ''} · {when}
    </span>
  )
}

function Trail({ run }: { run: WorkflowRun }) {
  if (run.trail.length === 0) {
    return <p className="muted" style={{ margin: '6px 0 0' }}>Keine passenden Leads — nichts zu tun.</p>
  }
  return (
    <ul className="wf-trail">
      {run.trail.map((e, i) => (
        <li key={i} className={e.ok ? '' : 'wf-trail-err'}>
          <span className="wf-trail-target">{e.target}</span>
          <span className="muted"> · {TOOL_LABEL[e.tool] ?? e.tool} · </span>
          <span>{e.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function WorkflowCard({ wf, onRan }: { wf: WorkflowSummary; onRan: () => void }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<WorkflowRun | null>(null)
  const [history, setHistory] = useState<WorkflowRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const shown = result ?? wf.last_run

  async function run() {
    setRunning(true)
    setError(null)
    try {
      const { run } = await api.runWorkflow(wf.key)
      setResult(run)
      setHistory(null)
      onRan()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function toggleHistory() {
    if (history) {
      setHistory(null)
      return
    }
    const { runs } = await api.workflowRuns(wf.key)
    setHistory(runs)
  }

  return (
    <div className="wf-card">
      <div className="wf-card-head">
        <strong>{wf.name}</strong>
        <span className={`user-chip${wf.eligible > 0 ? ' wf-eligible' : ''}`}>
          {wf.eligible} {wf.eligible === 1 ? 'Lead' : 'Leads'}
        </span>
      </div>
      <p className="muted wf-desc">{wf.description}</p>
      <div className="wf-trigger">{wf.trigger}</div>

      <div className="wf-card-foot">
        <RunBadge run={shown} />
        <div className="spacer" />
        <button className="ghost" onClick={toggleHistory}>
          {history ? 'Verlauf ausblenden' : 'Verlauf'}
        </button>
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Läuft…' : 'Jetzt ausführen'}
        </button>
      </div>

      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
      {shown && !history && <Trail run={shown} />}

      {history && (
        <div className="wf-history">
          {history.length === 0 && <p className="muted">Noch keine Läufe.</p>}
          {history.map((r) => (
            <div key={r.id} className="wf-history-row">
              <RunBadge run={r} />
              <Trail run={r} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// The lead scraper, folded in as the discovery step: status + the search raster
// it runs on. The actual run happens in the scraper service (daily, on its own
// schedule); here the operator tunes what it looks for.
function DiscoveryCard() {
  const [s, setS] = useState<Settings | null>(null)
  const [config, setConfig] = useState<ScraperConfig | null>(null)
  const [status, setStatus] = useState<ScraperStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function reload() {
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
    reload()
  }, [])

  if (!s || !config || !status) return null

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
        scraper_trades: s.scraper_trades?.trim() ? s.scraper_trades : null,
        scraper_towns: s.scraper_towns?.trim() ? s.scraper_towns : null,
        scraper_min_score: s.scraper_min_score,
        scraper_max_pairs: s.scraper_max_pairs,
        scraper_per_pair: s.scraper_per_pair,
      })
      await reload()
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const runsPerDay = `bis zu ${config.max_pairs} Kombination(en) × ${config.per_pair} Treffer = max. ${
    config.max_pairs * config.per_pair
  } Kandidaten pro Lauf`

  return (
    <div className="wf-card wf-card-wide">
      <div className="wf-card-head">
        <strong>Lead-Discovery (Scraper)</strong>
        <div className="spacer" />
        {saved && <span className="user-chip">Gespeichert ✓</span>}
        <button className="primary" onClick={save} disabled={saving}>
          {saving ? '…' : 'Suchraster speichern'}
        </button>
      </div>

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

      <div className="schedule-note">
        Der Scraper läuft <strong>täglich automatisch</strong> (GitHub Actions) und legt neue Leads
        über den Service-Token an. Bekannte Domains werden übersprungen. Manuell starten:{' '}
        <code>docker compose --profile tools run --rm scraper</code>
      </div>

      <fieldset className="doc-block">
        <legend>Suchraster</legend>
        <div className="row2">
          <div className="field">
            <label>Gewerke {config.using_defaults.trades && <em>(Standardliste aktiv)</em>}</label>
            <textarea
              rows={6}
              placeholder={'Ein Gewerk pro Zeile, z.B.\nSchreiner\nMaler\nDachdecker'}
              value={s.scraper_trades ?? ''}
              onChange={(e) => set('scraper_trades', e.target.value)}
            />
            {config.using_defaults.trades && (
              <button className="ghost" style={{ marginTop: 6 }} onClick={() => set('scraper_trades', config.trades.join('\n'))}>
                Standardliste einfügen ({config.trades.length})
              </button>
            )}
          </div>
          <div className="field">
            <label>Orte {config.using_defaults.towns && <em>(Standardliste aktiv)</em>}</label>
            <textarea
              rows={6}
              placeholder={'Ein Ort pro Zeile, z.B.\nDachau\nErding\nFreising'}
              value={s.scraper_towns ?? ''}
              onChange={(e) => set('scraper_towns', e.target.value)}
            />
            {config.using_defaults.towns && (
              <button className="ghost" style={{ marginTop: 6 }} onClick={() => set('scraper_towns', config.towns.join('\n'))}>
                Standardliste einfügen ({config.towns.length})
              </button>
            )}
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
              placeholder={`Standard: ${config.min_score}`}
              value={s.scraper_min_score ?? ''}
              onChange={(e) => setNum('scraper_min_score', e.target.value)}
            />
          </div>
          <div className="field">
            <label>Kombinationen pro Lauf (Gewerk × Ort)</label>
            <input
              type="number"
              placeholder={`Standard: ${config.max_pairs}`}
              value={s.scraper_max_pairs ?? ''}
              onChange={(e) => setNum('scraper_max_pairs', e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label>Treffer pro Kombination</label>
          <input
            type="number"
            placeholder={`Standard: ${config.per_pair}`}
            value={s.scraper_per_pair ?? ''}
            onChange={(e) => setNum('scraper_per_pair', e.target.value)}
          />
        </div>
        <div className="muted" style={{ padding: '4px 0' }}>Aktuell: {runsPerDay}.</div>
      </fieldset>
    </div>
  )
}

export function WorkflowsView() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null)

  function load() {
    api.listWorkflows().then(({ workflows }) => setWorkflows(workflows))
  }
  useEffect(() => {
    load()
  }, [])

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Workflows</span>
        <div className="spacer" />
        <button onClick={load}>Aktualisieren</button>
      </div>

      <div className="content">
        <p className="muted" style={{ margin: '0 0 12px' }}>
          Wiederholbare KI-Abläufe auf Basis derselben auditierten Werkzeuge wie das KI-Cockpit —
          aber deterministisch und nachvollziehbar. Ausgehende Nachrichten bleiben Entwürfe und
          müssen freigegeben werden.
        </p>

        {!workflows ? (
          <div className="center-muted">Lädt…</div>
        ) : (
          <div className="wf-grid">
            {workflows.map((wf) => (
              <WorkflowCard key={wf.key} wf={wf} onRan={load} />
            ))}
          </div>
        )}

        <h3 className="wf-section">Lead-Discovery</h3>
        <DiscoveryCard />
      </div>
    </>
  )
}
