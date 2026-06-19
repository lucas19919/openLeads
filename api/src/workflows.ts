import type { Hono, MiddlewareHandler } from 'hono'
import { db, type WorkflowRow, type WorkflowRunRow } from './db'
import { audit } from './audit'
import { rateLimit } from './ratelimit'
import { runTool, type ToolContext } from './ai/tools'
import { runScrape } from './scrape'

// --- Workflows (routines) --------------------------------------------------
//
// A Workflow is a saved, user-built routine: a TARGET (which leads to act on)
// plus an ordered list of STEPS, each a small audited agent action — the same
// tools the copilot uses (ai/tools.ts). Routines can run on demand or on a
// recurring schedule. Anything outward-facing (an outreach draft) still lands
// in the approval queue and is never auto-sent.
//
// Definitions live in the `workflows` table; run history in `workflow_runs`.

// --- step catalogue (the palette the builder offers) -----------------------

type ParamType = 'enum' | 'stage' | 'priority' | 'text'

export interface ActionParamSpec {
  key: string
  label: string
  type: ParamType
  options?: string[]
  default?: string
}

export interface ActionSpec {
  action: string
  label: string
  description: string
  scope: 'global' | 'lead'
  params: ActionParamSpec[]
}

export const WORKFLOW_ACTIONS: ActionSpec[] = [
  {
    action: 'scrape',
    label: 'Neue Leads scrapen',
    description: 'Startet die Lead-Discovery (Scraper) einmal vorab — neue Treffer fließen in die Zielauswahl ein.',
    scope: 'global',
    params: [],
  },
  {
    action: 'analyze_lead',
    label: 'Bewerten / Qualifizieren',
    description: 'KI-Einschätzung pro Lead (Zusammenfassung, Fit-Score, nächste Maßnahme).',
    scope: 'lead',
    params: [],
  },
  {
    action: 'draft_outreach',
    label: 'Kalt-E-Mail entwerfen',
    description: 'Entwirft eine Erstansprache. Bleibt Entwurf, Freigabe erforderlich — nie automatisch gesendet.',
    scope: 'lead',
    params: [
      { key: 'channel', label: 'Kanal', type: 'enum', options: ['email', 'letter', 'call_script'], default: 'email' },
    ],
  },
  {
    action: 'move_lead_stage',
    label: 'In Phase verschieben',
    description: 'Setzt den Lead in eine andere Pipeline-Phase.',
    scope: 'lead',
    params: [{ key: 'stage', label: 'Phase', type: 'stage' }],
  },
  {
    action: 'set_priority',
    label: 'Priorität setzen',
    description: 'Setzt die Priorität (hoch / mittel / niedrig).',
    scope: 'lead',
    params: [{ key: 'priority', label: 'Priorität', type: 'priority' }],
  },
  {
    action: 'add_tags',
    label: 'Tags hinzufügen',
    description: 'Ergänzt ein oder mehrere Tags (bestehende bleiben erhalten).',
    scope: 'lead',
    params: [{ key: 'tags', label: 'Tags (Komma-getrennt)', type: 'text' }],
  },
  {
    action: 'add_note',
    label: 'Notiz hinzufügen',
    description: 'Schreibt eine Notiz in den Lead-Verlauf.',
    scope: 'lead',
    params: [{ key: 'note', label: 'Notiztext', type: 'text' }],
  },
]

const ACTION_BY_NAME = new Map(WORKFLOW_ACTIONS.map((a) => [a.action, a]))
const isGlobal = (action: string) => ACTION_BY_NAME.get(action)?.scope === 'global'

// --- target + step shapes --------------------------------------------------

export interface LeadTarget {
  stage?: string | null // exact stage; empty/'any' → all non-terminal
  tag?: string | null // substring match on tags
  min_score?: number | null
  qualification?: string | null // hot|warm|cold|disqualified; empty → no filter
  unanalyzed?: boolean // no KI-analysis yet
  no_outreach?: boolean // no outreach drafted yet
  dormant?: boolean // untouched for 30+ days
  order?: 'score' | 'oldest' | 'newest'
  limit?: number
}

export interface WorkflowStepDef {
  action: string
  params: Record<string, unknown>
}

interface Target {
  id: number
  label: string
}

const label = (row: { id: number; company: string | null }): Target => ({
  id: row.id,
  label: row.company?.trim() || `Lead #${row.id}`,
})

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.floor(n) || lo, lo), hi)

// --- normalisation (never trust client/stored JSON blindly) ----------------

function normalizeTarget(raw: unknown): LeadTarget {
  const r = (raw ?? {}) as Record<string, unknown>
  const t: LeadTarget = {}
  if (typeof r.stage === 'string' && r.stage && r.stage !== 'any') t.stage = r.stage
  if (typeof r.tag === 'string' && r.tag.trim()) t.tag = r.tag.trim()
  if (r.min_score != null && Number.isFinite(Number(r.min_score))) t.min_score = Number(r.min_score)
  if (typeof r.qualification === 'string' && r.qualification && r.qualification !== 'any') t.qualification = r.qualification
  if (r.unanalyzed) t.unanalyzed = true
  if (r.no_outreach) t.no_outreach = true
  if (r.dormant) t.dormant = true
  t.order = r.order === 'oldest' || r.order === 'newest' ? r.order : 'score'
  t.limit = clamp(Number(r.limit ?? 5), 1, 50)
  return t
}

function normalizeSteps(raw: unknown): WorkflowStepDef[] {
  if (!Array.isArray(raw)) return []
  const out: WorkflowStepDef[] = []
  for (const s of raw) {
    const action = (s as { action?: unknown })?.action
    if (typeof action !== 'string' || !ACTION_BY_NAME.has(action)) continue
    const spec = ACTION_BY_NAME.get(action)!
    const rawParams = ((s as { params?: unknown })?.params ?? {}) as Record<string, unknown>
    const params: Record<string, unknown> = {}
    for (const p of spec.params) {
      const v = rawParams[p.key]
      if (v != null && v !== '') params[p.key] = v
    }
    out.push({ action, params })
  }
  return out
}

// --- target resolution -----------------------------------------------------

function buildTargetQuery(t: LeadTarget): { where: string; params: (string | number)[]; order: string } {
  const clauses: string[] = []
  const params: (string | number)[] = []
  if (t.stage) {
    clauses.push('stage = ?')
    params.push(t.stage)
  } else {
    clauses.push("stage NOT IN ('gewonnen','verloren')")
  }
  if (t.tag) {
    clauses.push('tags LIKE ?')
    params.push(`%${t.tag}%`)
  }
  if (t.min_score != null) {
    clauses.push('score >= ?')
    params.push(t.min_score)
  }
  if (t.qualification) {
    clauses.push('id IN (SELECT lead_id FROM lead_ai WHERE qualification = ?)')
    params.push(t.qualification)
  }
  if (t.unanalyzed) clauses.push('id NOT IN (SELECT lead_id FROM lead_ai)')
  if (t.no_outreach) clauses.push('id NOT IN (SELECT lead_id FROM outreach)')
  if (t.dormant) clauses.push("updated_at < datetime('now', '-30 days')")
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const order =
    t.order === 'oldest' ? 'updated_at ASC' : t.order === 'newest' ? 'created_at DESC' : 'score DESC, created_at DESC'
  return { where, params, order }
}

function resolveTargets(t: LeadTarget, limit: number): Target[] {
  const { where, params, order } = buildTargetQuery(t)
  return (
    db
      .prepare(`SELECT id, company FROM leads ${where} ORDER BY ${order} LIMIT ?`)
      .all(...params, limit) as unknown as { id: number; company: string | null }[]
  ).map(label)
}

function countEligible(t: LeadTarget): number {
  const { where, params } = buildTargetQuery(t)
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM leads ${where}`).get(...params) as { n: number }).n)
}

// --- step execution --------------------------------------------------------

/** Merge new comma-separated tags into an existing list (trim + de-dupe). */
function mergeTags(existing: string | null, add: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of `${existing ?? ''},${add}`.split(',')) {
    const v = raw.trim()
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out.join(',')
}

async function runLeadStep(action: string, params: Record<string, unknown>, t: Target, ctx: ToolContext): Promise<unknown> {
  switch (action) {
    case 'analyze_lead':
      return runTool('analyze_lead', { id: t.id }, ctx)
    case 'draft_outreach':
      return runTool('draft_outreach', { id: t.id, channel: params.channel ?? 'email' }, ctx)
    case 'move_lead_stage':
      return runTool('move_lead_stage', { id: t.id, stage: params.stage }, ctx)
    case 'set_priority':
      return runTool('update_lead', { id: t.id, fields: { priority: params.priority } }, ctx)
    case 'add_note':
      return runTool('add_note', { id: t.id, note: params.note ?? '' }, ctx)
    case 'add_tags': {
      const row = db.prepare('SELECT tags FROM leads WHERE id = ?').get(t.id) as { tags: string | null } | undefined
      const merged = mergeTags(row?.tags ?? null, String(params.tags ?? ''))
      return runTool('update_lead', { id: t.id, fields: { tags: merged } }, ctx)
    }
    default:
      return { error: `Unbekannte Aktion: ${action}` }
  }
}

/** One human line per step for the run trail. */
function summarize(action: string, result: unknown): { ok: boolean; detail: string } {
  const r = (result ?? {}) as Record<string, unknown>
  if (typeof r.error === 'string') return { ok: false, detail: r.error }
  switch (action) {
    case 'analyze_lead': {
      const a = (r.analysis ?? {}) as Record<string, unknown>
      const fit = a.fit_score != null ? ` · Fit ${a.fit_score}` : ''
      return { ok: true, detail: `${a.qualification ?? '—'}${fit}` }
    }
    case 'draft_outreach': {
      const o = (r.outreach ?? {}) as Record<string, unknown>
      return { ok: true, detail: `Entwurf: „${o.subject ?? 'ohne Betreff'}"` }
    }
    case 'move_lead_stage':
      return { ok: true, detail: r.unchanged ? 'bereits in Phase' : `→ ${r.to ?? '—'}` }
    case 'set_priority':
      return { ok: true, detail: 'Priorität gesetzt' }
    case 'add_tags':
      return { ok: true, detail: 'Tags ergänzt' }
    case 'add_note':
      return { ok: true, detail: 'Notiz ergänzt' }
    default:
      return { ok: true, detail: 'OK' }
  }
}

// --- the runner ------------------------------------------------------------

function getWorkflow(id: number): WorkflowRow | undefined {
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as unknown as WorkflowRow | undefined
}

function getRun(id: number): WorkflowRunRow {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as unknown as WorkflowRunRow
}

interface TrailEntry {
  target_id: number | null
  target: string
  tool: string
  ok: boolean
  detail: string
}

/** Run a routine synchronously. Per-step failures are recorded, not thrown —
 *  one unreachable model call shouldn't abort the whole run. Global steps
 *  (scrape) run first, so freshly discovered leads enter the target set. */
export async function runWorkflow(
  id: number,
  ctx: ToolContext,
  opts: { limit?: number; trigger?: string } = {},
): Promise<WorkflowRunRow> {
  const wf = getWorkflow(id)
  if (!wf) throw new Error(`Unbekannter Workflow: ${id}`)
  const target = normalizeTarget(safeParse(wf.target))
  const steps = normalizeSteps(safeParse(wf.steps))
  const limit = clamp(Number(opts.limit ?? target.limit ?? 5), 1, 50)

  const info = db
    .prepare(`INSERT INTO workflow_runs (workflow_key, status, trigger, actor) VALUES (?, 'running', ?, ?)`)
    .run(String(id), opts.trigger ?? 'manual', ctx.actor)
  const runId = Number(info.lastInsertRowid)

  const trail: TrailEntry[] = []
  let okCount = 0
  let failCount = 0
  let targetCount = 0
  try {
    const globalSteps = steps.filter((s) => isGlobal(s.action))
    const leadSteps = steps.filter((s) => !isGlobal(s.action))

    for (const gs of globalSteps) {
      const result = gs.action === 'scrape' ? await runScrape() : { ok: true }
      const ok = (result as { ok?: boolean }).ok !== false
      const detail = (result as { detail?: string }).detail ?? 'OK'
      ok ? okCount++ : failCount++
      trail.push({ target_id: null, target: 'Discovery', tool: gs.action, ok, detail })
    }

    if (leadSteps.length) {
      const targets = resolveTargets(target, limit)
      targetCount = targets.length
      for (const t of targets) {
        for (const ls of leadSteps) {
          const result = await runLeadStep(ls.action, ls.params, t, ctx)
          const { ok, detail } = summarize(ls.action, result)
          ok ? okCount++ : failCount++
          trail.push({ target_id: t.id, target: t.label, tool: ls.action, ok, detail })
        }
      }
    }

    db.prepare(
      `UPDATE workflow_runs SET status = ?, targets = ?, steps_ok = ?, steps_failed = ?,
         trail = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run(failCount > 0 && okCount === 0 ? 'error' : 'ok', targetCount, okCount, failCount, JSON.stringify(trail), runId)
  } catch (e) {
    db.prepare(
      `UPDATE workflow_runs SET status = 'error', error = ?, trail = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run((e as Error).message, JSON.stringify(trail), runId)
  }
  audit({ actor: ctx.actor, action: 'workflow.run', entity: 'workflow', entityId: id, detail: { ok: okCount, failed: failCount, trigger: opts.trigger ?? 'manual' }, ip: ctx.ip })
  return getRun(runId)
}

function safeParse(s: string | null): unknown {
  try {
    return s ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

// --- scheduling ------------------------------------------------------------

function parseHHMM(time: string | null): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? '')
  if (!m) return [9, 0]
  return [clamp(Number(m[1]), 0, 23), clamp(Number(m[2]), 0, 59)]
}

/** Next fire instant (UTC ISO) for a schedule, computed in server-local time.
 *  Returns null when scheduling is off. */
export function computeNextRun(
  kind: string,
  time: string | null,
  weekday: number | null,
  from: Date = new Date(),
): string | null {
  if (kind === 'off') return null
  const next = new Date(from)
  if (kind === 'hourly') {
    next.setMinutes(0, 0, 0)
    next.setHours(next.getHours() + 1)
    return next.toISOString()
  }
  const [hh, mm] = parseHHMM(time)
  next.setHours(hh, mm, 0, 0)
  if (kind === 'daily') {
    if (next <= from) next.setDate(next.getDate() + 1)
    return next.toISOString()
  }
  if (kind === 'weekly') {
    const wd = weekday == null ? 1 : clamp(weekday, 0, 6)
    let delta = (wd - next.getDay() + 7) % 7
    if (delta === 0 && next <= from) delta = 7
    next.setDate(next.getDate() + delta)
    return next.toISOString()
  }
  return null
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let ticking = false

async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const nowIso = new Date().toISOString()
    const due = db
      .prepare(
        `SELECT * FROM workflows
          WHERE enabled = 1 AND schedule_kind != 'off'
            AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at ASC`,
      )
      .all(nowIso) as unknown as WorkflowRow[]
    for (const wf of due) {
      // Advance the schedule before running so a slow/failing run can't re-fire.
      const next = computeNextRun(wf.schedule_kind, wf.schedule_time, wf.schedule_weekday)
      db.prepare(
        "UPDATE workflows SET last_run_at = datetime('now'), next_run_at = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(next, wf.id)
      try {
        await runWorkflow(wf.id, { actor: 'scheduler' }, { trigger: 'schedule' })
      } catch {
        // recorded in workflow_runs; never let one routine break the loop
      }
    }
  } finally {
    ticking = false
  }
}

/** Start the in-process scheduler (call once, after the server is listening). */
export function startScheduler(): void {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => void tick(), 60_000)
  setTimeout(() => void tick(), 5_000)
}

// --- seed (first run) ------------------------------------------------------

const SEED: Omit<WorkflowRow, 'id' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'enabled' | 'schedule_kind' | 'schedule_time' | 'schedule_weekday'>[] = [
  {
    name: 'Neue Leads qualifizieren',
    description: 'Lässt jeden noch nicht bewerteten Lead in Phase „neu" von der KI einschätzen.',
    target: JSON.stringify({ stage: 'neu', unanalyzed: true, order: 'score', limit: 5 }),
    steps: JSON.stringify([{ action: 'analyze_lead', params: {} }]),
  },
  {
    name: 'Erstansprache für heiße Leads',
    description: 'Entwirft für jeden als „hot" qualifizierten Lead ohne bisherige Ansprache eine E-Mail (Entwurf).',
    target: JSON.stringify({ qualification: 'hot', no_outreach: true, order: 'score', limit: 5 }),
    steps: JSON.stringify([{ action: 'draft_outreach', params: { channel: 'email' } }]),
  },
  {
    name: 'Ruhende Leads reaktivieren',
    description: 'Findet offene Leads ohne Aktivität seit 30+ Tagen und ohne Ansprache und entwirft eine Reaktivierungs-Mail.',
    target: JSON.stringify({ dormant: true, no_outreach: true, order: 'oldest', limit: 5 }),
    steps: JSON.stringify([{ action: 'draft_outreach', params: { channel: 'email' } }]),
  },
]

export function seedWorkflows(): void {
  const n = Number((db.prepare('SELECT COUNT(*) AS n FROM workflows').get() as { n: number }).n)
  if (n > 0) return
  const insert = db.prepare(
    `INSERT INTO workflows (name, description, target, steps) VALUES (@name, @description, @target, @steps)`,
  )
  for (const w of SEED) insert.run(w)
}

// --- serialisation for the client ------------------------------------------

function withTrail(run: WorkflowRunRow) {
  let trail: TrailEntry[] = []
  try {
    trail = run.trail ? (JSON.parse(run.trail) as TrailEntry[]) : []
  } catch {
    trail = []
  }
  return { ...run, trail }
}

function lastRunOf(id: number) {
  const last = db
    .prepare('SELECT * FROM workflow_runs WHERE workflow_key = ? ORDER BY started_at DESC LIMIT 1')
    .get(String(id)) as unknown as WorkflowRunRow | undefined
  return last ? withTrail(last) : null
}

function toWorkflow(row: WorkflowRow) {
  const target = normalizeTarget(safeParse(row.target))
  const steps = normalizeSteps(safeParse(row.steps))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    target,
    steps,
    schedule: {
      kind: row.schedule_kind,
      time: row.schedule_time,
      weekday: row.schedule_weekday,
      enabled: !!row.enabled,
      last_run_at: row.last_run_at,
      next_run_at: row.next_run_at,
    },
    eligible: steps.some((s) => !isGlobal(s.action)) ? countEligible(target) : 0,
    last_run: lastRunOf(row.id),
  }
}

// --- routes ----------------------------------------------------------------

type Vars = { user: { id: number; username: string; role: string } }
type App = Hono<{ Variables: Vars }>

function clientIp(c: Parameters<MiddlewareHandler>[0]): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

interface WorkflowBody {
  name?: unknown
  description?: unknown
  target?: unknown
  steps?: unknown
  schedule?: { kind?: unknown; time?: unknown; weekday?: unknown; enabled?: unknown }
}

const SCHEDULE_KINDS = new Set(['off', 'hourly', 'daily', 'weekly'])

function readSchedule(s: WorkflowBody['schedule']) {
  const kind = typeof s?.kind === 'string' && SCHEDULE_KINDS.has(s.kind) ? s.kind : 'off'
  const time = typeof s?.time === 'string' && /^\d{1,2}:\d{2}$/.test(s.time) ? s.time : null
  const weekday = s?.weekday != null && Number.isFinite(Number(s.weekday)) ? clamp(Number(s.weekday), 0, 6) : null
  const enabled = !!s?.enabled && kind !== 'off'
  const next_run_at = enabled ? computeNextRun(kind, time, weekday) : null
  return { kind, time, weekday, enabled: enabled ? 1 : 0, next_run_at }
}

export function registerWorkflowRoutes(app: App, auth: MiddlewareHandler): void {
  seedWorkflows()

  app.use('/api/workflows', auth)
  app.use('/api/workflows/*', auth)
  // Runs hit the model; cap so a runaway client can't hammer it.
  app.use(
    '/api/workflows/*',
    rateLimit({ windowMs: 60_000, max: 30, key: (c) => String((c.get('user') as Vars['user'] | undefined)?.id ?? 'anon') }),
  )

  // Catalogue: every routine + the action palette for the builder.
  app.get('/api/workflows', (c) => {
    const rows = db.prepare('SELECT * FROM workflows ORDER BY created_at ASC').all() as unknown as WorkflowRow[]
    return c.json({ workflows: rows.map(toWorkflow), actions: WORKFLOW_ACTIONS })
  })

  // Run history for one routine (?key=<workflow id>).
  app.get('/api/workflows/runs', (c) => {
    const key = c.req.query('key')
    if (!key) return c.json({ runs: [] })
    const rows = db
      .prepare('SELECT * FROM workflow_runs WHERE workflow_key = ? ORDER BY started_at DESC LIMIT 20')
      .all(key) as unknown as WorkflowRunRow[]
    return c.json({ runs: rows.map(withTrail) })
  })

  // Create a routine.
  app.post('/api/workflows', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as WorkflowBody
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return c.json({ error: 'Name erforderlich' }, 400)
    const target = JSON.stringify(normalizeTarget(b.target))
    const steps = JSON.stringify(normalizeSteps(b.steps))
    const sch = readSchedule(b.schedule)
    const info = db
      .prepare(
        `INSERT INTO workflows (name, description, target, steps, schedule_kind, schedule_time, schedule_weekday, enabled, next_run_at)
         VALUES (@name, @description, @target, @steps, @kind, @time, @weekday, @enabled, @next_run_at)`,
      )
      .run({
        name,
        description: typeof b.description === 'string' ? b.description : null,
        target,
        steps,
        kind: sch.kind,
        time: sch.time,
        weekday: sch.weekday,
        enabled: sch.enabled,
        next_run_at: sch.next_run_at,
      })
    const id = Number(info.lastInsertRowid)
    audit({ actor: c.get('user').username, action: 'workflow.create', entity: 'workflow', entityId: id, ip: clientIp(c) })
    return c.json({ workflow: toWorkflow(getWorkflow(id)!) }, 201)
  })

  // Update a routine.
  app.patch('/api/workflows/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const wf = getWorkflow(id)
    if (!wf) return c.json({ error: 'Unbekannter Workflow' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as WorkflowBody

    const sets: string[] = []
    const params: Record<string, string | number | null> = { id }
    if (typeof b.name === 'string') {
      const name = b.name.trim()
      if (!name) return c.json({ error: 'Name erforderlich' }, 400)
      sets.push('name = @name')
      params.name = name
    }
    if ('description' in b) {
      sets.push('description = @description')
      params.description = typeof b.description === 'string' ? b.description : null
    }
    if ('target' in b) {
      sets.push('target = @target')
      params.target = JSON.stringify(normalizeTarget(b.target))
    }
    if ('steps' in b) {
      sets.push('steps = @steps')
      params.steps = JSON.stringify(normalizeSteps(b.steps))
    }
    if ('schedule' in b) {
      const sch = readSchedule(b.schedule)
      sets.push('schedule_kind = @kind', 'schedule_time = @time', 'schedule_weekday = @weekday', 'enabled = @enabled', 'next_run_at = @next_run_at')
      params.kind = sch.kind
      params.time = sch.time
      params.weekday = sch.weekday
      params.enabled = sch.enabled
      params.next_run_at = sch.next_run_at
    }
    if (sets.length === 0) return c.json({ workflow: toWorkflow(wf) })
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE workflows SET ${sets.join(', ')} WHERE id = @id`).run(params)
    audit({ actor: c.get('user').username, action: 'workflow.update', entity: 'workflow', entityId: id, ip: clientIp(c) })
    return c.json({ workflow: toWorkflow(getWorkflow(id)!) })
  })

  // Delete a routine (its run history is kept for the audit trail).
  app.delete('/api/workflows/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!getWorkflow(id)) return c.json({ error: 'Unbekannter Workflow' }, 404)
    db.prepare('DELETE FROM workflows WHERE id = ?').run(id)
    audit({ actor: c.get('user').username, action: 'workflow.delete', entity: 'workflow', entityId: id, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // Run a routine now.
  app.post('/api/workflows/:id/run', async (c) => {
    const id = Number(c.req.param('id'))
    if (!getWorkflow(id)) return c.json({ error: 'Unbekannter Workflow' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number }
    const user = c.get('user')
    const run = await runWorkflow(id, { actor: user.username, ip: clientIp(c) }, { limit: body.limit, trigger: 'manual' })
    return c.json({ run: withTrail(run) })
  })
}
