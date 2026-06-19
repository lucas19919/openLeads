import type { Hono, MiddlewareHandler } from 'hono'
import { db, type WorkflowRunRow } from './db'
import { audit } from './audit'
import { rateLimit } from './ratelimit'
import { runTool, type ToolContext } from './ai/tools'

// --- Workflows -------------------------------------------------------------
//
// A Workflow is a saved, repeatable run of the same audited agent tools the
// copilot uses (see ai/tools.ts) — but deterministic and inspectable instead of
// freeform chat. Each one resolves a set of target leads, then applies an
// ordered list of tool steps to each. Anything outward-facing (an outreach
// draft) lands in the existing approval queue, never auto-sent.
//
// Definitions live in code; only the run history is persisted (workflow_runs).

interface Target {
  id: number
  label: string
}

interface WorkflowStep {
  tool: string
  args: (t: Target) => Record<string, unknown>
}

interface WorkflowDef {
  key: string
  name: string
  description: string
  trigger: string
  /** Safety cap on how many targets one run touches (each hits the model). */
  defaultLimit: number
  /** Leads this run would act on, newest/most-relevant first, capped to `limit`. */
  resolveTargets: (limit: number) => Target[]
  /** How many leads are currently eligible (ignores the per-run cap). */
  countEligible: () => number
  steps: WorkflowStep[]
}

const label = (row: { id: number; company: string | null }): Target => ({
  id: row.id,
  label: row.company?.trim() || `Lead #${row.id}`,
})

export const WORKFLOWS: WorkflowDef[] = [
  {
    key: 'qualify-new',
    name: 'Neue Leads qualifizieren',
    description:
      'Lässt jeden noch nicht bewerteten Lead in der Stage „neu" von der KI einschätzen ' +
      '(Zusammenfassung, Fit-Score, nächste Maßnahme). Ergebnis erscheint am Lead.',
    trigger: 'Manuell · ideal nach jedem Scraper-Lauf',
    defaultLimit: 5,
    resolveTargets: (limit) =>
      (
        db
          .prepare(
            `SELECT id, company FROM leads
             WHERE stage = 'neu' AND id NOT IN (SELECT lead_id FROM lead_ai)
             ORDER BY score DESC, created_at DESC LIMIT ?`,
          )
          .all(limit) as unknown as { id: number; company: string | null }[]
      ).map(label),
    countEligible: () =>
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM leads
               WHERE stage = 'neu' AND id NOT IN (SELECT lead_id FROM lead_ai)`,
            )
            .get() as { n: number }
        ).n,
      ),
    steps: [{ tool: 'analyze_lead', args: (t) => ({ id: t.id }) }],
  },
  {
    key: 'draft-hot-outreach',
    name: 'Erstansprache für heiße Leads',
    description:
      'Entwirft für jeden als „hot" qualifizierten Lead ohne bisherige Ansprache eine ' +
      'E-Mail. Der Entwurf wird gespeichert und muss am Lead freigegeben werden — nie automatisch gesendet.',
    trigger: 'Manuell · nach dem Qualifizieren',
    defaultLimit: 5,
    resolveTargets: (limit) =>
      (
        db
          .prepare(
            `SELECT l.id, l.company FROM leads l
             JOIN lead_ai a ON a.lead_id = l.id
             WHERE a.qualification = 'hot' AND l.id NOT IN (SELECT lead_id FROM outreach)
             ORDER BY a.fit_score DESC LIMIT ?`,
          )
          .all(limit) as unknown as { id: number; company: string | null }[]
      ).map(label),
    countEligible: () =>
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM leads l
               JOIN lead_ai a ON a.lead_id = l.id
               WHERE a.qualification = 'hot' AND l.id NOT IN (SELECT lead_id FROM outreach)`,
            )
            .get() as { n: number }
        ).n,
      ),
    steps: [{ tool: 'draft_outreach', args: (t) => ({ id: t.id, channel: 'email' }) }],
  },
  {
    key: 'reengage-dormant',
    name: 'Ruhende Leads reaktivieren',
    description:
      'Findet offene Leads ohne Aktivität seit über 30 Tagen und ohne bisherige Ansprache ' +
      'und entwirft eine Reaktivierungs-Mail (Entwurf, Freigabe erforderlich).',
    trigger: 'Manuell · z.B. wöchentlich',
    defaultLimit: 5,
    resolveTargets: (limit) =>
      (
        db
          .prepare(
            `SELECT id, company FROM leads
             WHERE stage NOT IN ('gewonnen', 'verloren')
               AND updated_at < datetime('now', '-30 days')
               AND id NOT IN (SELECT lead_id FROM outreach)
             ORDER BY updated_at ASC LIMIT ?`,
          )
          .all(limit) as unknown as { id: number; company: string | null }[]
      ).map(label),
    countEligible: () =>
      Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM leads
               WHERE stage NOT IN ('gewonnen', 'verloren')
                 AND updated_at < datetime('now', '-30 days')
                 AND id NOT IN (SELECT lead_id FROM outreach)`,
            )
            .get() as { n: number }
        ).n,
      ),
    steps: [{ tool: 'draft_outreach', args: (t) => ({ id: t.id, channel: 'email' }) }],
  },
]

const BY_KEY = new Map(WORKFLOWS.map((w) => [w.key, w]))

interface TrailEntry {
  target_id: number | null
  target: string
  tool: string
  ok: boolean
  detail: string
}

/** Boil a tool result down to one human line for the run trail. */
function summarize(tool: string, result: unknown): { ok: boolean; detail: string } {
  const r = (result ?? {}) as Record<string, unknown>
  if (typeof r.error === 'string') return { ok: false, detail: r.error }
  if (tool === 'analyze_lead') {
    const a = (r.analysis ?? {}) as Record<string, unknown>
    const q = a.qualification ?? '—'
    const fit = a.fit_score != null ? ` · Fit ${a.fit_score}` : ''
    return { ok: true, detail: `${q}${fit}` }
  }
  if (tool === 'draft_outreach') {
    const o = (r.outreach ?? {}) as Record<string, unknown>
    return { ok: true, detail: `Entwurf: „${o.subject ?? 'ohne Betreff'}"` }
  }
  return { ok: true, detail: 'OK' }
}

function getRun(id: number): WorkflowRunRow {
  return db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as unknown as WorkflowRunRow
}

/** Run a workflow synchronously. Per-step failures are recorded, not thrown —
 *  one unreachable model call shouldn't abort the whole run. */
export async function runWorkflow(
  key: string,
  ctx: ToolContext,
  opts: { limit?: number; trigger?: string } = {},
): Promise<WorkflowRunRow> {
  const def = BY_KEY.get(key)
  if (!def) throw new Error(`Unbekannter Workflow: ${key}`)
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit ?? def.defaultLimit)) || def.defaultLimit, 1), 20)

  const info = db
    .prepare(`INSERT INTO workflow_runs (workflow_key, status, trigger, actor) VALUES (?, 'running', ?, ?)`)
    .run(key, opts.trigger ?? 'manual', ctx.actor)
  const runId = Number(info.lastInsertRowid)

  const trail: TrailEntry[] = []
  let okCount = 0
  let failCount = 0
  try {
    const targets = def.resolveTargets(limit)
    for (const t of targets) {
      for (const step of def.steps) {
        const result = await runTool(step.tool, step.args(t), ctx)
        const { ok, detail } = summarize(step.tool, result)
        if (ok) okCount++
        else failCount++
        trail.push({ target_id: t.id, target: t.label, tool: step.tool, ok, detail })
      }
    }
    db.prepare(
      `UPDATE workflow_runs SET status = ?, targets = ?, steps_ok = ?, steps_failed = ?,
         trail = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run(failCount > 0 && okCount === 0 ? 'error' : 'ok', targets.length, okCount, failCount, JSON.stringify(trail), runId)
  } catch (e) {
    db.prepare(
      `UPDATE workflow_runs SET status = 'error', error = ?, trail = ?, finished_at = datetime('now') WHERE id = ?`,
    ).run((e as Error).message, JSON.stringify(trail), runId)
  }
  audit({ actor: ctx.actor, action: 'workflow.run', entity: 'workflow', detail: { key, ok: okCount, failed: failCount }, ip: ctx.ip })
  return getRun(runId)
}

// --- routes ----------------------------------------------------------------

type Vars = { user: { id: number; username: string; role: string } }
type App = Hono<{ Variables: Vars }>

function clientIp(c: Parameters<MiddlewareHandler>[0]): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

/** Parse the stored trail JSON back into an array for the client. */
function withTrail(run: WorkflowRunRow) {
  let trail: TrailEntry[] = []
  try {
    trail = run.trail ? (JSON.parse(run.trail) as TrailEntry[]) : []
  } catch {
    trail = []
  }
  return { ...run, trail }
}

export function registerWorkflowRoutes(app: App, auth: MiddlewareHandler): void {
  app.use('/api/workflows', auth)
  app.use('/api/workflows/*', auth)
  // Runs hit the model; cap to keep a runaway client from hammering it.
  app.use(
    '/api/workflows/*',
    rateLimit({ windowMs: 60_000, max: 20, key: (c) => String((c.get('user') as Vars['user'] | undefined)?.id ?? 'anon') }),
  )

  // Catalogue: each workflow with how many leads are eligible and its last run.
  app.get('/api/workflows', (c) => {
    const workflows = WORKFLOWS.map((w) => {
      const last = db
        .prepare('SELECT * FROM workflow_runs WHERE workflow_key = ? ORDER BY started_at DESC LIMIT 1')
        .get(w.key) as unknown as WorkflowRunRow | undefined
      return {
        key: w.key,
        name: w.name,
        description: w.description,
        trigger: w.trigger,
        eligible: w.countEligible(),
        last_run: last ? withTrail(last) : null,
      }
    })
    return c.json({ workflows })
  })

  // Run history for one workflow.
  app.get('/api/workflows/runs', (c) => {
    const key = c.req.query('key')
    if (!key || !BY_KEY.has(key)) return c.json({ runs: [] })
    const rows = db
      .prepare('SELECT * FROM workflow_runs WHERE workflow_key = ? ORDER BY started_at DESC LIMIT 20')
      .all(key) as unknown as WorkflowRunRow[]
    return c.json({ runs: rows.map(withTrail) })
  })

  // Execute a workflow now.
  app.post('/api/workflows/:key/run', async (c) => {
    const key = c.req.param('key')
    if (!BY_KEY.has(key)) return c.json({ error: 'Unbekannter Workflow' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as { limit?: number }
    const user = c.get('user')
    const run = await runWorkflow(key, { actor: user.username, ip: clientIp(c) }, { limit: body.limit, trigger: 'manual' })
    return c.json({ run: withTrail(run) })
  })
}
