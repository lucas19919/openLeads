import { useEffect, useState } from 'react'
import { api } from '../../api'
import { fmtDate } from '../../util'
import type {
  ActionSpec,
  Config,
  LeadTarget,
  ScraperConfig,
  ScraperStatus,
  Settings,
  Workflow,
  WorkflowInput,
  WorkflowRun,
  WorkflowStepDef,
} from '../../types'

const TOOL_LABEL: Record<string, string> = {
  scrape: 'Scrape',
  analyze_lead: 'Qualifiziert',
  draft_outreach: 'Ansprache entworfen',
  move_lead_stage: 'Phase verschoben',
  set_priority: 'Priorität gesetzt',
  add_tags: 'Tags ergänzt',
  add_note: 'Notiz ergänzt',
}

const QUAL_OPTIONS = [
  { value: 'hot', label: 'Heiß' },
  { value: 'warm', label: 'Warm' },
  { value: 'cold', label: 'Kalt' },
  { value: 'disqualified', label: 'Disqualifiziert' },
]

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

// "2026-06-18 23:13:15" / ISO → "18.06.2026"
function dateOnly(ts: string | null): string {
  if (!ts) return '—'
  return fmtDate(ts.slice(0, 10))
}

function whenLabel(ts: string | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return dateOnly(ts)
  return d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })
}

function scheduleLabel(s: Workflow['schedule']): string {
  if (s.kind === 'off' || !s.enabled) return 'Manuell'
  if (s.kind === 'hourly') return 'Stündlich'
  const t = s.time ?? '09:00'
  if (s.kind === 'daily') return `Täglich ${t}`
  if (s.kind === 'weekly') return `${WEEKDAYS_SHORT[s.weekday ?? 1]} ${t}`
  return 'Manuell'
}

function stepLabel(step: WorkflowStepDef, actions: ActionSpec[]): string {
  const spec = actions.find((a) => a.action === step.action)
  const base = spec?.label ?? step.action
  const vals = Object.values(step.params ?? {})
    .filter((v) => v != null && v !== '')
    .join(', ')
  return vals ? `${base} · ${vals}` : base
}

function RunBadge({ run }: { run: WorkflowRun | null }) {
  if (!run) return <span className="user-chip">noch nie ausgeführt</span>
  if (run.status === 'running') return <span className="user-chip">läuft…</span>
  const cls = run.status === 'ok' ? 'wf-ok' : 'wf-err'
  return (
    <span className={`wf-status ${cls}`}>
      {run.status === 'ok' ? '✓' : '⚠'} {run.steps_ok} ok
      {run.steps_failed > 0 ? ` · ${run.steps_failed} Fehler` : ''} · {dateOnly(run.started_at)}
    </span>
  )
}

function Trail({ run, actions }: { run: WorkflowRun; actions: ActionSpec[] }) {
  if (run.trail.length === 0) {
    return (
      <p className="muted" style={{ margin: '6px 0 0' }}>
        Keine passenden Leads — nichts zu tun.
      </p>
    )
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

function RoutineCard({
  wf,
  actions,
  onEdit,
  onChanged,
}: {
  wf: Workflow
  actions: ActionSpec[]
  onEdit: () => void
  onChanged: () => void
}) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<WorkflowRun | null>(null)
  const [history, setHistory] = useState<WorkflowRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const shown = result ?? wf.last_run
  const hasLeadSteps = wf.steps.some((s) => actions.find((a) => a.action === s.action)?.scope !== 'global')

  async function run() {
    setRunning(true)
    setError(null)
    try {
      const { run } = await api.runWorkflow(wf.id)
      setResult(run)
      setHistory(null)
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  async function toggleHistory() {
    if (history) return setHistory(null)
    const { runs } = await api.workflowRuns(wf.id)
    setHistory(runs)
  }

  async function toggleSchedule() {
    setBusy(true)
    try {
      await api.updateWorkflow(wf.id, {
        schedule: {
          kind: wf.schedule.kind,
          time: wf.schedule.time,
          weekday: wf.schedule.weekday,
          enabled: !wf.schedule.enabled,
        },
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!window.confirm(`Routine „${wf.name}" löschen?`)) return
    setBusy(true)
    try {
      await api.deleteWorkflow(wf.id)
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wf-card">
      <div className="wf-card-head">
        <strong>{wf.name}</strong>
        {hasLeadSteps && (
          <span className={`user-chip${wf.eligible > 0 ? ' wf-eligible' : ''}`}>
            {wf.eligible} {wf.eligible === 1 ? 'Lead' : 'Leads'}
          </span>
        )}
      </div>
      {wf.description && <p className="muted wf-desc">{wf.description}</p>}

      <div className="wf-steps">
        {wf.steps.length === 0 ? (
          <span className="muted">Keine Schritte</span>
        ) : (
          wf.steps.map((s, i) => (
            <span className="wf-step-chip" key={i}>
              <span className="wf-step-n">{i + 1}</span>
              {stepLabel(s, actions)}
            </span>
          ))
        )}
      </div>

      <div className="wf-trigger">
        <span className={`wf-sched${wf.schedule.enabled ? ' on' : ''}`}>⏱ {scheduleLabel(wf.schedule)}</span>
        {wf.schedule.kind !== 'off' && (
          <button className="ghost wf-toggle" disabled={busy} onClick={toggleSchedule}>
            {wf.schedule.enabled ? 'Pausieren' : 'Aktivieren'}
          </button>
        )}
        {wf.schedule.enabled && wf.schedule.next_run_at && (
          <span className="muted">· nächster Lauf {whenLabel(wf.schedule.next_run_at)}</span>
        )}
      </div>

      <div className="wf-card-foot">
        <RunBadge run={shown} />
        <div className="spacer" />
        <button className="ghost" disabled={busy} onClick={remove}>
          Löschen
        </button>
        <button className="ghost" onClick={toggleHistory}>
          {history ? 'Verlauf aus' : 'Verlauf'}
        </button>
        <button className="ghost" onClick={onEdit}>
          Bearbeiten
        </button>
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Läuft…' : 'Jetzt ausführen'}
        </button>
      </div>

      {error && (
        <p className="error" style={{ marginTop: 8 }}>
          {error}
        </p>
      )}
      {shown && !history && <Trail run={shown} actions={actions} />}

      {history && (
        <div className="wf-history">
          {history.length === 0 && <p className="muted">Noch keine Läufe.</p>}
          {history.map((r) => (
            <div key={r.id} className="wf-history-row">
              <RunBadge run={r} />
              <Trail run={r} actions={actions} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- the builder modal -----------------------------------------------------

interface Draft {
  name: string
  description: string
  target: LeadTarget
  steps: WorkflowStepDef[]
  schedule: { kind: 'off' | 'hourly' | 'daily' | 'weekly'; time: string; weekday: number; enabled: boolean }
}

function blankDraft(): Draft {
  return {
    name: '',
    description: '',
    target: { order: 'score', limit: 5 },
    steps: [],
    schedule: { kind: 'off', time: '09:00', weekday: 1, enabled: false },
  }
}

function fromWorkflow(wf: Workflow): Draft {
  return {
    name: wf.name,
    description: wf.description ?? '',
    target: { order: 'score', limit: 5, ...wf.target },
    steps: wf.steps.map((s) => ({ action: s.action, params: { ...s.params } })),
    schedule: {
      kind: wf.schedule.kind,
      time: wf.schedule.time ?? '09:00',
      weekday: wf.schedule.weekday ?? 1,
      enabled: wf.schedule.enabled,
    },
  }
}

function RoutineEditor({
  initial,
  actions,
  config,
  onClose,
  onSave,
}: {
  initial: Workflow | null
  actions: ActionSpec[]
  config: Config
  onClose: () => void
  onSave: (body: WorkflowInput) => Promise<void>
}) {
  const [d, setD] = useState<Draft>(initial ? fromWorkflow(initial) : blankDraft())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addAction, setAddAction] = useState('')

  const hasLeadSteps = d.steps.some((s) => actions.find((a) => a.action === s.action)?.scope !== 'global')

  function patchTarget(p: Partial<LeadTarget>) {
    setD((c) => ({ ...c, target: { ...c.target, ...p } }))
  }
  function setStepParam(i: number, key: string, value: string) {
    setD((c) => {
      const steps = c.steps.slice()
      steps[i] = { ...steps[i], params: { ...steps[i].params, [key]: value } }
      return { ...c, steps }
    })
  }
  function addStep() {
    const spec = actions.find((a) => a.action === addAction)
    if (!spec) return
    const params: Record<string, unknown> = {}
    for (const p of spec.params) if (p.default != null) params[p.key] = p.default
    setD((c) => ({ ...c, steps: [...c.steps, { action: spec.action, params }] }))
    setAddAction('')
  }
  function moveStep(i: number, dir: -1 | 1) {
    setD((c) => {
      const steps = c.steps.slice()
      const j = i + dir
      if (j < 0 || j >= steps.length) return c
      ;[steps[i], steps[j]] = [steps[j], steps[i]]
      return { ...c, steps }
    })
  }
  function removeStep(i: number) {
    setD((c) => ({ ...c, steps: c.steps.filter((_, k) => k !== i) }))
  }

  async function save() {
    if (!d.name.trim()) return setError('Bitte einen Namen vergeben.')
    if (d.steps.length === 0) return setError('Mindestens ein Schritt nötig.')
    setSaving(true)
    setError(null)
    try {
      await onSave({
        name: d.name.trim(),
        description: d.description.trim() || null,
        target: d.target,
        steps: d.steps,
        schedule: {
          kind: d.schedule.kind,
          time: d.schedule.time,
          weekday: d.schedule.weekday,
          enabled: d.schedule.enabled && d.schedule.kind !== 'off',
        },
      })
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  function renderParam(step: WorkflowStepDef, i: number, p: ActionSpec['params'][number]) {
    const value = String(step.params[p.key] ?? '')
    if (p.type === 'text') {
      return (
        <input key={p.key} placeholder={p.label} value={value} onChange={(e) => setStepParam(i, p.key, e.target.value)} />
      )
    }
    const opts = p.type === 'stage' ? config.stages : p.type === 'priority' ? config.priorities : p.options ?? []
    return (
      <select key={p.key} value={value} onChange={(e) => setStepParam(i, p.key, e.target.value)}>
        <option value="">{p.label}…</option>
        {opts.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    )
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="modal-card wf-editor" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Routine bearbeiten' : 'Neue Routine'}</h2>

        <div className="field">
          <label>Name</label>
          <input
            value={d.name}
            onChange={(e) => setD((c) => ({ ...c, name: e.target.value }))}
            placeholder="z.B. Neue Leads → bewerten → anschreiben"
          />
        </div>
        <div className="field">
          <label>Beschreibung (optional)</label>
          <input value={d.description} onChange={(e) => setD((c) => ({ ...c, description: e.target.value }))} />
        </div>

        {/* steps */}
        <fieldset className="doc-block">
          <legend>Schritte (Reihenfolge)</legend>
          {d.steps.length === 0 && (
            <p className="muted" style={{ margin: '0 0 8px' }}>
              Noch keine Schritte. Unten hinzufügen.
            </p>
          )}
          <div className="wf-step-list">
            {d.steps.map((s, i) => {
              const spec = actions.find((a) => a.action === s.action)
              return (
                <div className="wf-step-row" key={i}>
                  <span className="wf-step-n">{i + 1}</span>
                  <div className="wf-step-main">
                    <div className="wf-step-name">
                      {spec?.label ?? s.action}
                      {spec?.scope === 'global' && <span className="chip wf-global">global</span>}
                    </div>
                    {spec && spec.params.length > 0 && (
                      <div className="wf-step-params">{spec.params.map((p) => renderParam(s, i, p))}</div>
                    )}
                  </div>
                  <div className="wf-step-actions">
                    <button className="ghost" onClick={() => moveStep(i, -1)} disabled={i === 0} title="Nach oben">
                      ↑
                    </button>
                    <button
                      className="ghost"
                      onClick={() => moveStep(i, 1)}
                      disabled={i === d.steps.length - 1}
                      title="Nach unten"
                    >
                      ↓
                    </button>
                    <button className="ghost" onClick={() => removeStep(i)} title="Entfernen">
                      ✕
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="wf-add-step">
            <select value={addAction} onChange={(e) => setAddAction(e.target.value)}>
              <option value="">Schritt hinzufügen…</option>
              {actions.map((a) => (
                <option key={a.action} value={a.action}>
                  {a.label}
                </option>
              ))}
            </select>
            <button onClick={addStep} disabled={!addAction}>
              + Hinzufügen
            </button>
          </div>
          {addAction && (
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
              {actions.find((a) => a.action === addAction)?.description}
            </p>
          )}
        </fieldset>

        {/* target */}
        <fieldset className="doc-block" disabled={!hasLeadSteps}>
          <legend>Auf welche Leads? {!hasLeadSteps && <em>(nur bei Lead-Schritten)</em>}</legend>
          <div className="row2">
            <div className="field">
              <label>Phase</label>
              <select value={d.target.stage ?? ''} onChange={(e) => patchTarget({ stage: e.target.value || null })}>
                <option value="">Alle offenen</option>
                {config.stages.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Qualifizierung</label>
              <select
                value={d.target.qualification ?? ''}
                onChange={(e) => patchTarget({ qualification: e.target.value || null })}
              >
                <option value="">Beliebig</option>
                {QUAL_OPTIONS.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row2">
            <div className="field">
              <label>Tag enthält</label>
              <input
                value={d.target.tag ?? ''}
                onChange={(e) => patchTarget({ tag: e.target.value || null })}
                placeholder="z.B. vip"
              />
            </div>
            <div className="field">
              <label>Mindest-Score</label>
              <input
                type="number"
                value={d.target.min_score ?? ''}
                onChange={(e) => patchTarget({ min_score: e.target.value === '' ? null : Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="wf-checks">
            <label>
              <input
                type="checkbox"
                checked={!!d.target.unanalyzed}
                onChange={(e) => patchTarget({ unanalyzed: e.target.checked })}
              />{' '}
              noch nicht bewertet
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!d.target.no_outreach}
                onChange={(e) => patchTarget({ no_outreach: e.target.checked })}
              />{' '}
              noch keine Ansprache
            </label>
            <label>
              <input
                type="checkbox"
                checked={!!d.target.dormant}
                onChange={(e) => patchTarget({ dormant: e.target.checked })}
              />{' '}
              ruhend (30+ Tage)
            </label>
          </div>
          <div className="row2">
            <div className="field">
              <label>Reihenfolge</label>
              <select
                value={d.target.order ?? 'score'}
                onChange={(e) => patchTarget({ order: e.target.value as LeadTarget['order'] })}
              >
                <option value="score">Höchster Score zuerst</option>
                <option value="oldest">Älteste zuerst</option>
                <option value="newest">Neueste zuerst</option>
              </select>
            </div>
            <div className="field">
              <label>Max. Leads pro Lauf</label>
              <input
                type="number"
                min={1}
                max={50}
                value={d.target.limit ?? 5}
                onChange={(e) => patchTarget({ limit: Number(e.target.value) })}
              />
            </div>
          </div>
        </fieldset>

        {/* schedule */}
        <fieldset className="doc-block">
          <legend>Zeitplan</legend>
          <div className="row2">
            <div className="field">
              <label>Häufigkeit</label>
              <select
                value={d.schedule.kind}
                onChange={(e) =>
                  setD((c) => ({ ...c, schedule: { ...c.schedule, kind: e.target.value as Draft['schedule']['kind'] } }))
                }
              >
                <option value="off">Manuell (kein Zeitplan)</option>
                <option value="hourly">Stündlich</option>
                <option value="daily">Täglich</option>
                <option value="weekly">Wöchentlich</option>
              </select>
            </div>
            {(d.schedule.kind === 'daily' || d.schedule.kind === 'weekly') && (
              <div className="field">
                <label>Uhrzeit</label>
                <input
                  type="time"
                  value={d.schedule.time}
                  onChange={(e) => setD((c) => ({ ...c, schedule: { ...c.schedule, time: e.target.value } }))}
                />
              </div>
            )}
          </div>
          {d.schedule.kind === 'weekly' && (
            <div className="field">
              <label>Wochentag</label>
              <select
                value={d.schedule.weekday}
                onChange={(e) => setD((c) => ({ ...c, schedule: { ...c.schedule, weekday: Number(e.target.value) } }))}
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={i} value={i}>
                    {w}
                  </option>
                ))}
              </select>
            </div>
          )}
          {d.schedule.kind !== 'off' && (
            <label className="wf-enable">
              <input
                type="checkbox"
                checked={d.schedule.enabled}
                onChange={(e) => setD((c) => ({ ...c, schedule: { ...c.schedule, enabled: e.target.checked } }))}
              />{' '}
              Zeitplan aktiv (läuft automatisch)
            </label>
          )}
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            Uhrzeiten beziehen sich auf die Serverzeit. Automatische Läufe erzeugen — wie manuelle — nur Entwürfe; der
            Versand bleibt manuell.
          </p>
        </fieldset>

        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Abbrechen
          </button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? 'Speichert…' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  )
}

// --- Lead-Discovery (scraper) card -----------------------------------------

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
        Der Scraper läuft <strong>täglich automatisch</strong> (GitHub Actions) und legt neue Leads über den
        Service-Token an. Mit dem Schritt <strong>„Neue Leads scrapen"</strong> lässt er sich auch aus einer Routine
        heraus anstoßen. Bekannte Domains werden übersprungen.
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
            <label>Orte {config.using_defaults.towns && <em>(Standardliste aktiv)</em>}</label>
            <textarea
              rows={6}
              placeholder={'Ein Ort pro Zeile, z.B.\nDachau\nErding\nFreising'}
              value={s.scraper_towns ?? ''}
              onChange={(e) => set('scraper_towns', e.target.value)}
            />
            {config.using_defaults.towns && (
              <button
                className="ghost"
                style={{ marginTop: 6 }}
                onClick={() => set('scraper_towns', config.towns.join('\n'))}
              >
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
        <div className="muted" style={{ padding: '4px 0' }}>
          Aktuell: {runsPerDay}.
        </div>
      </fieldset>
    </div>
  )
}

export function WorkflowsView({ config }: { config: Config }) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null)
  const [actions, setActions] = useState<ActionSpec[]>([])
  const [editing, setEditing] = useState<Workflow | null>(null)
  const [creating, setCreating] = useState(false)

  function load() {
    api.listWorkflows().then(({ workflows, actions }) => {
      setWorkflows(workflows)
      setActions(actions)
    })
  }
  useEffect(() => {
    load()
  }, [])

  async function handleSave(body: WorkflowInput) {
    if (editing) await api.updateWorkflow(editing.id, body)
    else await api.createWorkflow(body)
    setEditing(null)
    setCreating(false)
    load()
  }

  return (
    <>
      <div className="toolbar">
        <span className="page-title">Workflows</span>
        <div className="spacer" />
        <button onClick={load}>Aktualisieren</button>
        <button className="primary" onClick={() => setCreating(true)}>
          + Neue Routine
        </button>
      </div>

      <div className="content">
        <p className="muted" style={{ margin: '0 0 12px' }}>
          Routinen verketten Agenten-Schritte — scrapen, bewerten, anschreiben, einsortieren — auf einer Lead-Auswahl.
          Manuell oder nach Zeitplan. Ausgehende Nachrichten bleiben Entwürfe und müssen freigegeben werden.
        </p>

        {!workflows ? (
          <div className="center-muted">Lädt…</div>
        ) : workflows.length === 0 ? (
          <div className="center-muted">Noch keine Routinen. Lege mit „+ Neue Routine" die erste an.</div>
        ) : (
          <div className="wf-grid">
            {workflows.map((wf) => (
              <RoutineCard key={wf.id} wf={wf} actions={actions} onEdit={() => setEditing(wf)} onChanged={load} />
            ))}
          </div>
        )}

        <h3 className="wf-section">Lead-Discovery</h3>
        <DiscoveryCard />
      </div>

      {(creating || editing) && (
        <RoutineEditor
          initial={editing}
          actions={actions}
          config={config}
          onClose={() => {
            setEditing(null)
            setCreating(false)
          }}
          onSave={handleSave}
        />
      )}
    </>
  )
}
