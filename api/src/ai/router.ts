import type { Hono, MiddlewareHandler } from 'hono'
import { db, type LeadRow, type AiMessageRow, type OutreachRow } from '../db'
import { getDocument, getSettings, replaceItems } from '../documents'
import { audit } from '../audit'
import { composeOutreachEmail, sendMail, isMailConfigured } from '../mailer'
import { probe, AI, isLocalInference, AIError } from './provider'
import { analyzeLead, draftOutreach, draftInvoiceFromText } from './leadIntel'
import { suggestScraperRaster } from './website'
import {
  SEQUENCE_TEMPLATES,
  sanitizeSteps,
  listSequences,
  getSequence,
  createSequence,
  setSequenceStatus,
  deleteSequence,
  materializeDueStep,
  advanceAfterSend,
} from '../sequences'
import { buildDigest } from './digest'
import { reindexLeads, searchLeads } from './semantic'
import { runAgent } from './agent'
import { rateLimit } from '../ratelimit'
import { leadEmailBlocked } from '../dsgvo'
import type { ChatMessage } from './types'

// Cap free-text inputs so a single request can't blow up the model context.
const MAX_INPUT = 8000

type Vars = { user: { id: number; username: string; role: string } }
type App = Hono<{ Variables: Vars }>

function clientIp(c: Parameters<MiddlewareHandler>[0]): string | null {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null
}

function leadOr404(c: Parameters<MiddlewareHandler>[0]): LeadRow | null {
  const id = Number(c.req.param('id'))
  return (db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as LeadRow | undefined) ?? null
}

/** Mount all /api/ai/* routes. `auth` is the app's requireAuth middleware. */
export function registerAiRoutes(app: App, auth: MiddlewareHandler): void {
  app.use('/api/ai/*', auth)
  // Protect the expensive model endpoints: 30 requests/minute per user.
  app.use(
    '/api/ai/*',
    rateLimit({ windowMs: 60_000, max: 30, key: (c) => String((c.get('user') as Vars['user'] | undefined)?.id ?? 'anon') }),
  )

  // Status badge: is the model reachable, and does inference stay on-prem?
  app.get('/api/ai/status', async (c) => {
    const p = await probe()
    return c.json({
      ...p,
      base_url: AI.baseUrl,
      label: AI.label || AI.model,
      local_inference: isLocalInference(),
    })
  })

  // Morning briefing: prioritised actions across pipeline + ledger.
  app.get('/api/ai/digest', async (c) => {
    const digest = await buildDigest()
    return c.json({ digest })
  })

  // "Analyse meine Website" → propose a lead-search raster (trades/region/towns)
  // from the operator's own homepage. Suggestion only; the UI fills the form and
  // the operator reviews + saves.
  app.post('/api/ai/scraper/suggest', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { url?: string }
    const url = (b.url ?? '').trim()
    if (!url) return c.json({ error: 'url fehlt' }, 400)
    try {
      const suggestion = await suggestScraperRaster(url)
      audit({ actor: c.get('user').username, action: 'ai.scraper_suggest', entity: 'settings', entityId: 1, detail: { url }, ip: clientIp(c) })
      return c.json({ suggestion })
    } catch (e) {
      return c.json({ error: (e as Error).message }, e instanceof AIError ? 502 : 400)
    }
  })

  // --- Copilot ------------------------------------------------------------
  app.post('/api/ai/chat', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { thread_id?: number; message?: string }
    const text = (b.message ?? '').trim()
    if (!text) return c.json({ error: 'message fehlt' }, 400)
    if (text.length > MAX_INPUT) return c.json({ error: 'Nachricht zu lang.' }, 413)
    const user = c.get('user')

    let threadId = b.thread_id
    if (!threadId) {
      const info = db.prepare('INSERT INTO ai_threads (title) VALUES (?)').run(text.slice(0, 60))
      threadId = Number(info.lastInsertRowid)
    }

    // Reconstruct prior prose turns (tools are re-run fresh, not replayed).
    const prior = db
      .prepare("SELECT role, content FROM ai_messages WHERE thread_id = ? AND role IN ('user','assistant') ORDER BY id")
      .all(threadId) as unknown as Pick<AiMessageRow, 'role' | 'content'>[]
    const history: ChatMessage[] = prior.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    history.push({ role: 'user', content: text })

    db.prepare('INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, 'user', text)

    try {
      const run = await runAgent(history, { actor: 'ai', ip: clientIp(c) })
      db.prepare('INSERT INTO ai_messages (thread_id, role, content, tool_calls) VALUES (?, ?, ?, ?)').run(
        threadId, 'assistant', run.reply, run.steps.length ? JSON.stringify(run.steps.map((s) => ({ tool: s.tool, args: s.args }))) : null,
      )
      db.prepare("UPDATE ai_threads SET updated_at = datetime('now') WHERE id = ?").run(threadId)
      audit({ actor: user.username, action: 'ai.chat', entity: 'ai_thread', entityId: threadId, detail: { tools: run.steps.map((s) => s.tool) }, ip: clientIp(c) })
      return c.json({ thread_id: threadId, reply: run.reply, steps: run.steps })
    } catch (e) {
      const status = e instanceof AIError ? 502 : 500
      return c.json({ thread_id: threadId, error: (e as Error).message }, status)
    }
  })

  app.get('/api/ai/threads', (c) => {
    const rows = db.prepare('SELECT id, title, created_at, updated_at FROM ai_threads ORDER BY updated_at DESC LIMIT 50').all()
    return c.json({ threads: rows })
  })

  app.get('/api/ai/threads/:id', (c) => {
    const id = Number(c.req.param('id'))
    const thread = db.prepare('SELECT * FROM ai_threads WHERE id = ?').get(id)
    if (!thread) return c.json({ error: 'not found' }, 404)
    const messages = db.prepare('SELECT role, content, tool_calls, created_at FROM ai_messages WHERE thread_id = ? ORDER BY id').all(id)
    return c.json({ thread, messages })
  })

  // --- Semantic lead search ----------------------------------------------
  // Natural-language search ("Schreiner ohne Mobilseite bei München"). Falls
  // back to SQL LIKE when the embedding model is unavailable, so it never dies.
  app.get('/api/ai/leads/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim()
    if (!q) return c.json({ mode: 'semantic', hits: [] })
    try {
      const hits = await searchLeads(q, Number(c.req.query('limit') ?? 15) || 15)
      return c.json({ mode: 'semantic', hits })
    } catch {
      const like = `%${q}%`
      const leads = db
        .prepare(
          `SELECT * FROM leads
            WHERE company LIKE ? OR city LIKE ? OR trade LIKE ? OR tech LIKE ? OR why_lead LIKE ?
            ORDER BY score DESC LIMIT 15`,
        )
        .all(like, like, like, like, like) as unknown as LeadRow[]
      return c.json({ mode: 'fallback', hits: leads.map((lead) => ({ lead, score: 0 })) })
    }
  })

  app.post('/api/ai/leads/reindex', async (c) => {
    try {
      const r = await reindexLeads({ all: c.req.query('all') === '1' })
      return c.json(r)
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  // --- Lead intelligence --------------------------------------------------
  app.post('/api/ai/leads/:id/analyze', async (c) => {
    const lead = leadOr404(c)
    if (!lead) return c.json({ error: 'not found' }, 404)
    try {
      const analysis = await analyzeLead(lead, c.get('user').username)
      return c.json({ analysis })
    } catch (e) {
      return c.json({ error: (e as Error).message }, e instanceof AIError ? 502 : 500)
    }
  })

  app.post('/api/ai/leads/:id/outreach', async (c) => {
    const lead = leadOr404(c)
    if (!lead) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { channel?: 'email' | 'letter' | 'call_script' }
    try {
      const outreach = await draftOutreach(lead, c.get('user').username, b.channel ?? 'email')
      return c.json({ outreach })
    } catch (e) {
      return c.json({ error: (e as Error).message }, e instanceof AIError ? 502 : 500)
    }
  })

  app.get('/api/ai/leads/:id/outreach', (c) => {
    const id = Number(c.req.param('id'))
    const rows = db.prepare('SELECT * FROM outreach WHERE lead_id = ? ORDER BY created_at DESC').all(id)
    return c.json({ outreach: rows })
  })

  // Approve / discard / mark-sent a drafted message (never auto-sent).
  app.patch('/api/ai/outreach/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as { status?: string; subject?: string; body?: string }
    const allowed = ['entwurf', 'freigegeben', 'gesendet', 'verworfen']
    const sets: string[] = []
    const params: Record<string, string | number> = { id }
    if (b.status && allowed.includes(b.status)) { sets.push('status = @status'); params.status = b.status }
    if (typeof b.subject === 'string') { sets.push('subject = @subject'); params.subject = b.subject }
    if (typeof b.body === 'string') { sets.push('body = @body'); params.body = b.body }
    if (!sets.length) return c.json({ error: 'nichts zu ändern' }, 400)
    sets.push("updated_at = datetime('now')")
    db.prepare(`UPDATE outreach SET ${sets.join(', ')} WHERE id = @id`).run(params)
    audit({ actor: c.get('user').username, action: 'ai.outreach_update', entity: 'outreach', entityId: id, detail: { status: b.status }, ip: clientIp(c) })
    return c.json({ outreach: db.prepare('SELECT * FROM outreach WHERE id = ?').get(id) })
  })

  // Send an APPROVED outreach draft. Hard gates: must be status 'freigegeben',
  // lead must have an email. Impressum + opt-out are appended automatically.
  // Never sends from a raw 'entwurf' — a human must approve first (UWG §7).
  app.post('/api/ai/outreach/:id/send', async (c) => {
    const id = Number(c.req.param('id'))
    const o = db.prepare('SELECT * FROM outreach WHERE id = ?').get(id) as unknown as OutreachRow | undefined
    if (!o) return c.json({ error: 'not found' }, 404)
    if (o.channel !== 'email') return c.json({ error: 'Nur E-Mail-Entwürfe können versendet werden.' }, 400)
    if (o.status !== 'freigegeben') {
      return c.json({ error: 'Entwurf muss zuerst freigegeben werden (Vier-Augen-Prinzip).' }, 409)
    }
    if (!isMailConfigured()) return c.json({ error: 'SMTP ist nicht konfiguriert.' }, 400)
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(o.lead_id) as unknown as LeadRow | undefined
    if (!lead) return c.json({ error: 'Lead nicht gefunden' }, 404)
    // Honour a recorded objection: never e-mail a lead who has opted out
    // (Art. 21 DSGVO Widerspruch / UWG §7). The opt-out footer promises this.
    if (leadEmailBlocked(lead.id)) {
      return c.json(
        { error: 'Dieser Lead hat der E-Mail-Ansprache widersprochen (Art. 21 DSGVO / UWG §7) — kein Versand.' },
        409,
      )
    }
    try {
      const email = composeOutreachEmail(o, lead, getSettings())
      const { messageId } = await sendMail(email)
      db.prepare("UPDATE outreach SET status = 'gesendet', updated_at = datetime('now') WHERE id = ?").run(id)
      db.prepare(`INSERT INTO lead_events (lead_id, actor, type, body) VALUES (?, ?, 'outreach_sent', ?)`)
        .run(lead.id, c.get('user').username, `E-Mail gesendet an ${email.to}`)
      audit({ actor: c.get('user').username, action: 'ai.outreach_send', entity: 'outreach', entityId: id, detail: { to: email.to, messageId }, ip: clientIp(c) })
      // If this draft belongs to a follow-up sequence, schedule the next step
      // (best-effort — a sequence hiccup must not fail a successful send).
      try {
        advanceAfterSend({ ...o, status: 'gesendet' })
      } catch {
        /* ignore */
      }
      return c.json({ ok: true, messageId, to: email.to })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502)
    }
  })

  // --- Follow-up sequences -----------------------------------------------
  // Available templates + a lead's sequences.
  app.get('/api/ai/leads/:id/sequences', (c) => {
    const id = Number(c.req.param('id'))
    return c.json({
      sequences: listSequences(id),
      templates: Object.entries(SEQUENCE_TEMPLATES).map(([key, t]) => ({ key, name: t.name, steps: t.steps })),
    })
  })

  // Start a sequence for a lead (from a template key or explicit steps) and draft
  // the first step right away so it's there to review.
  app.post('/api/ai/leads/:id/sequences', async (c) => {
    const id = Number(c.req.param('id'))
    const lead = leadOr404(c)
    if (!lead) return c.json({ error: 'Lead nicht gefunden' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { template?: string; steps?: unknown; name?: string }
    let steps
    let name = b.name
    try {
      if (b.template) {
        const t = SEQUENCE_TEMPLATES[b.template]
        if (!t) return c.json({ error: 'Unbekannte Vorlage.' }, 400)
        steps = t.steps
        name ??= t.name
      } else {
        steps = sanitizeSteps(b.steps)
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
    const seq = createSequence(id, steps, name)
    audit({ actor: c.get('user').username, action: 'ai.sequence_start', entity: 'lead', entityId: id, detail: { sequence_id: seq.id, steps: steps.length }, ip: clientIp(c) })
    // Draft step 0 now (best-effort; if the model is down it'll retry on the tick).
    let outreach = null
    try {
      outreach = await materializeDueStep(seq, c.get('user').username)
    } catch {
      /* model offline — scheduler will retry */
    }
    return c.json({ sequence: getSequence(seq.id), outreach }, 201)
  })

  // Pause / resume / stop a sequence.
  app.patch('/api/ai/sequences/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!getSequence(id)) return c.json({ error: 'not found' }, 404)
    const b = (await c.req.json().catch(() => ({}))) as { status?: string }
    if (!b.status) return c.json({ error: 'status fehlt' }, 400)
    const seq = setSequenceStatus(id, b.status)
    audit({ actor: c.get('user').username, action: 'ai.sequence_update', entity: 'sequence', entityId: id, detail: { status: b.status }, ip: clientIp(c) })
    return c.json({ sequence: seq })
  })

  app.delete('/api/ai/sequences/:id', (c) => {
    const id = Number(c.req.param('id'))
    if (!deleteSequence(id)) return c.json({ error: 'not found' }, 404)
    audit({ actor: c.get('user').username, action: 'ai.sequence_delete', entity: 'sequence', entityId: id, ip: clientIp(c) })
    return c.json({ ok: true })
  })

  // --- Natural-language invoicing ----------------------------------------
  app.post('/api/ai/invoice/draft', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { text?: string; create?: boolean; lead_id?: number }
    const text = (b.text ?? '').trim()
    if (!text) return c.json({ error: 'text fehlt' }, 400)
    if (text.length > MAX_INPUT) return c.json({ error: 'Text zu lang.' }, 413)
    try {
      const draft = await draftInvoiceFromText(text)
      if (!b.create) return c.json({ draft })
      const s = getSettings()
      const info = db.prepare(
        `INSERT INTO documents (kind, lead_id, client_name, title, intro, notes, small_business, vat_rate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(draft.kind, b.lead_id ?? null, draft.client_name, draft.title, draft.intro, draft.notes, s.small_business, s.vat_rate)
      const id = Number(info.lastInsertRowid)
      replaceItems(id, draft.items)
      audit({ actor: c.get('user').username, action: 'ai.invoice_draft', entity: 'document', entityId: id, detail: { kind: draft.kind, model: AI.model }, ip: clientIp(c) })
      return c.json({ draft, document: getDocument(id) }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message }, e instanceof AIError ? 502 : 500)
    }
  })
}
