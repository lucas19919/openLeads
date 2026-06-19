import type { Hono, MiddlewareHandler } from 'hono'
import { db, type LeadRow, type AiMessageRow } from '../db'
import { getDocument, getSettings, replaceItems } from '../documents'
import { audit } from '../audit'
import { probe, AI, isLocalInference, AIError } from './provider'
import { analyzeLead, draftOutreach, draftInvoiceFromText } from './leadIntel'
import { runAgent } from './agent'
import type { ChatMessage } from './types'

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

  // --- Copilot ------------------------------------------------------------
  app.post('/api/ai/chat', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { thread_id?: number; message?: string }
    const text = (b.message ?? '').trim()
    if (!text) return c.json({ error: 'message fehlt' }, 400)
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

  // --- Natural-language invoicing ----------------------------------------
  app.post('/api/ai/invoice/draft', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { text?: string; create?: boolean; lead_id?: number }
    const text = (b.text ?? '').trim()
    if (!text) return c.json({ error: 'text fehlt' }, 400)
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
