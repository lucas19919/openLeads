import type { Hono } from 'hono'
import { db, type LeadRow } from '../db'
import { insertLead, applyLeadUpdate, queryLeads } from '../leads'
import { parseWorkbookBuffer } from '../import'
import { leadsCsv, exportFilename } from '../export'
import { audit } from '../audit'
import { requireAuth, type Vars } from './middleware'
import { csvResponse } from './helpers'

export function registerLeadRoutes(app: Hono<{ Variables: Vars }>): void {
  app.get('/api/leads', requireAuth, (c) =>
    c.json({ leads: queryLeads(c.req.query('stage'), c.req.query('q')) }),
  )

  app.get('/api/leads/:id', requireAuth, (c) => {
    const id = Number(c.req.param('id'))
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as unknown as
      | LeadRow
      | undefined
    if (!lead) return c.json({ error: 'not found' }, 404)
    const events = db
      .prepare('SELECT * FROM lead_events WHERE lead_id = ? ORDER BY at DESC, id DESC')
      .all(id)
    return c.json({ lead, events })
  })

  // Create a lead (manual add, or via the AI's create_lead tool upstream).
  app.post('/api/leads', requireAuth, async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const r = insertLead(b, c.get('user').username)
    return r.deduped ? c.json({ deduped: true, id: r.id }) : c.json({ id: r.id }, 201)
  })

  // Import an .xlsx upload. Auto-detects the header row and maps columns, then
  // inserts each row (dedupe applies). multipart/form-data field name: "file".
  app.post('/api/leads/import', requireAuth, async (c) => {
    const form = await c.req.parseBody()
    const file = form['file']
    if (!(file instanceof File)) return c.json({ error: 'Keine Datei hochgeladen.' }, 400)
    let parsed
    try {
      parsed = await parseWorkbookBuffer(Buffer.from(await file.arrayBuffer()))
    } catch {
      return c.json({ error: 'Datei konnte nicht gelesen werden (.xlsx erwartet).' }, 400)
    }
    if (parsed.leads.length === 0) {
      return c.json(
        { error: 'Keine Lead-Zeilen erkannt — Spalten wie Firma/Website/Telefon nötig.' },
        422,
      )
    }
    const actor = c.get('user').username
    let imported = 0
    let deduped = 0
    for (const lead of parsed.leads) {
      if (insertLead(lead, actor).deduped) deduped++
      else imported++
    }
    return c.json({ imported, deduped, total: parsed.leads.length, fields: parsed.mapped })
  })

  app.patch('/api/leads/:id', requireAuth, async (c) => {
    const id = Number(c.req.param('id'))
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const lead = applyLeadUpdate(id, b, c.get('user').username)
      if (!lead) return c.json({ error: 'not found' }, 404)
      return c.json({ lead })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400)
    }
  })

  // Export the pipeline as CSV — honours the same stage/q filters as GET
  // /api/leads, so it exports exactly what the view shows.
  app.get('/api/export/leads.csv', requireAuth, (c) => {
    const stage = c.req.query('stage')
    const q = c.req.query('q')
    const rows = queryLeads(stage, q)
    audit({ actor: c.get('user').username, action: 'export.leads', detail: { stage, q, count: rows.length } })
    return csvResponse(c, leadsCsv(rows), exportFilename('leads'))
  })
}
